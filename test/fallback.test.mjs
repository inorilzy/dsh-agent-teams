import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { formatRoute, normalizeFallbackModels, routeChainOf } from '../src/agents.mjs'
import { agentSpec } from '../src/store.mjs'
import { resolveRouteChain, validateTicketRoutes } from '../src/dashboard.mjs'
import { ModelFallbackController, isModelFailure } from '../src/fallback.mjs'

const definitions = new Map(
  Object.entries({
    '@deepseek-ai/dsh-tools': 'export const defineTool = value => value',
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => ({id: "msg", ...value})',
    '@deepseek-ai/schemastery':
      'const schema = new Proxy({}, {get: () => () => schema}); export default schema',
    './coordinator.mjs':
      'export class Coordinator { constructor(options) { return globalThis[Symbol.for("dag-fallback-test-coordinator")](options) } }',
  }),
)
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (definitions.has(specifier) && context.parentURL?.endsWith('/src/index.mjs')) {
      return {
        url: 'data:text/javascript,' + encodeURIComponent(definitions.get(specifier)),
        shortCircuit: true,
      }
    }
    return next(specifier, context)
  },
})
const { apply } = await import('../src/index.mjs')
hook.deregister()

function mockLlm(catalog = {}) {
  return {
    listProviders: () => Object.keys(catalog).map((id) => ({ id, name: id })),
    listModels: async (providerId) => {
      const entry = catalog[providerId]
      if (entry instanceof Error) throw entry
      return Object.keys(entry ?? {}).map((id) => ({ id, name: id }))
    },
    resolveModelInfo: async (providerId, modelId) => {
      const efforts = catalog[providerId]?.[modelId] ?? []
      return {
        reasoning: {
          efforts: efforts.map((id) => ({ id, name: id })),
          defaultEffort: efforts[0] ?? null,
        },
      }
    },
  }
}

test('normalizeFallbackModels and routeChainOf normalize, deduplicate, and validate routes', () => {
  assert.deepEqual(normalizeFallbackModels(undefined), [])
  assert.deepEqual(
    normalizeFallbackModels([
      { provider: ' p1 ', model: ' m1 ', reasoningEffort: ' high ' },
      { provider: '', model: 'm2', reasoningEffort: '' },
    ]),
    [
      { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
      { model: 'm2' },
    ],
  )
  assert.throws(() => normalizeFallbackModels('bad'), /must be an array/)
  assert.throws(() => normalizeFallbackModels([{ provider: 'p1', model: '' }]), /must set a model/)

  const chain = routeChainOf(
    {
      provider: 'p1',
      model: 'm1',
      reasoningEffort: 'high',
      fallbackModels: [
        { provider: 'p1', model: 'm1', reasoningEffort: 'high' }, // duplicate
        { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, // different effort kept
        { provider: 'p2', model: 'm2' },
      ],
    },
  )
  assert.deepEqual(chain, [
    { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    { provider: 'p1', model: 'm1', reasoningEffort: 'low' },
    { provider: 'p2', model: 'm2' },
  ])

  const inheritedChain = routeChainOf(
    {
      provider: '',
      model: '',
      fallbackModels: [
        { provider: 'parent-p', model: 'parent-m', reasoningEffort: 'medium' },
        { provider: 'p2', model: 'm2' },
      ],
    },
    { provider: 'parent-p', model: 'parent-m', reasoningEffort: 'medium' },
  )
  assert.deepEqual(inheritedChain, [
    { provider: 'parent-p', model: 'parent-m', reasoningEffort: 'medium', inherited: true },
    { provider: 'p2', model: 'm2' },
  ])
  assert.equal(formatRoute({ provider: 'p1', model: 'm1', reasoningEffort: 'high' }), 'p1/m1 · high')
  assert.equal(formatRoute({ model: '' }), 'inherit')
})

test('agentSpec preserves non-empty fallbackModels and omits empty ones', () => {
  const plain = agentSpec({ a: { instructions: 'Hi', provider: 'p1', model: 'm1', fallbackModels: [] } }, 'a')
  assert.equal(Object.hasOwn(plain, 'fallbackModels'), false)

  const withFb = agentSpec(
    {
      a: {
        instructions: 'Hi',
        provider: 'p1',
        model: 'm1',
        fallbackModels: [{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }],
      },
    },
    'a',
  )
  assert.deepEqual(withFb.fallbackModels, [{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }])
  assert.throws(
    () => agentSpec({ a: { instructions: 'Hi', fallbackModels: [{ provider: 'p2', model: '' }] } }, 'a'),
    /must set a model/,
  )
})

test('resolveRouteChain skips startup-unavailable primary when a fallback is available, and throws when all fail', async () => {
  const llm = mockLlm({
    down: new Error('provider unreachable'),
    backup: { 'model-b': ['low', 'high'] },
  })
  const resolved = await resolveRouteChain(
    {
      provider: 'down',
      model: 'model-a',
      fallbackModels: [{ provider: 'backup', model: 'model-b', reasoningEffort: 'high' }],
    },
    () => llm,
    { label: 'architect' },
  )
  assert.deepEqual(resolved.routes, [{ provider: 'backup', model: 'model-b', reasoningEffort: 'high' }])
  assert.equal(resolved.skipped.length, 1)
  assert.equal(resolved.skipped[0].model, 'model-a')

  await validateTicketRoutes(
    [
      {
        id: 'T1',
        agentSpec: {
          provider: 'down',
          model: 'model-a',
          fallbackModels: [{ provider: 'backup', model: 'model-b' }],
        },
      },
    ],
    () => llm,
  )

  await assert.rejects(
    () =>
      resolveRouteChain(
        {
          provider: 'down',
          model: 'model-a',
          fallbackModels: [{ provider: 'missing', model: 'nope' }],
        },
        () => llm,
        { label: 'architect' },
      ),
    /模型目录暂不可用/,
  )
})

test('ModelFallbackController switches across M1 -> M2 -> M3 in order, preserves history vs resends prompt, and ignores non-LLM errors', () => {
  const warnings = []
  const ctrl = new ModelFallbackController({
    createUserMessage: (v) => ({ id: 'u', ...v }),
    isLive: () => true,
    logger: { warn: (m) => warnings.push(m) },
  })

  function fakeChild(id, { initialRoute, committedUserMsg = true } = {}) {
    let cur = initialRoute
    const selected = []
    const followups = []
    return {
      id,
      selected,
      followups,
      session: {
        snapshotEvents: () => (committedUserMsg ? [{ type: 'user/message' }] : []),
      },
      model: {
        current: () => cur,
        select: (next) => {
          cur = next
          selected.push(next)
        },
      },
      followup: (msg) => followups.push(msg),
    }
  }

  // 1) Multi-hop fallback M1 -> M2 -> M3, then stops cleanly when exhausted.
  const switches = []
  ctrl.register('c1', {
    routes: [
      { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
      { provider: 'p2', model: 'm2', reasoningEffort: 'medium' },
      { provider: 'p3', model: 'm3' },
    ],
    initialPromptText: 'Original task prompt',
    label: 'arch',
    onSwitch: (ev) => switches.push(ev),
  })
  const c1 = fakeChild('c1', { initialRoute: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })

  // Non-LLM error must NOT trigger switch.
  ctrl.onError({ agent: c1, turn: 1, step: 1, error: new TypeError('local tool bug') })
  ctrl.onStatus({ agent: c1, status: 'idle' })
  assert.equal(c1.selected.length, 0)

  // Abort error must NOT trigger switch.
  ctrl.onError({ agent: c1, turn: 1, step: 1, error: Object.assign(new Error('cancelled'), { code: 'ABORTED' }) })
  ctrl.onStatus({ agent: c1, status: 'idle' })
  assert.equal(c1.selected.length, 0)

  // LlmError on M1 -> switches to M2 on idle.
  const err1 = Object.assign(new Error('rate limited'), {
    name: 'LlmError',
    failure: { code: 'RATE_LIMIT', message: '429 too many requests' },
  })
  ctrl.onRequestError({ agent: c1, turn: 1, step: 1, provider: 'p1', failure: err1.failure })
  ctrl.onError({ agent: c1, turn: 1, step: 1, error: err1 })
  ctrl.onStatus({ agent: c1, status: 'idle' })
  assert.deepEqual(c1.selected, [{ provider: 'p2', model: 'm2', reasoningEffort: 'medium' }])
  assert.equal(c1.followups.length, 1)
  assert.match(c1.followups[0].content[0].text, /Continue from the conversation history above/)

  // LlmError on M2 -> switches to M3 on idle.
  const err2 = Object.assign(new Error('quota exhausted'), { code: 'QUOTA' })
  ctrl.onError({ agent: c1, turn: 2, step: 1, error: err2 })
  ctrl.onStatus({ agent: c1, status: 'idle' })
  assert.deepEqual(c1.selected[1], { provider: 'p3', model: 'm3' })
  assert.equal(c1.followups.length, 2)

  // LlmError on M3 -> chain exhausted, no further switch.
  ctrl.onError({ agent: c1, turn: 3, step: 1, error: err2 })
  ctrl.onStatus({ agent: c1, status: 'idle' })
  assert.equal(c1.selected.length, 2)
  assert.equal(switches.length, 2)
  assert.equal(warnings.length, 2)

  // 2) Turn 1 Step 1 prepareRequest failure (no user/message committed yet) -> resends full initial prompt.
  ctrl.register('c2', {
    routes: [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ],
    initialPromptText: 'Full original prompt body',
    label: 'prep-fail',
  })
  const c2 = fakeChild('c2', { initialRoute: { provider: 'p1', model: 'm1' }, committedUserMsg: false })
  ctrl.onError({ agent: c2, turn: 1, step: 1, error: Object.assign(new Error('missing key'), { code: 'MISSING_CREDENTIAL' }) })
  ctrl.onStatus({ agent: c2, status: 'idle' })
  assert.equal(c2.selected.length, 1)
  assert.match(c2.followups[0].content[0].text, /Full original prompt body/)

  assert.equal(isModelFailure(Object.assign(new Error('http'), { code: 'HTTP_503' }), null, 1, 1), true)
  assert.equal(isModelFailure(new Error('ordinary error'), null, 1, 1), false)
})

test('apply() wires fallback switching for dag_preset_subagent and DAG worker launch', async () => {
  const tools = new Map()
  const listeners = new Map()
  const started = []
  let capturedLaunch = null
  const controller = {}
  for (const action of ['start', 'attach', 'status', 'pause', 'resume', 'retry', 'cancel', 'cleanup', 'add', 'close', 'updateSettings']) {
    controller[action] = async () => ({ action })
  }
  globalThis[Symbol.for('dag-fallback-test-coordinator')] = (opts) => {
    capturedLaunch = opts.launch
    return controller
  }

  const root = {
    id: 'root',
    options: { provider: 'p-root', model: 'm-root', reasoningEffort: 'medium' },
    session: { header: { id: 'root' } },
    followup() {},
  }
  const roster = new Map([['root', root]])
  const llm = mockLlm({
    p1: { m1: ['low', 'high'] },
    p2: { m2: ['low', 'high'] },
    down: new Error('offline'),
  })

  const agents = {
    architect: {
      name: '架构',
      description: '接口设计',
      instructions: 'Design carefully.',
      provider: 'p1',
      model: 'm1',
      reasoningEffort: 'high',
      fallbackModels: [{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }],
      maxConcurrent: 0,
    },
    resilient: {
      name: '容灾',
      description: '主模型挂了也能启动',
      instructions: 'Fallback at startup.',
      provider: 'down',
      model: 'dead',
      reasoningEffort: '',
      fallbackModels: [{ provider: 'p2', model: 'm2', reasoningEffort: 'high' }],
      maxConcurrent: 0,
    },
  }

  const ctx = {
    tools: { register: (t) => tools.set(t.name, t), guard() {} },
    systemPrompt: { section() {}, getSectionOrder: () => 1 },
    agents: { get: (id) => roster.get(id), list: () => [...roster.values()] },
    workingDirectory: { ensure: async () => '/repo' },
    sessions: { flush: async () => true },
    sessionQuery: { readSession: async () => ({ session: root.session.header, inheritedEventCount: 0, events: [] }) },
    subagents: {
      async startActivation(spec) {
        started.push(spec)
        const childId = spec.childId ?? 'child-' + started.length
        const selected = []
        const followups = []
        let cur = spec.agentOptions ? { ...spec.agentOptions } : { ...root.options }
        const child = {
          id: childId,
          selected,
          followups,
          session: { snapshotEvents: () => [{ type: 'user/message' }] },
          model: {
            current: () => cur,
            select: (next) => {
              cur = next
              selected.push(next)
            },
          },
          followup: (msg) => followups.push(msg),
        }
        roster.set(childId, child)
        return {
          childId,
          name: spec.name ?? 'agent-' + started.length,
          result: new Promise(() => {}),
          dispose: async () => {},
        }
      },
    },
    logger: { warn() {} },
    get: (service) => (service === 'llm' ? llm : undefined),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    effect() {},
  }

  apply(ctx, { agents })

  // Check preset summary in tool description includes fallback chain.
  const tool = tools.get('dag_preset_subagent')
  assert.match(tool.description, /p1\/m1 · high -> p2\/m2 · low/)

  // 1) Runtime fallback on dag_preset_subagent.
  const receipt = await tool.execute(
    { preset: 'architect', description: 'Plan API', prompt: 'Design v2.' },
    { agent: root, signal: new AbortController().signal },
  )
  assert.equal(receipt.model, 'm1')
  assert.equal(receipt.fallbackCount, 1)
  const child = roster.get(receipt.subagentId)
  assert.ok(child)

  for (const fn of listeners.get('agent/request-error') ?? []) {
    await fn({ agent: child, turn: 1, step: 1, provider: 'p1', failure: { code: 'SERVER', message: '502 bad gateway' } }, async () => undefined)
  }
  for (const fn of listeners.get('agent/error') ?? []) {
    fn({ agent: child, turn: 1, step: 1, error: Object.assign(new Error('502 bad gateway'), { name: 'LlmError', failure: { code: 'SERVER', message: '502 bad gateway' } }) })
  }
  for (const fn of listeners.get('agent/status') ?? []) {
    fn({ agent: child, status: 'idle' })
  }
  assert.deepEqual(child.selected, [{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }])
  assert.equal(child.followups.length, 1)

  // 2) Startup fallback when primary provider is down.
  const receipt2 = await tool.execute(
    { preset: 'resilient', description: 'Check startup', prompt: 'Run anyway.' },
    { agent: root, signal: new AbortController().signal },
  )
  assert.equal(receipt2.provider, 'p2')
  assert.equal(receipt2.model, 'm2')
  assert.equal(receipt2.reasoningEffort, 'high')
  assert.equal(receipt2.fallbackFrom, 'down/dead')

  // 3) One-off override does NOT attach preset fallback chain.
  const receipt3 = await tool.execute(
    { preset: 'architect', description: 'Override', prompt: 'Only p2.', provider: 'p2', model: 'm2' },
    { agent: root, signal: new AbortController().signal },
  )
  assert.equal(receipt3.overridden, true)
  assert.equal(receipt3.fallbackCount, undefined)
  const child3 = roster.get(receipt3.subagentId)
  for (const fn of listeners.get('agent/error') ?? []) {
    fn({ agent: child3, turn: 1, step: 1, error: Object.assign(new Error('boom'), { name: 'LlmError', failure: { code: 'SERVER', message: 'boom' } }) })
  }
  for (const fn of listeners.get('agent/status') ?? []) {
    fn({ agent: child3, status: 'idle' })
  }
  assert.equal(child3.selected.length, 0)

  // 4) DAG worker launch also supports runtime fallback.
  const workerId = 'worker-child-1'
  await capturedLaunch({
    parentId: 'root',
    childId: workerId,
    cwd: '/tmp/worktree',
    prompt: 'Implement ticket A',
    agentOptions: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    fallbackModels: [{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }],
    signal: new AbortController().signal,
    runId: 'run-1',
    ticketId: 'T1',
    attempt: 1,
  })
  const workerChild = roster.get(workerId)
  for (const fn of listeners.get('agent/error') ?? []) {
    fn({ agent: workerChild, turn: 1, step: 1, error: Object.assign(new Error('timeout'), { code: 'TIMEOUT' }) })
  }
  for (const fn of listeners.get('agent/status') ?? []) {
    fn({ agent: workerChild, status: 'idle' })
  }
  assert.deepEqual(workerChild.selected, [{ provider: 'p2', model: 'm2', reasoningEffort: 'low' }])
  assert.equal(workerChild.followups.length, 1)
})
