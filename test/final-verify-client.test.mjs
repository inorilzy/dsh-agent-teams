import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

// Like the board tests, render through the DSH slots with seeded React state.
function loadHost(seeds, clock = { now: 100_000 }) {
  let definition
  const intervals = new Map()
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (d) => (definition = d) } },
    Date: class extends Date {
      static now() { return clock.now }
    },
    setInterval: (fire, ms) => {
      const id = Symbol()
      intervals.set(id, { fire, ms })
      return id
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: () => 1,
    clearTimeout: () => {},
    AbortController,
    URLSearchParams,
    fetch: () => new Promise(() => {}),
  })
  const queue = [...seeds]
  const cleanups = []
  const updates = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (init) => [queue.length ? queue.shift() : typeof init === 'function' ? init() : init, (update) => updates.push(update)],
    useRef: (current) => ({ current }),
    useEffect: (effect) => {
      const cleanup = effect()
      if (cleanup) cleanups.push(cleanup)
    },
  }
  const registered = new Map()
  const slots = {
    inject: (_, fn) => fn(),
    register: (meta, component) => registered.set(meta.name, component),
  }
  definition.factory(() => react).apply({
    effect: (fn) => fn(),
    slots,
    inject: (names, fn) => {
      if (names.includes('sidebarRight')) {
        fn({ effect: (f) => f(), slots, sidebarRightTabs: { register: () => {} } })
      }
    },
  })
  return {
    intervals,
    updates,
    cleanup: () => cleanups.forEach((fn) => fn()),
    renderSlot: (name, props) => render(registered.get(name)(props)),
  }
}

function render(node) {
  if (!node || typeof node !== 'object') return node == null || typeof node === 'boolean' ? null : String(node)
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, children: node.children.map(render).filter((child) => child !== null) }
}

const text = (node) => typeof node === 'string' ? node : node.children.map(text).join('')
function find(node, match) {
  if (typeof node === 'string') return undefined
  if (match(node)) return node
  for (const child of node.children) {
    const found = find(child, match)
    if (found) return found
  }
}
const byAttr = (node, attr) => find(node, (n) => n.props[attr] !== undefined)
const overview = (root) => find(root, (n) => n.props['aria-label'] === '运行概况')

function runWith(finalPhase, { statuses = ['INTEGRATED', 'INTEGRATED'], ...extra } = {}) {
  const counts = {}
  const tickets = statuses.map((status, i) => {
    counts[status] = (counts[status] ?? 0) + 1
    return { id: 'T' + (i + 1), status, dependsOn: [], attempt: 1 }
  })
  return { key: 'e'.repeat(64), runId: 'demo-01', mode: 'active', complete: false, total: tickets.length, counts, tickets, finalPhase, ...extra }
}

function boardFor(run, clock, compact = false) {
  const host = loadHost([{ runs: [run], selected: run }, run.key], clock)
  const root = host.renderSlot('sidebar.right.pane.tab', compact ? { sessionId: 's1' } : {})
  return { host, root, summary: overview(root) }
}

function cardState(run) {
  const host = loadHost([run, run, ''])
  return byAttr(host.renderSlot('conversation.chat.node', { sessionId: 's1', node: { data: run } }), 'data-dag-run-state')
}

test('the progress badge and conversation card name the current final phase', () => {
  for (const [stage, label, tone] of [['final', '最终验收中', 'work'], ['bisect', '二分定位中', 'warn']]) {
    const run = runWith({ stage })
    const badge = find(boardFor(run).summary, (n) => n.props.className?.startsWith('dtd-badge '))
    assert.equal(text(badge), label)
    assert.equal(badge.props.className, 'dtd-badge ' + tone)
    const state = cardState(run)
    assert.equal(state.props['data-dag-run-state'], label)
    assert.equal(text(state), label + ' · 2 张工单')
  }
})

test('unreadable, completed and attention states take precedence over the final phase label', () => {
  const phase = { stage: 'bisect' }
  const cases = [
    [runWith(phase, { statuses: ['NEEDS_ATTENTION'] }), '运行中 · 有待处理工单', 'blocked'],
    [runWith(phase, { complete: true }), '已完成', 'neutral'],
    [runWith(phase, { complete: true, statuses: ['NEEDS_ATTENTION'] }), '已完成', 'blocked'],
    [runWith(phase, { mode: 'paused' }), '已暂停', 'neutral'],
    [runWith(null), '运行中', 'neutral'],
  ]
  for (const [run, label, tone] of cases) {
    const badge = find(boardFor(run).summary, (n) => n.props.className?.startsWith('dtd-badge '))
    assert.equal(text(badge), label)
    assert.equal(badge.props.className, 'dtd-badge ' + tone)
    assert.equal(cardState(run).props['data-dag-run-state'], label)
  }
  const unreadable = runWith(phase, { available: false, complete: true, statuses: ['NEEDS_ATTENTION'] })
  assert.equal(cardState(unreadable).props['data-dag-run-state'], '记录不可读取')
  assert.equal(boardFor(unreadable).summary, undefined)
})

test('legacy final phase snapshots keep exact copy and show a decorative spinner', () => {
  const cases = [
    [{ stage: 'final', checkId: 'slow', index: 2, total: 3 }, '最终验收（全量） · slow 2/3'],
    [{ stage: 'bisect', checkId: 'slow', index: 1, total: 1, step: 2 }, '最终验收失败，二分定位出错工单 · 第 2 步 · slow 1/1'],
    [{ stage: 'final', startedAt: '0', checkTimeoutMs: -1000, failed: [] }, '最终验收（全量）'],
    [{ stage: 'final', startedAt: NaN, checkTimeoutMs: 120_000, failed: 'slow' }, '最终验收（全量）'],
  ]
  for (const [phase, label] of cases) {
    const { host, summary } = boardFor(runWith(phase), undefined, true)
    const banner = byAttr(summary, 'data-dag-final')
    assert.equal(banner.props['data-dag-final'], phase.stage)
    assert.equal(banner.props.role, 'status')
    assert.equal(text(banner), label)
    const icon = find(banner, (n) => n.type === 'svg')
    assert.equal(icon.props.className, 'dtd-spin')
    assert.equal(icon.props['aria-hidden'], true)
    assert.equal(host.intervals.size, 0)
  }
  const { summary } = boardFor(runWith({ stage: 'bisect', failed: ['slow'] }))
  assert.match(text(byAttr(summary, 'data-dag-final')), /已失败：slow$/)
})

test('the check timer ticks locally from the server reading and shows the timeout and failed checks', () => {
  const clock = { now: 100_000 }
  const run = runWith({ stage: 'bisect', startedAt: 958_000, checkTimeoutMs: 120_000, failed: ['slow', 'lint'] }, {
    now: 1_000_000, receivedAt: 100_000,
  })
  const { host, summary } = boardFor(run, clock, true)
  const banner = byAttr(summary, 'data-dag-final')
  const timer = find(banner, (n) => n.props.role === 'timer')
  assert.equal(text(timer), '已耗时 0:42 / 上限 2:00')
  assert.equal(timer.props['aria-live'], 'off')
  assert.match(text(banner), /已失败：slow、lint$/)
  const [interval] = host.intervals.values()
  assert.equal(host.intervals.size, 1)
  assert.equal(interval.ms, 1000)
  clock.now += 1000
  interval.fire()
  assert.equal(host.updates.length, 1)
  assert.equal(host.updates[0](0), 1)
  const next = byAttr(boardFor(run, clock, true).summary, 'data-dag-final')
  assert.equal(text(find(next, (n) => n.props.role === 'timer')), '已耗时 0:43 / 上限 2:00')
  host.cleanup()
  assert.equal(host.intervals.size, 0)
})

test('the timer falls back to the local clock and clamps clock skew without placeholder times', () => {
  const elapsed = (phase, extra, now) => {
    const { summary } = boardFor(runWith({ stage: 'final', ...phase }, extra), { now })
    return text(find(summary, (n) => n.props.role === 'timer'))
  }
  assert.equal(elapsed({ startedAt: 0 }, {}, 61_000), '已耗时 1:01')
  assert.equal(elapsed({ startedAt: 96_000, checkTimeoutMs: Infinity }, { receivedAt: 100_000 }, 101_000), '已耗时 0:05')
  assert.equal(elapsed({ startedAt: 100_500 }, { receivedAt: 100_000 }, 101_000), '已耗时 0:01')
  assert.equal(elapsed({ startedAt: 1_000_001 }, { now: 1_000_000, receivedAt: 100_000 }, 99_000), '已耗时 0:00')
})

test('only a nonempty fully integrated run with a pending final phase gets the progress treatment', () => {
  const phase = { stage: 'final' }
  const cases = [
    [runWith(phase), true, [['done', 2]]],
    [runWith({ stage: 'bisect' }), true, [['done', 2]]],
    [runWith(phase, { complete: true }), false, [['done', 2]]],
    [runWith(null), false, [['done', 2]]],
    [runWith(phase, { statuses: [] }), false, []],
    [runWith(phase, { statuses: ['RUNNING', 'PENDING', 'INTEGRATED', 'NEEDS_ATTENTION', 'INTEGRATED'] }), false,
      [['done', 2], ['work', 1], ['wait', 1], ['blocked', 1]]],
  ]
  for (const [run, awaiting, segments] of cases) {
    const { summary } = boardFor(run)
    const hint = byAttr(summary, 'data-dag-awaiting-final')
    assert.equal(hint && hint.props['data-dag-awaiting-final'], awaiting ? '' : undefined)
    if (awaiting) assert.equal(text(hint), '工单已全部集成，等待最终验收通过后完成')
    const bar = byAttr(summary, 'data-dag-bar')
    assert.equal(bar.props['data-dag-final-pending'], awaiting ? 'true' : undefined)
    assert.deepEqual(bar.children.map(({ props }) => [props['data-dag-segment'], props.style.flexGrow]), segments)
  }
})

test('the stage banner has separate work and warning accents and pending motion can be disabled', () => {
  const { root } = boardFor(runWith({ stage: 'final' }))
  const css = text(find(root, (n) => n.type === 'style'))
  assert.match(css, /\.dtd-run-card-head\s*\{[^}]*flex-wrap:wrap/)
  assert.match(css, /\.dtd-badge\.warn\s*\{[^}]*var\(--dtd-wait\)/)
  assert.match(css, /\.dtd-final-banner\s*\{[^}]*--dtd-final-tone:var\(--dtd-work\)[^}]*border-inline-start:3px solid var\(--dtd-final-tone\)/)
  assert.match(css, /\.dtd-final-banner\[data-dag-final=bisect\]\s*\{[^}]*--dtd-final-tone:var\(--dtd-wait\)/)
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\s*\{[^}]*\.dtd-bar\[data-dag-final-pending=true\][^}]*animation:none/)
})
