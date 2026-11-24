import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import { RunStore } from '../src/store.mjs'

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim()
const check = (script, ...args) => [[process.execPath, '-e', script, ...args]]
const pass = check('process.exit(0)')
const limit = (ms) => ms * (process.platform === 'win32' ? 3 : 1)
const sleep = promisify(setTimeout)
async function until(read, label) {
  const deadline = Date.now() + limit(15000)
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await sleep(20)
  }
  throw Error('Timeout: ' + label)
}

async function launch(job) {
  return {
    dispose: async () => {},
    result: (async () => {
      const file = job.ticketId + '.txt'
      await writeFile(join(job.cwd, file), job.ticketId + '\n')
      await git(job.cwd, 'add', '--', file)
      const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
      await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers.join('\n'))
      return { ok: true }
    })(),
  }
}

async function fixture(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dag-final-'))
  const cwd = join(root, 'project')
  const coordinators = []
  t.after(async () => {
    for (const co of coordinators) await co.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  const q = { cwd, parentId: 'captain', runId: 'final' }
  const notices = []
  let ledgerFile
  const coordinator = (checks) => {
    const co = new Coordinator({
      checks: { fast: pass, ...checks },
      checkMeta: { fast: { fast: true } },
      checkTimeoutMs: limit(15000),
      integrationMode: 'end',
      launch,
      rememberRun: (file) => { ledgerFile = file },
      notify: async (notice) => {
        notices.push(notice)
        return true
      },
      ...settings,
    })
    coordinators.push(co)
    return co
  }
  const ticket = (id, verify, extra = {}) => ({ id, title: id, verify, ...extra })
  const start = (co, tickets) => co.start({ ...q, manifest: { spec_id: 'final', tickets } })
  const gate = async (name) => {
    const file = join(root, name)
    await writeFile(file, '')
    return file
  }
  const events = () => {
    const db = new RunStore(ledgerFile)
    try {
      return db.events()
    } finally {
      db.close()
    }
  }
  return { q, coordinator, ticket, start, gate, notices, events }
}

// A check can stay in flight while the coordinator's status is sampled.
const blocking = (gate) => check(
  "const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync(process.argv[1]))clearInterval(t)},20)", gate,
)

async function phaseOf(co, q, stage, checkId) {
  return until(async () => {
    const { finalPhase, diagnostic } = await co.status(q)
    if (diagnostic) throw Error(diagnostic)
    return finalPhase?.stage === stage && finalPhase.checkId === checkId && finalPhase
  }, stage + ' check ' + checkId)
}

function assertPhase(phase, expected, earliest) {
  const { startedAt, ...fields } = phase
  assert.ok(Number.isInteger(startedAt) && startedAt >= earliest && startedAt <= Date.now())
  assert.deepEqual(fields, { ...expected, checkTimeoutMs: limit(15000) })
}

test('final phase reports failures accumulated before the current check finishes', { timeout: limit(30000) }, async (t) => {
  const { q, coordinator, ticket, start, gate } = await fixture(t)
  const first = await gate('first')
  const second = await gate('second')
  const co = coordinator({ lint: [...blocking(first), ...check('process.exit(1)')], suite: blocking(second) })
  const earliest = Date.now()
  await start(co, [ticket('A', ['lint', 'suite', 'fast'])])

  const lint = await phaseOf(co, q, 'final', 'lint')
  assertPhase(lint, { stage: 'final', checkId: 'lint', index: 1, total: 3, failed: [] }, earliest)
  await rm(first)

  const suite = await phaseOf(co, q, 'final', 'suite')
  assertPhase(suite, { stage: 'final', checkId: 'suite', index: 2, total: 3, failed: ['lint'] }, lint.startedAt + 1)
  assert.deepEqual(lint.failed, [], 'a previous snapshot is unchanged')
})

const failAfter = (gate) => check(
  "const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync(process.argv[1])){clearInterval(t);process.exitCode=1}},20)", gate,
)

async function failingRun(t, settings) {
  const fixtureRun = await fixture(t, { maxFinalRepairs: 0, ...settings })
  const { gate, coordinator, start, ticket } = fixtureRun
  const earlier = await gate('earlier')
  const latest = await gate('latest')
  const checks = {
    lint: check(
      "const fs=require('fs');if(fs.existsSync('B.txt'))process.exit(1);const t=setInterval(()=>{if(!fs.existsSync(process.argv[1]))clearInterval(t)},20)", earlier,
    ),
    suite: failAfter(latest),
  }
  const tickets = [ticket('A', ['lint', 'fast']), ticket('B', ['suite'], { depends_on: ['A'] })]
  const co = coordinator(checks)
  await start(co, tickets)
  return { ...fixtureRun, co, checks, earlier, latest }
}

test('bisect phase keeps every final failure when a probe reruns only some of them', { timeout: limit(30000) }, async (t) => {
  const { co, q, latest } = await failingRun(t)
  const final = await phaseOf(co, q, 'final', 'suite')
  await rm(latest)

  const phase = await phaseOf(co, q, 'bisect', 'lint')
  assertPhase(phase, { stage: 'bisect', checkId: 'lint', index: 1, total: 1, step: 1, failed: ['lint', 'suite'] }, final.startedAt + 1)
})

const noticeDelay = 100
const runningEvent = 'final_verify_running'
const bisectingEvent = 'final_verify_bisecting'

async function passRun(t, settings) {
  const f = await fixture(t, { finalVerifyNoticeDelayMs: noticeDelay, ...settings })
  const gate = await f.gate('passing')
  const checks = { suite: blocking(gate) }
  const co = f.coordinator(checks)
  await f.start(co, [f.ticket('A', ['fast', 'suite'])])
  await phaseOf(co, f.q, 'final', 'suite')
  return { ...f, co, checks, gate }
}

for (const integrationMode of ['end', 'worker-end']) {
  test(integrationMode + ': a long final check tells the captain which check is running', { timeout: limit(30000) }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { co, q, notices, events } = await passRun(t, {
      integrationMode,
      selectChecksByFiles: true,
      checkMeta: { fast: { files: ['**'], fast: true }, suite: { files: ['unmodified/**'] } },
    })
    const { verifiedSha } = await co.status(q)
    t.mock.timers.tick(noticeDelay - 1)
    assert.ok(!events().some((e) => e.type === runningEvent))
    t.mock.timers.tick(1)
    await co.status(q)

    const [event] = events().filter((e) => e.type === runningEvent)
    assert.deepEqual(event?.details, {
      tipSha: verifiedSha, checks: ['fast', 'suite'], checkId: 'suite', index: 2, total: 2, failed: [],
    })
    const notice = await until(() => notices.find((n) => n.eventId === event.id), 'running notice')
    assert.equal(notice.parentId, q.parentId)
    assert.match(notice.text, /All tickets are integrated.*final full verification.*suite \(2\/2\)/)
  })
}

test('the captain receives the failed check IDs while bisection is still running', { timeout: limit(30000) }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { co, q, earlier, latest, notices, events } = await failingRun(t, { finalVerifyNoticeDelayMs: noticeDelay })
  await phaseOf(co, q, 'final', 'suite')
  const { verifiedSha } = await co.status(q)
  await rm(latest)
  await phaseOf(co, q, 'bisect', 'lint')
  t.mock.timers.tick(noticeDelay)
  await co.status(q)

  const [event] = events().filter((e) => e.type === bisectingEvent)
  assert.deepEqual(event?.details, { tipSha: verifiedSha, failed: ['lint', 'suite'] })
  assert.ok(!events().some((e) => e.type === 'final_verify_failed' || e.type === runningEvent))
  const notice = await until(() => notices.find((n) => n.eventId === event.id), 'bisection notice')
  assert.match(notice.text, /lint, suite.*bisecting.*ticket/)

  await rm(earlier)
  await until(async () => (await co.status(q)).mode === 'paused', 'bisection result')
  assert.deepEqual(events().filter((e) => [bisectingEvent, 'final_verify_failed'].includes(e.type)).map((e) => e.type), [
    bisectingEvent, 'final_verify_failed',
  ])
})

function assertNoProgress(events, notices) {
  assert.ok(!events().some((e) => e.type === runningEvent || e.type === bisectingEvent))
  assert.ok(!notices.some((n) => /Running final full verification|Automatically bisecting/.test(n.text)))
}

test('final verification that passes within the delay sends no progress notice', { timeout: limit(30000) }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { co, q, events, notices, gate } = await passRun(t)
  await rm(gate)
  const complete = await until(async () => {
    const snapshot = await co.status(q)
    return snapshot.complete && !snapshot.finalPhase && snapshot
  }, 'final verification complete')
  assert.equal(complete.counts.INTEGRATED, 1)
  t.mock.timers.tick(noticeDelay)
  assertNoProgress(events, notices)
})

test('restarting final verification at the same tip does not resend its running notice', { timeout: limit(30000) }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { co, q, coordinator, checks, notices, events } = await passRun(t)
  t.mock.timers.tick(noticeDelay)
  const event = await until(() => events().find((e) => e.type === runningEvent), 'first running event')
  await until(() => notices.some((n) => n.eventId === event.id), 'first running notice')
  await co.close()

  const resumed = coordinator(checks)
  assert.deepEqual(await resumed.attach(q), { attached: [q.runId], failures: [] })
  await phaseOf(resumed, q, 'final', 'suite')
  t.mock.timers.tick(noticeDelay * 2)
  await resumed.status(q)
  await resumed.close()

  const starts = events().filter((e) => e.type === 'final_verify_started')
  assert.deepEqual(starts.map((e) => e.details.tipSha), [event.details.tipSha, event.details.tipSha])
  assert.deepEqual(events().filter((e) => e.type === runningEvent), [event])
  assert.equal(notices.filter((n) => /Running final full verification/.test(n.text)).length, 1)
})

test('restarting bisection at the same tip does not resend its notice', { timeout: limit(30000) }, async (t) => {
  const { co, q, coordinator, checks, latest, notices, events } = await failingRun(t, { finalVerifyNoticeDelayMs: 0 })
  await phaseOf(co, q, 'final', 'suite')
  await rm(latest)
  await phaseOf(co, q, 'bisect', 'lint')
  const [event] = events().filter((e) => e.type === bisectingEvent)
  await until(() => notices.some((n) => n.eventId === event.id), 'first bisection notice')
  await co.close()

  const resumed = coordinator(checks)
  assert.deepEqual(await resumed.attach(q), { attached: [q.runId], failures: [] })
  await phaseOf(resumed, q, 'bisect', 'lint')
  await resumed.close()

  const starts = events().filter((e) => e.type === 'final_verify_started')
  assert.deepEqual(starts.map((e) => e.details.tipSha), [event.details.tipSha, event.details.tipSha])
  assert.deepEqual(events().filter((e) => e.type === bisectingEvent), [event])
  assert.equal(notices.filter((n) => /Automatically bisecting/.test(n.text)).length, 1)
})

test('refreshing settings preserves the notice delay unless a finite replacement is supplied', async () => {
  const co = new Coordinator({ launch })
  try {
    const settings = { checks: {}, maxWorkers: 16, checkTimeoutMs: 15000 }
    assert.equal(co.finalVerifyNoticeDelayMs, 30000)
    co.updateSettings({ ...settings, finalVerifyNoticeDelayMs: 42 })
    co.updateSettings(settings)
    assert.throws(() => co.updateSettings({ ...settings, finalVerifyNoticeDelayMs: Infinity }), /Invalid final verification notice delay/)
    assert.equal(co.finalVerifyNoticeDelayMs, 42)
  } finally {
    await co.close()
  }
})

for (const delay of [0, -1]) {
  test('notice delay ' + delay + ' disables the running progress notice', { timeout: limit(30000) }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { co, q, events, notices } = await passRun(t, { finalVerifyNoticeDelayMs: delay })
    t.mock.timers.tick(30001)
    await co.status(q)
    assertNoProgress(events, notices)
  })
}

for (const operation of ['cancel', 'close']) {
  test(operation + ' during final verification prevents a delayed notice', { timeout: limit(30000) }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const schedule = t.mock.method(globalThis, 'setTimeout')
    const clear = t.mock.method(globalThis, 'clearTimeout')
    const { co, q, events, notices } = await passRun(t)
    const timers = schedule.mock.calls.filter(({ arguments: args }) => args[1] === noticeDelay)
    assert.equal(timers.length, 1)
    await co[operation](q)
    assert.ok(clear.mock.calls.some(({ arguments: args }) => args[0] === timers[0].result))
    t.mock.timers.tick(noticeDelay)
    await co.close()

    assert.ok(events().some((e) => e.type === 'check_finished' && e.details.stage === 'final' && e.details.aborted))
    assertNoProgress(events, notices)
  })
}

for (const [integrationMode, stage] of [['worker', 'worker'], ['train', 'train']]) {
  test(stage + ' checks retain their existing live phase shape', { timeout: limit(30000) }, async (t) => {
    const { co, q } = await passRunForTicket(t, integrationMode)
    const phase = await until(async () => {
      const { tickets: [ticket], diagnostic } = await co.status(q)
      if (diagnostic) throw Error(diagnostic)
      return ticket.livePhase?.checkId === 'suite' && ticket.livePhase
    }, stage + ' check')
    assert.deepEqual(phase, { stage, checkId: 'suite', index: 1, total: 1 })
  })
}

async function passRunForTicket(t, integrationMode) {
  const { q, coordinator, ticket, start, gate } = await fixture(t, { integrationMode })
  const co = coordinator({ suite: blocking(await gate('ticket')) })
  await start(co, [ticket('A', ['suite'])])
  return { co, q }
}
