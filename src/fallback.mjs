import { formatRoute, routeKey } from './agents.mjs'

const LLM_ERROR_CODES = new Set([
  'ACCOUNT_QUOTA',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'AUTH',
  'CLIENT_UPGRADE_REQUIRED',
  'CONTENT_REFUSED',
  'CONTEXT_WINDOW_EXCEEDED',
  'DISCOVERY_FAILED',
  'EMPTY_RESPONSE',
  'INVALID_CONFIG',
  'INVALID_CREDENTIAL',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
  'INVALID_PREPARED_CALL',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'MALFORMED_RESPONSE',
  'MISSING_CREDENTIAL',
  'MODEL_UNSUPPORTED',
  'NO_ADAPTER',
  'PI_AI_ERROR',
  'QUOTA',
  'RATE_LIMIT',
  'REGISTRATION_DISPOSED',
  'REQUEST_EXTENSION',
  'REQUEST_HEADERS',
  'SERVER',
  'STREAM_CLOSED',
  'TIMEOUT',
  'TRANSPORT',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT',
])

function isAbortError(error) {
  if (!error) return false
  return (
    error.code === 'ABORTED' ||
    error.name === 'AbortError' ||
    error.failure?.code === 'ABORTED'
  )
}

export function isModelFailure(error, lastRequestError, turn, step) {
  if (isAbortError(error)) return false
  if (
    lastRequestError &&
    lastRequestError.turn === turn &&
    lastRequestError.step === step &&
    lastRequestError.failure?.code !== 'ABORTED'
  ) {
    return true
  }
  if (!error || typeof error !== 'object') return false
  if (error.name === 'LlmError') return true
  if (error.failure && typeof error.failure === 'object' && typeof error.failure.code === 'string') {
    return error.failure.code !== 'ABORTED'
  }
  const code = typeof error.code === 'string' ? error.code : ''
  return LLM_ERROR_CODES.has(code) || /^HTTP_\d+$/.test(code)
}

function summarizeError(error, lastRequestError) {
  const code = error?.failure?.code ?? lastRequestError?.failure?.code ?? error?.code
  const msg = error?.failure?.message ?? lastRequestError?.failure?.message ?? error?.message ?? String(error ?? 'unknown error')
  const compact = String(msg).replace(/\s+/g, ' ').trim().slice(0, 220)
  return code && !compact.includes(code) ? `${code}: ${compact}` : compact
}

function hasCommittedUserMessage(agent) {
  try {
    if (typeof agent?.session?.snapshotEvents !== 'function') return true
    const events = agent.session.snapshotEvents(0)
    return Array.isArray(events) && events.some((e) => e?.type === 'user/message')
  } catch {
    return true
  }
}

/**
 * In-session ordered model fallback controller for subagents (both DAG workers
 * and dag_preset_subagent children).
 *
 * When a tracked child suffers a terminal model/provider failure on a step:
 *  1. `onRequestError` records the failing step after downstream retry policies
 *     (such as dsh-llm-retry) decline to retry further.
 *  2. `onError` selects the next unused fallback route in the child's chain and
 *     arms `pendingSwitch`.
 *  3. `onStatus` (fired synchronously by dsh-agent-loop when the failed turn
 *     transitions to `idle`, BEFORE `whenIdle()` resolves and before
 *     SubagentManager can settle/close the child) calls `agent.model.select(...)`
 *     and `agent.followup(...)`, seamlessly continuing the same child session on
 *     the next model with full conversation history intact.
 */
export class ModelFallbackController {
  constructor({ createUserMessage, isLive, logger } = {}) {
    this.createUserMessage = createUserMessage
    this.isLive = isLive ?? (() => true)
    this.logger = logger
    this.tracked = new Map()
  }

  register(childId, { routes, initialPromptText = '', label = '', onSwitch } = {}) {
    if (!childId || !Array.isArray(routes) || routes.length < 2) return false
    this.tracked.set(childId, {
      routes: routes.map((r) => ({ ...r })),
      index: 0,
      initialPromptText: String(initialPromptText ?? ''),
      label: String(label ?? ''),
      onSwitch,
      lastRequestError: null,
      pendingSwitch: null,
      switches: [],
    })
    return true
  }

  rekey(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return
    const state = this.tracked.get(oldId)
    if (!state) return
    this.tracked.delete(oldId)
    this.tracked.set(newId, state)
  }

  unregister(childId) {
    this.tracked.delete(childId)
  }

  get(childId) {
    return this.tracked.get(childId)
  }

  onRequestError({ agent, turn, step, provider, failure }) {
    const state = agent?.id ? this.tracked.get(agent.id) : undefined
    if (!state) return
    state.lastRequestError = { turn, step, provider, failure }
  }

  onError({ agent, turn, step, error }) {
    const state = agent?.id ? this.tracked.get(agent.id) : undefined
    if (!state || !this.isLive(agent)) return
    if (!isModelFailure(error, state.lastRequestError, turn, step)) return

    const currentSelection = agent.model?.current?.()
    const currentKey = currentSelection ? routeKey(currentSelection) : routeKey(state.routes[state.index])
    let nextIndex = -1
    for (let i = state.index + 1; i < state.routes.length; i++) {
      const candidate = state.routes[i]
      if (!candidate?.provider || !candidate?.model) continue
      if (routeKey(candidate) === currentKey) continue
      nextIndex = i
      break
    }
    if (nextIndex < 0) return

    const from = currentSelection ?? state.routes[state.index]
    const to = state.routes[nextIndex]
    state.pendingSwitch = {
      nextIndex,
      from,
      to,
      reason: summarizeError(error, state.lastRequestError),
    }
  }

  onStatus({ agent, status }) {
    if (status !== 'idle') return
    const state = agent?.id ? this.tracked.get(agent.id) : undefined
    if (!state?.pendingSwitch) return

    const sw = state.pendingSwitch
    state.pendingSwitch = null
    state.lastRequestError = null
    if (!this.isLive(agent)) return
    if (typeof agent?.model?.select !== 'function' || typeof agent?.followup !== 'function') return

    const selection = {
      provider: sw.to.provider,
      model: sw.to.model,
      ...(sw.to.reasoningEffort && { reasoningEffort: sw.to.reasoningEffort }),
    }
    const fromLabel = formatRoute(sw.from)
    const toLabel = formatRoute(sw.to)
    const hasPrompt = hasCommittedUserMessage(agent)
    const resumeText =
      !hasPrompt && state.initialPromptText
        ? `[Automatic model fallback: ${fromLabel} failed (${sw.reason}). Switched to ${toLabel}.]\n\n${state.initialPromptText}`
        : `[Automatic model fallback: ${fromLabel} failed (${sw.reason}). Switched to ${toLabel}. Continue from the conversation history above and complete the pending task.]`

    state.index = sw.nextIndex
    state.switches.push({ from: fromLabel, to: toLabel, reason: sw.reason, at: Date.now() })
    try {
      agent.model.select(selection)
      agent.followup(
        this.createUserMessage({
          content: [{ type: 'text', text: resumeText }],
          source: { kind: 'user' },
        }),
      )
      this.logger?.warn?.(
        `dsh-agent-teams: model fallback for ${state.label || agent.id}: ${fromLabel} -> ${toLabel} (${sw.reason})`,
      )
      state.onSwitch?.({ childId: agent.id, from: sw.from, to: sw.to, index: sw.nextIndex, reason: sw.reason })
    } catch (err) {
      this.logger?.warn?.(
        `dsh-agent-teams: failed to switch fallback model for ${state.label || agent.id}: ${String(err).slice(0, 300)}`,
      )
    }
  }
}
