import test from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { importTickets, mergeImportedManifest } from '../src/tracker.mjs'
import { normalizeManifest } from '../src/store.mjs'
import { Coordinator } from '../src/coordinator.mjs'
import { builtinAgents } from '../src/agents.mjs'

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, env })).stdout.trim()
}
async function until(check, label, limit = 15000) {
  const deadline = Date.now() + limit
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(25)
  }
  throw new Error('Timed out waiting for ' + label)
}

test('dag_import omits spec.body when tickets exist and mergeImportedManifest inherits full bodies verbatim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-merge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.scratch/demo/issues'), { recursive: true })
  await writeFile(join(root, '.scratch/demo/spec.md'), '# Demo Spec\n\n' + 'Very long spec text.\n'.repeat(200))
  await writeFile(
    join(root, '.scratch/demo/issues/01-core.md'),
    '# 01: Core Engine\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\nDetailed core requirements.\n\n## Acceptance criteria\n\n- [ ] Core passes unit tests\n',
  )
  await writeFile(
    join(root, '.scratch/demo/issues/02-verify.md'),
    '# 02: Acceptance\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n\nRun real browser and screenshot.\n\n## Acceptance criteria\n\n- [ ] Capture 3 screenshots\n- [ ] Inspect with read_image\n',
  )

  const imported = await importTickets({ cwd: root, spec: '.scratch/demo' })
  assert.equal(imported.dependencyMode, 'declared')
  assert.equal(imported.spec.body, undefined)
  assert.equal(imported.spec.id, 'demo')

  const merged = mergeImportedManifest(imported, {
    import_from: '.scratch/demo',
    max_workers: 4,
    checks: { unit: [['node', '--test']] },
    tickets: [
      { id: 'T01', agent: 'architect', verify: ['unit'], files: ['src/core.js'] },
      { id: 'T02', agent: 'verifier', verify: [], files: ['docs/acceptance/demo.md'], prompt_append: 'Extra note.' },
    ],
  })

  assert.equal(merged.import_from, undefined)
  assert.equal(merged.spec_id, 'demo')
  assert.equal(merged.max_workers, 4)
  assert.equal(merged.tickets.length, 2)
  assert.equal(merged.tickets[0].title, 'Core Engine')
  assert.match(merged.tickets[0].prompt, /Detailed core requirements\./)
  assert.deepEqual(merged.tickets[0].acceptance, ['Core passes unit tests'])
  assert.deepEqual(merged.tickets[0].depends_on, [])
  assert.equal(merged.tickets[0].agent, 'architect')
  assert.deepEqual(merged.tickets[0].files, ['src/core.js'])
  assert.equal(merged.tickets[0].source.kind, 'local')

  assert.equal(merged.tickets[1].title, 'Acceptance')
  assert.match(merged.tickets[1].prompt, /Run real browser and screenshot\.[\s\S]*Extra note\./)
  assert.deepEqual(merged.tickets[1].acceptance, ['Capture 3 screenshots', 'Inspect with read_image'])
  assert.deepEqual(merged.tickets[1].depends_on, ['T01'])
  assert.equal(merged.tickets[1].agent, 'verifier')

  // Must refuse altering declared dependencies or naming unknown ticket IDs.
  assert.throws(
    () => mergeImportedManifest(imported, { tickets: [{ id: 'T02', depends_on: [] }] }),
    /Cannot override declared depends_on/,
  )
  assert.throws(
    () => mergeImportedManifest(imported, { tickets: [{ id: 'T99', agent: 'implementer' }] }),
    /unknown imported ticket id/,
  )

  const normalized = normalizeManifest(merged, {}, builtinAgents)
  assert.equal(normalized.specId, 'demo')
  assert.deepEqual(normalized.tickets[1].dependsOn, ['T01'])
})

test('normalizeManifest reports a clear error when spec_id is missing', () => {
  assert.throws(
    () => normalizeManifest({ tickets: [{ id: 't1', title: 'A', prompt: 'Do A' }] }),
    /manifest\.spec_id is required/,
  )
})

test('dag_run resolves both import_from and local manifest file paths via host tool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-host-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.scratch/app/issues'), { recursive: true })
  await writeFile(join(root, '.scratch/app/spec.md'), '# App Spec\n')
  await writeFile(
    join(root, '.scratch/app/issues/01-build.md'),
    '# 01: Build\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\nFull build prompt.\n\n- [ ] Builds cleanly\n',
  )
  await writeFile(
    join(root, '.scratch/app/manifest.json'),
    JSON.stringify({
      import_from: '.scratch/app',
      tickets: [{ id: 'T01', agent: 'implementer', files: ['src/app.js'] }],
    }),
  )

  const definitions = new Map(
    Object.entries({
      '@deepseek-ai/dsh-tools': 'export const defineTool = value => value',
      '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => ({id: "msg", ...value})',
      '@deepseek-ai/schemastery':
        'const schema = new Proxy({}, {get: () => () => schema}); export default schema',
      './coordinator.mjs':
        'export class Coordinator { constructor(options) { return globalThis[Symbol.for("dag-test-coord-import")](options) } }',
    }),
  )
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (definitions.has(specifier) && context.parentURL?.includes('/src/index.mjs')) {
        return {
          url: 'data:text/javascript,' + encodeURIComponent(definitions.get(specifier)),
          shortCircuit: true,
        }
      }
      return next(specifier, context)
    },
  })
  const { apply } = await import('../src/index.mjs?import-test=' + Date.now())
  hook.deregister()

  const started = []
  globalThis[Symbol.for('dag-test-coord-import')] = () => ({
    start: async (req) => {
      started.push(req)
      return { runId: 'r-test', mode: 'staged' }
    },
    close: async () => {},
  })

  const tools = new Map()
  const rootAgent = { id: 'root', session: { header: { id: 'root' } } }
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool), guard() {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    agents: { get: (id) => (id === 'root' ? rootAgent : undefined), list: () => [rootAgent] },
    workingDirectory: { ensure: async () => root },
    sessionQuery: { readSession: async () => ({ session: rootAgent.session.header, inheritedEventCount: 0, events: [] }) },
    sessionPersistence: { listSessions: async () => [] },
    sessions: { flush: async () => true },
    subagents: {},
    logger: { warn() {} },
    on() {},
    effect() {},
    get() {},
  }
  apply(ctx, {})

  const runTool = tools.get('dag_run')
  await runTool.execute({ manifest: '.scratch/app/manifest.json' }, { agent: rootAgent, signal: new AbortController().signal })
  assert.equal(started.length, 1)
  assert.equal(started[0].manifest.spec_id, 'app')
  assert.equal(started[0].manifest.tickets[0].id, 'T01')
  assert.match(started[0].manifest.tickets[0].prompt, /Full build prompt\./)
  assert.equal(started[0].manifest.tickets[0].agent, 'implementer')
  assert.deepEqual(started[0].manifest.tickets[0].files, ['src/app.js'])
})

test('coordinator injects main-repo acceptance artifact dir into verifier prompt and names integration branch on completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-verifier-prompt-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))

  const realCwd = await realpath(cwd)
  const prompts = new Map()
  const notices = []
  const coord = new Coordinator({
    checks: {},
    agents: builtinAgents,
    requireApproval: false,
    autoCleanup: true,
    launch: async (job) => {
      prompts.set(job.ticketId, job.prompt)
      return {
        childId: job.childId,
        dispose: async () => {},
        result: (async () => {
          await writeFile(join(job.cwd, job.ticketId + '.txt'), 'ok')
          await git(job.cwd, 'add', '--', job.ticketId + '.txt')
          const trailers = [
            'DAG-Run: ' + job.runId,
            'DAG-Ticket: ' + job.ticketId,
            'DAG-Attempt: ' + job.attempt,
            'DAG-Complete: yes',
          ].join('\n')
          await git(job.cwd, 'commit', '-qm', 'Finish ' + job.ticketId, '-m', trailers)
          return { ok: true, detail: 'done' }
        })(),
      }
    },
    notify: async (n) => {
      notices.push(n.text)
      return true
    },
    sessionDone: async () => true,
  })
  t.after(() => coord.close())

  const started = await coord.start({
    cwd,
    parentId: 'cap',
    runId: 'verify-run',
    manifest: {
      spec_id: 'my-app',
      tickets: [
        { id: 'T01', title: 'Impl', prompt: 'Write feature', agent: 'implementer', verify: [] },
        { id: 'T02', title: 'Accept', prompt: 'Verify live UI', depends_on: ['T01'], agent: 'verifier', verify: [] },
      ],
    },
  })
  assert.equal(started.runId, 'verify-run')

  try {
    await until(
      () => notices.find((text) => /All tickets integrated/.test(text)),
      'completion notification',
      8000,
    )
  } catch (err) {
    const st = await coord.status({ cwd, parentId: 'cap', runId: 'verify-run' })
    throw new Error(err.message + '\nnotices=' + JSON.stringify(notices) + '\nstatus=' + JSON.stringify(st))
  }

  const implPrompt = prompts.get('T01')
  const verifierPrompt = prompts.get('T02')
  assert.match(implPrompt, new RegExp('Main repository root: ' + realCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(implPrompt, /Non-committed acceptance artifacts/)

  const expectedArtifactDir = join(realCwd, '.scratch', 'my-app', 'acceptance')
  assert.match(verifierPrompt, new RegExp('Main repository root: ' + realCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(
    verifierPrompt,
    new RegExp('Non-committed acceptance artifacts[\\s\\S]*' + expectedArtifactDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  )

  const completion = notices.find((text) => /All tickets integrated/.test(text))
  assert.match(completion, /Integration branch: integration\/verify-run/)
  assert.match(completion, /git merge integration\/verify-run/)
})
