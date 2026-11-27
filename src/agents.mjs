// Default `agents` config. A profile that saves its own presets replaces this
// whole set. Empty provider/model/reasoningEffort keep the host's default route.
// src/client.js keeps a copy for the settings form; test/client-board.test.mjs
// checks that the two stay equal.
//
// Presets differ by how much judgement a ticket needs, not by file type; rules
// every worker follows live in the coordinator's worker prompt. Each description
// names the suggested model tier (high, normal, cheap) for the settings page.
export const builtinAgents = {
  architect: {
    name: '架构',
    description: '架构（建议高智力模型）：先定下游共用的接口、骨架与共享注册点',
    instructions:
      'Lay the foundation other tickets build on: interfaces, module skeletons, shared registries, data shapes and the contracts between them. Write stubs and the smallest code that lets downstream tickets compile and test against the contract, not the features themselves. Record each decision and the alternatives you rejected in a short design note in the repository, so the downstream workers follow it instead of guessing. Where a trade-off cannot be settled from the code, choose, and say why in the note.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  debugger: {
    name: '修复',
    description: '修复（建议高智力模型）：复现、定位根因，最小修复并补回归测试',
    instructions:
      'Fix a defect or a failing check. Reproduce it first; if you cannot, find the conditions that trigger it before changing code. Read the whole error output, then write three to five ranked candidate causes with the evidence for each, and test them one at a time. Fix the root cause with the smallest change; do not refactor, rename or add features. Add a regression test that fails before the fix and passes after it; if no correct seam allows one, say so in the report. Tag temporary debug output with one unique marker and remove it before committing. Put the confirmed cause in the commit message. After three disproved hypotheses, stop and report what you ruled out.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  implementer: {
    name: '实现者',
    description: '实现者（建议普通模型）：按工单完成代码与配套测试，也负责给已有代码补测试',
    instructions:
      'Implement the ticket end to end: production code plus the tests that prove it. When the ticket asks only for tests of existing code, write those tests and leave production code unchanged; report any defect they expose instead of fixing it. Each test checks one behavior and its name says what is expected.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  frontend: {
    name: '前端',
    description: '前端（建议普通模型）：界面、渲染与对应的界面测试',
    instructions:
      'Implement the ticket in the user interface: components, rendering, copy and the UI tests that prove it. Detect the framework and component patterns from the project files first and write code that looks like the existing panels, styles and wording. Keep the result accessible (labels, keyboard focus, status not told by colour alone) and usable at narrow and wide sizes. Keep server and scheduler code unchanged unless the ticket requires it.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  scribe: {
    name: '文书',
    description: '文书（建议便宜模型）：文档、注释、配置，以及照上游产出做的机械登记',
    instructions:
      'Do mechanical work that needs no new logic: documentation, README files, code comments, configuration, renames, and registering entries that upstream tickets already produced (for example adding each new module to a shared registry, index or route table). Copy names and values from the upstream code exactly. Do not change program behavior beyond the registration the ticket names; if the work turns out to need a design decision, stop and describe it.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  verifier: {
    name: '验收员',
    description: '验收员（建议普通模型）：运行真实宿主、浏览器和 SDK 验收，如实记录结果',
    instructions:
      'Run the acceptance the ticket names against real hosts, browsers or SDKs. Verify the current host OS first; for other target OS platforms not present here, run platform-independent checks, mark platform-specific items NOT RUN (deferred: <OS>), and list follow-up verification steps. For UI or interactive changes, capture screenshots of the live state, inspect every screenshot directly with read_image to confirm layout, alignment, copy and data, and record the screenshot paths. Mark each acceptance item VERIFIED, PARTIAL, MISSING or NOT RUN with the exact command and its output; run every command yourself instead of trusting an earlier report. A missing environment is NOT RUN, never VERIFIED; wording such as should, probably or seems is not evidence. You may fix test fixtures and harnesses, not production code; report defects instead of fixing them. Commit the acceptance record.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 1,
  },
  explorer: {
    name: '探索',
    description: '探索（建议便宜模型）：只读搜索本地代码库与外部资料，返回路径与原文摘录',
    instructions:
      'Explore codebases and external documentation strictly read-only: locate files, trace call paths, summarize relevant symbols and configs, or execute web/documentation lookups (such as multi-search). Return exact file paths, line ranges, URLs, and verbatim excerpts with any gaps noted. Never modify, create, or delete repository files.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  auditor: {
    name: '审计',
    description: '审计（建议高智力模型）：只读审查安全、权限、并发、数据一致性与凭据合规风险',
    instructions:
      'Audit the target code, diff, or design strictly read-only for security, authorization, sandbox/trust boundaries, secret exposure, injection, race conditions, failure recovery, and data-integrity risks. Report findings ordered by severity with exact file paths, line numbers, concrete exploit or failure paths, and minimal remediation advice. Do not modify code.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
  reviewer: {
    name: '审查',
    description: '审查（建议高智力模型）：只读审查代码正确性、边界条件、规范与需求一致度',
    instructions:
      'Review the target changes or modules strictly read-only for correctness, edge cases, contract adherence, maintainability, and test coverage. Prioritize real bugs, regressions, and spec mismatches over style nits, citing exact file paths and line numbers for each finding. Do not modify code.',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxConcurrent: 0,
  },
}

/** The preset an automatically appended fix-<ticket>-<n> ticket uses when the profile has it. */
export const repairAgent = 'debugger'

/**
 * Normalize an ordered list of fallback model routes. Each entry must name a
 * model; empty provider/reasoningEffort fields are omitted.
 */
export function normalizeFallbackModels(raw, owner = 'agent preset') {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new TypeError(owner + '.fallbackModels must be an array')
  const out = []
  for (const [i, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`${owner}.fallbackModels[${i}] must be an object`)
    }
    const route = {}
    for (const field of ['provider', 'model', 'reasoningEffort']) {
      const value = item[field] ?? ''
      if (typeof value !== 'string') throw new TypeError(`${owner}.fallbackModels[${i}].${field} must be a string`)
      if (value.trim()) route[field] = value.trim()
    }
    if (!route.model) throw new TypeError(`${owner}.fallbackModels[${i}] must set a model`)
    out.push(route)
  }
  return out
}

export function routeKey(route) {
  return JSON.stringify([route?.provider ?? '', route?.model ?? '', route?.reasoningEffort ?? ''])
}

export function formatRoute(route) {
  const model = String(route?.model ?? '').trim()
  if (!model) return 'inherit'
  const provider = String(route?.provider ?? '').trim()
  const effort = String(route?.reasoningEffort ?? '').trim()
  return [provider ? provider + '/' + model : model, effort].filter(Boolean).join(' · ')
}

/**
 * Build the ordered, deduplicated list of routes for a preset/ticket spec.
 * Index 0 is the primary route (or inherited host/parent route when the primary
 * model is empty), followed by each configured fallback model.
 */
export function routeChainOf(spec, inheritedPrimary = null) {
  const primaryProvider = String(spec?.provider ?? '').trim()
  const primaryModel = String(spec?.model ?? '').trim()
  const primaryEffort = String(spec?.reasoningEffort ?? '').trim()
  const primary = primaryModel
    ? {
        ...(primaryProvider && { provider: primaryProvider }),
        model: primaryModel,
        ...(primaryEffort && { reasoningEffort: primaryEffort }),
      }
    : inheritedPrimary?.model
      ? {
          ...(inheritedPrimary.provider && { provider: String(inheritedPrimary.provider).trim() }),
          model: String(inheritedPrimary.model).trim(),
          ...(inheritedPrimary.reasoningEffort && {
            reasoningEffort: String(inheritedPrimary.reasoningEffort).trim(),
          }),
          inherited: true,
        }
      : { provider: '', model: '', reasoningEffort: '', inherited: true }

  const seen = new Set()
  const chain = []
  const push = (entry) => {
    const key = routeKey(entry)
    if (seen.has(key)) return
    seen.add(key)
    chain.push(entry)
  }
  push(primary)
  for (const fb of Array.isArray(spec?.fallbackModels) ? spec.fallbackModels : []) {
    const model = String(fb?.model ?? '').trim()
    if (!model) continue
    const provider = String(fb?.provider ?? '').trim()
    const reasoningEffort = String(fb?.reasoningEffort ?? '').trim()
    push({
      ...(provider && { provider }),
      model,
      ...(reasoningEffort && { reasoningEffort }),
    })
  }
  return chain
}
