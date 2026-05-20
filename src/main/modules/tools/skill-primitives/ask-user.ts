/**
 * Handler for `skill_ask_user`. Suspends the current turn on a question and
 * resumes when the renderer posts a response. Phase 1 PR2 design:
 *
 *   1. Always create an ephemeral execution record (not stored in SQLite).
 *      The "active execution has a blocker" variant from the original plan
 *      would require coupling with ExecutionCoordinator's need_input path; a
 *      dedicated ephemeral lane is simpler and keeps the DB surface clean.
 *   2. Register a resolver + 24h timeout in
 *      `EphemeralExecutionStore` (shared singleton).
 *   3. Notify the renderer via an injected `emitAskUserQuestion` callback so
 *      the UI can render the SkillAskUserPrompt capsule. The IPC surface
 *      lives in `ipc-handler.ts`; this handler stays transport-agnostic so
 *      unit tests can swap in a no-op emitter.
 *   4. `submitAskUserResponse(executionId, value)` in ipc-handler calls
 *      `store.resolve(id, value)`, which unblocks the awaiting Promise.
 *   5. `AbortSignal` aborts the pending Promise and `store.reject`s the
 *      record with `AbortError`-shaped rejection.
 */

import { ToolDomainError } from '../tool-errors'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tools-runtime/tool-error-metrics'
import {
  EphemeralExecutionStore,
  generateEphemeralAskUserId,
  getEphemeralExecutionStore,
} from './ephemeral-execution-store'

export interface AskUserArgs {
  question: string
  options?: string[]
  placeholder?: string
}

export interface AskUserQuestionEvent {
  executionId: string
  sessionId: string | null
  skillId: string | null
  question: string
  options: string[] | null
  placeholder: string | null
  askedAt: number
}

export type EmitAskUserQuestion = (event: AskUserQuestionEvent) => void

export interface AskUserHandlerDeps {
  sessionId?: string
  skillId?: string
  signal?: AbortSignal
  /** Notifies the renderer a question is pending. No-op in unit tests. */
  emitAskUserQuestion?: EmitAskUserQuestion
  /** Defaults to the shared singleton. Injectable for isolated unit tests. */
  store?: EphemeralExecutionStore
  /** Defaults to 24h; dependency-injected for tests to force an early timeout. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24h — matches the B Phase 1 plan
const NOOP_EMIT: EmitAskUserQuestion = () => {}

export async function executeAskUser(
  args: AskUserArgs,
  deps: AskUserHandlerDeps,
): Promise<ToolExecutionOutput> {
  const store = deps.store || getEphemeralExecutionStore()
  const emit = deps.emitAskUserQuestion || NOOP_EMIT
  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0
    ? deps.timeoutMs
    : DEFAULT_TIMEOUT_MS

  const executionId = generateEphemeralAskUserId()
  const askedAt = Date.now()
  const sessionId = deps.sessionId || null
  const skillId = deps.skillId || null
  const options = Array.isArray(args.options) && args.options.length > 0 ? args.options : null
  const placeholder = typeof args.placeholder === 'string' && args.placeholder.length > 0
    ? args.placeholder
    : null

  const answer = await new Promise<string>((resolvePromise, rejectPromise) => {
    const timeoutHandle = setTimeout(() => {
      if (!store.has(executionId)) return
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_ask_user',
        reason: 'timeout',
        timeoutMs,
        sessionId,
        skillId,
      })
      store.reject(
        executionId,
        new ToolDomainError(
          'timeout',
          `skill_ask_user timed out after ${timeoutMs}ms with no user response`,
          { executionId, timeoutMs },
        ),
      )
    }, timeoutMs)

    store.register({
      executionId,
      sessionId,
      skillId,
      question: args.question,
      options,
      placeholder,
      askedAt,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeoutHandle,
    })

    const onAbort = () => {
      if (!store.has(executionId)) return
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_ask_user',
        reason: 'aborted',
        sessionId,
        skillId,
      })
      store.reject(executionId, new ToolDomainError('aborted', 'skill_ask_user was aborted.'))
    }
    if (deps.signal) {
      if (deps.signal.aborted) onAbort()
      else deps.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      emit({
        executionId,
        sessionId,
        skillId,
        question: args.question,
        options,
        placeholder,
        askedAt,
      })
    } catch (emitErr) {
      // Emitter failure is non-fatal — the record still lives in the store
      // and a renderer reconnect can poll `store.list()`. We log but don't
      // reject; otherwise a transient IPC glitch would drop questions.
      const message = emitErr instanceof Error ? emitErr.message : String(emitErr)
      console.error('[skill_ask_user] emit failed:', message)
    }
  })

  logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveUsed, {
    primitive: 'skill_ask_user',
    sessionId,
    skillId,
    durationMs: Date.now() - askedAt,
  })

  return createToolExecutionOutput(answer, {
    shape: 'json',
    data: {
      executionId,
      answer,
      askedAt,
      answeredAt: Date.now(),
    },
  })
}
