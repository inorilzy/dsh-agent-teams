import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const definitions = new Map(
  Object.entries({
    '@deepseek-ai/dsh-tools': 'export const defineTool = value => value',
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => ({id: "msg", ...value})',
    '@deepseek-ai/schemastery':
      'const schema = new Proxy({}, {get: () => () => schema}); export default schema',
    './coordinator.mjs':
      'export class Coordinator { constructor(options) { return globalThis[Symbol.for("dag-preset-test-coordinator")](options) } }',
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

function harness({ agents, llm, parentOptions } = {}) {
  const tools = new Map()
  const sections = []
  const started = []
  let cleanup
  let nextSeq = 1

  const controller = {}
  for (const action of ['start', 'attach', 'status', 'pause', 'resume', 'retry', 'cancel', 'cleanup', 'add', 'close', 'updateSettings']) {
    controller[action] = async () => ({ action })
  }
  globalThis[Symbol.for('dag-preset-test-coordinator')] = () => controller

  const root = {
    id: 'root',
    options: parentOptions ?? { provider: 'parent-prov', model: 'parent-model', reasoningEffort: 'medium' },
    session: { header: { id: 'root' } },
    followup() {},
  }
  const roster = new Map([['root', root]])
  const ctx = {
    tools: {
      register: (tool) => tools.set(tool.name, tool),
      guard() {},
    },
    systemPrompt: {
      section: (section) => sections.push(section),
      getSectionOrder: () => 1,
    },
    agents: { get: (id) => roster.get(id), list: () => [...roster.values()] },
    workingDirectory: { ensure: async () => '/repo' },
    sessions: { flush: async () => true },
    sessionQuery: { readSession: async () => ({ session: root.session.header, inheritedEventCount: 0, events: [] }) },
    subagents: {
      async startActivation(spec) {
        started.push(spec)
        const seq = nextSeq++
        return {
          childId: 'child-' + seq,
          name: spec.name ?? 'agent-' + seq,
          result: new Promise(() => {}),
          dispose: async () => {},
        }
      },
    },
    logger: { warn() {} },
    get: (service) => (service === 'llm' ? llm : undefined),
    on() {},
    effect: (start) => {
      cleanup = start()
    },
  }

  apply(ctx, agents === undefined ? {} : { agents })
  const invoke = (args, opts = {}) =>
    tools.get('dag_preset_subagent').execute(args, {
      agent: Object.hasOwn(opts, 'agent') ? opts.agent : root,
      signal: Object.hasOwn(opts, 'signal') ? opts.signal : new AbortController().signal,
    })

  return {
    ctx,
    root,
    tools,
    sections,
    started,
    invoke,
    close: () => cleanup(),
  }
}

test('dag_preset_subagent injects preset instructions, passes flat 0.2.2 startActivation spec, and returns effective route', async () => {
  const llm = mockLlm({
    acme: {
      'reasoner-1': ['low', 'medium', 'high'],
    },
  })
  const agents = {
    architect: {
      name: '架构',
      description: '接口与骨架设计',
      instructions: 'Design clean interfaces first.',
      provider: 'acme',
      model: 'reasoner-1',
      reasoningEffort: 'high',
      maxConcurrent: 0,
    },
  }
  const h = harness({ agents, llm })
  const tool = h.tools.get('dag_preset_subagent')
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(tool.parameters), [
    'preset',
    'description',
    'prompt',
    'cwd',
    'name',
    'provider',
    'model',
    'reasoning_effort',
  ])
  assert.match(tool.description, /architect \(架构\) \[acme\/reasoner-1 · high\]: 接口与骨架设计/)

  const signal = new AbortController().signal
  const receipt = await h.invoke(
    {
      preset: 'architect',
      description: 'Design module boundaries',
      prompt: 'Outline the new storage API.',
      cwd: 'packages/core',
      name: 'arch-1',
    },
    { signal },
  )

  assert.equal(h.started.length, 1)
  const spec = h.started[0]
  assert.equal(Object.hasOwn(spec, 'request'), false)
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.maxDepth, 1)
  assert.equal(spec.parent, h.root)
  assert.equal(spec.cwd, 'packages/core')
  assert.equal(spec.name, 'arch-1')
  assert.equal(spec.signal, signal)
  assert.equal(spec.label, 'architect [reasoner-1 · high] · Design module boundaries')
  assert.equal(spec.label.startsWith('dsh-agent-teams/'), false)
  assert.deepEqual(spec.prompt, [
    { type: 'text', text: 'Role (architect): Design clean interfaces first.\n\nTask:\nOutline the new storage API.' },
  ])
  assert.deepEqual(spec.agentOptions, {
    provider: 'acme',
    model: 'reasoner-1',
    reasoningEffort: 'high',
  })
  assert.deepEqual(receipt, {
    kind: 'activation',
    preset: 'architect',
    name: 'arch-1',
    subagentId: 'child-1',
    provider: 'acme',
    model: 'reasoner-1',
    reasoningEffort: 'high',
    inherited: false,
  })
  assert.equal(Object.hasOwn(receipt, 'overridden'), false)
  await h.close()
})

test('preset without model omits agentOptions, passes prompt verbatim when instructions are empty, and reports inherited route', async () => {
  const agents = {
    helper: {
      name: '助手',
      description: '通用子任务',
      instructions: '',
      provider: '',
      model: '',
      reasoningEffort: '',
      maxConcurrent: 0,
    },
  }
  const h = harness({
    agents,
    parentOptions: { provider: 'host', model: 'main-1', reasoningEffort: 'medium' },
  })
  assert.match(h.tools.get('dag_preset_subagent').description, /helper \(助手\) \[inherit\]: 通用子任务/)

  const receipt = await h.invoke({
    preset: 'helper',
    description: 'Inspect build script',
    prompt: 'Check how package scripts run.',
  })

  assert.equal(h.started.length, 1)
  const spec = h.started[0]
  assert.equal(Object.hasOwn(spec, 'request'), false)
  assert.equal(Object.hasOwn(spec, 'agentOptions'), false)
  assert.equal(Object.hasOwn(spec, 'name'), false)
  assert.equal(Object.hasOwn(spec, 'cwd'), false)
  assert.equal(spec.label, 'helper [main-1 · medium] · Inspect build script')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'Check how package scripts run.' }])
  assert.deepEqual(receipt, {
    kind: 'activation',
    preset: 'helper',
    name: 'agent-1',
    subagentId: 'child-1',
    provider: 'host',
    model: 'main-1',
    reasoningEffort: 'medium',
    inherited: true,
  })
  await h.close()
})

test('one-off route override replaces preset route without inheriting stale effort, and rejects incomplete override fields', async () => {
  const llm = mockLlm({
    acme: { 'reasoner-1': ['high'] },
    beta: { 'fast-2': ['low', 'medium'] },
  })
  const agents = {
    debugger: {
      name: '修复',
      description: '定位并修复缺陷',
      instructions: 'Find the root cause.',
      provider: 'acme',
      model: 'reasoner-1',
      reasoningEffort: 'high',
      maxConcurrent: 0,
    },
    plain: {
      name: '普通',
      description: '无绑定模型',
      instructions: '',
      provider: '',
      model: '',
      reasoningEffort: '',
      maxConcurrent: 0,
    },
  }
  const h = harness({ agents, llm })

  // Override provider + model without reasoning_effort: must NOT carry over preset's 'high' effort.
  const r1 = await h.invoke({
    preset: 'debugger',
    description: 'Check flaky test',
    prompt: 'Reproduce the timeout.',
    provider: 'beta',
    model: 'fast-2',
  })
  assert.deepEqual(h.started[0].agentOptions, { provider: 'beta', model: 'fast-2' })
  assert.equal(h.started[0].label, 'debugger [fast-2] · Check flaky test')
  assert.deepEqual(r1, {
    kind: 'activation',
    preset: 'debugger',
    name: 'agent-1',
    subagentId: 'child-1',
    provider: 'beta',
    model: 'fast-2',
    inherited: false,
    overridden: true,
  })

  // Override provider + model + reasoning_effort on an unpinned preset.
  const r2 = await h.invoke({
    preset: 'plain',
    description: 'Quick scan',
    prompt: 'Summarize recent commits.',
    provider: 'beta',
    model: 'fast-2',
    reasoning_effort: 'low',
  })
  assert.deepEqual(h.started[1].agentOptions, { provider: 'beta', model: 'fast-2', reasoningEffort: 'low' })
  assert.equal(h.started[1].label, 'plain [fast-2 · low] · Quick scan')
  assert.deepEqual(r2, {
    kind: 'activation',
    preset: 'plain',
    name: 'agent-2',
    subagentId: 'child-2',
    provider: 'beta',
    model: 'fast-2',
    reasoningEffort: 'low',
    inherited: false,
    overridden: true,
  })

  // Incomplete or empty override parameters are rejected before starting any child.
  const before = h.started.length
  await assert.rejects(
    h.invoke({ preset: 'debugger', description: 'd', prompt: 'p', provider: 'beta' }),
    /provider.*model.*together/i,
  )
  await assert.rejects(
    h.invoke({ preset: 'debugger', description: 'd', prompt: 'p', model: 'fast-2' }),
    /provider.*model.*together/i,
  )
  await assert.rejects(
    h.invoke({ preset: 'debugger', description: 'd', prompt: 'p', reasoning_effort: 'low' }),
    /reasoning_effort.*requires both/i,
  )
  await assert.rejects(
    h.invoke({ preset: 'debugger', description: 'd', prompt: 'p', provider: '  ', model: 'fast-2' }),
    /non-empty/,
  )
  await assert.rejects(
    h.invoke({ preset: 'debugger', description: 'd', prompt: 'p', provider: 'beta', model: 'fast-2', reasoning_effort: '' }),
    /non-empty/,
  )
  assert.equal(h.started.length, before)
  await h.close()
})

test('unknown presets, invalid routes, unsupported efforts, and unavailable catalogs fail loudly without silent fallback', async () => {
  const llm = mockLlm({
    acme: {
      'good-1': ['low', 'high'],
    },
  })
  const agents = {
    architect: {
      name: '架构',
      description: '架构设计',
      instructions: '',
      provider: 'acme',
      model: 'missing-model',
      reasoningEffort: '',
      maxConcurrent: 0,
    },
    badEffort: {
      name: '错档位',
      description: '',
      instructions: '',
      provider: 'acme',
      model: 'good-1',
      reasoningEffort: 'ultra',
      maxConcurrent: 0,
    },
    noModel: {
      name: '缺模型',
      description: '',
      instructions: '',
      provider: 'acme',
      model: '',
      reasoningEffort: '',
      maxConcurrent: 0,
    },
    ok: {
      name: '正常',
      description: '',
      instructions: '',
      provider: 'acme',
      model: 'good-1',
      reasoningEffort: 'high',
      maxConcurrent: 0,
    },
  }
  const h = harness({ agents, llm })

  // Unknown preset lists available IDs and hints when display name matches.
  await assert.rejects(
    h.invoke({ preset: 'unknown', description: 'd', prompt: 'p' }),
    /Unknown agent preset "unknown".*architect/,
  )
  await assert.rejects(
    h.invoke({ preset: '架构', description: 'd', prompt: 'p' }),
    /Did you mean preset ID "architect"\?/,
  )

  // Invalid model / unsupported effort / missing model in preset.
  await assert.rejects(
    h.invoke({ preset: 'architect', description: 'd', prompt: 'p' }),
    /Unknown model: acme\/missing-model/,
  )
  await assert.rejects(
    h.invoke({ preset: 'badEffort', description: 'd', prompt: 'p' }),
    /does not support reasoning effort ultra/,
  )
  await assert.rejects(
    h.invoke({ preset: 'noModel', description: 'd', prompt: 'p' }),
    /provider or reasoning effort without a model/,
  )

  // Invalid override model / provider / effort also fails loudly.
  await assert.rejects(
    h.invoke({ preset: 'ok', description: 'd', prompt: 'p', provider: 'nope', model: 'good-1' }),
    /Unknown provider: nope/,
  )
  await assert.rejects(
    h.invoke({ preset: 'ok', description: 'd', prompt: 'p', provider: 'acme', model: 'good-1', reasoning_effort: 'max' }),
    /does not support reasoning effort max/,
  )
  assert.equal(h.started.length, 0)
  await h.close()

  // Unavailable LLM catalog rejects instead of falling back to parent model.
  const noCatalog = harness({
    agents: { ok: agents.ok },
    llm: undefined,
  })
  await assert.rejects(
    noCatalog.invoke({ preset: 'ok', description: 'd', prompt: 'p' }),
    /模型目录暂不可用/,
  )
  assert.equal(noCatalog.started.length, 0)
  await noCatalog.close()
})

test('input validation, shutdown guard, abort signal, and dynamic preset visibility in captainSection', async () => {
  let liveAgents = {
    architect: {
      name: '架构',
      description: '先定接口',
      instructions: '',
      provider: '',
      model: '',
      reasoningEffort: '',
      maxConcurrent: 0,
    },
  }
  const volatileAgents = { get: () => liveAgents }
  const llm = mockLlm({ acme: { 'fast-1': ['low'] } })
  const h = harness({ agents: volatileAgents, llm })

  const section = h.sections.find((s) => s.name === 'tool:dsh-agent-teams')
  assert.match(section.text(), /prefer dag_preset_subagent over the generic subagent tool/)
  assert.match(section.text(), /subagent_fork/)
  assert.match(section.text(), /- architect \(架构\) \[inherit\]: 先定接口/)

  // Volatile update adds a new preset with a bound model; both system prompt and tool pick it up immediately.
  liveAgents = {
    ...liveAgents,
    auditor: {
      name: '审计',
      description: '安全审查',
      instructions: 'Audit security.',
      provider: 'acme',
      model: 'fast-1',
      reasoningEffort: 'low',
      maxConcurrent: 0,
    },
  }
  assert.match(section.text(), /- auditor \(审计\) \[acme\/fast-1 · low\]: 安全审查/)
  const receipt = await h.invoke({
    preset: 'auditor',
    description: 'Audit auth flow',
    prompt: 'Check session cookies.',
  })
  assert.equal(receipt.preset, 'auditor')
  assert.equal(receipt.model, 'fast-1')

  // Bad name / empty fields / missing agent / aborted signal.
  for (const badName of ['lead', 'Upper', '1abc', 'has space', 'a'.repeat(33)]) {
    await assert.rejects(
      h.invoke({ preset: 'architect', description: 'd', prompt: 'p', name: badName }),
      /Subagent name/,
      badName,
    )
  }
  await assert.rejects(h.invoke({ preset: 'architect', description: ' ', prompt: 'p' }), /Description/)
  await assert.rejects(h.invoke({ preset: 'architect', description: 'd', prompt: '  ' }), /Prompt/)
  await assert.rejects(h.invoke({ preset: 'architect', description: 'd', prompt: 'p', cwd: '' }), /cwd/)
  await assert.rejects(h.invoke({ preset: 'architect', description: 'd', prompt: 'p' }, { agent: undefined }), /live calling agent/)

  const aborted = new AbortController()
  aborted.abort(new Error('cancelled'))
  await assert.rejects(
    h.invoke({ preset: 'architect', description: 'd', prompt: 'p' }, { signal: aborted.signal }),
    /cancelled/,
  )

  // Closing guard.
  await h.close()
  await assert.rejects(
    h.invoke({ preset: 'architect', description: 'd', prompt: 'p' }),
    /Agent Teams plugin is stopping/,
  )
})
