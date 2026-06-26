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
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  skillId: string | null
  question: string
  options: string[] | null
  placeholder: string | null
  askedAt: number
}

export type EmitAskUserQuestion = (event: AskUserQuestionEvent) => void

export interface AskUserHandlerDeps {
  sessionId?: string
  scopeId?: string
  agent?: string | null
  requestId?: string | null
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

function normalizedOptionGroupLabel(option: string): string | null {
  const match = String(option || '').trim().match(/^(?:[0-9①②③④⑤⑥⑦⑧⑨⑩]+[.)、]\s*)?([^:：?？]{2,18})[:：]\s*\S/)
  if (!match) return null
  return match[1].replace(/\s+/g, '')
}

function looksLikeQuestionOption(option: string): boolean {
  const text = String(option || '').trim()
  if (!text) return false
  if (/[?？]\s*$/.test(text)) return true
  return /^(?:是否|要不要|需要|可否|能否|哪种|哪个|什么|请确认|请补充)/.test(text)
}

function detectMultiQuestionOptions(options: string[] | null): { reason: string; labels?: string[] } | null {
  if (!options || options.length < 2) return null
  const questionLikeCount = options.filter(looksLikeQuestionOption).length
  if (questionLikeCount >= 2) return { reason: 'question_like_options' }

  const labels = Array.from(new Set(options.map(normalizedOptionGroupLabel).filter((label): label is string => Boolean(label))))
  if (labels.length >= 2) return { reason: 'mixed_option_groups', labels }
  return null
}

function looksLikePostCompletionFollowup(args: AskUserArgs): boolean {
  const question = String(args.question || '').trim()
  const options = Array.isArray(args.options) ? args.options.map((option) => String(option || '').trim()) : []
  const text = [question, ...options].join(' ')
  const completionSignal = /(?:方案|文档|文件|任务|产物).{0,12}(?:已完成|完成|已保存|已输出|已生成|已经写好|已写入)|(?:已完成|已保存|已输出|已生成).{0,12}(?:方案|文档|文件|任务|产物)/.test(text)
  if (!completionSignal) return false
  const followupSignal = /(?:需要|还要|是否|要不要|接下来|下一步|做什么|调整|修改|继续|生成效果图|完成)/.test(text)
  if (!followupSignal) return false
  const optionFollowup = options.some((option) => /^(?:完成|调整|修改|继续|生成效果图|导出|补充)$/.test(option))
  return optionFollowup || /(?:需要(?:我)?做什么|还需要(?:我)?(?:调整|修改|继续|生成)|是否(?:需要|要)|要不要)/.test(question)
}

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
  const scopeId = deps.scopeId || sessionId
  const agent = deps.agent || null
  const requestId = deps.requestId || null
  const skillId = deps.skillId || null
  const options = Array.isArray(args.options) && args.options.length > 0 ? args.options : null
  const placeholder = typeof args.placeholder === 'string' && args.placeholder.length > 0
    ? args.placeholder
    : null
  const multiQuestionOptions = detectMultiQuestionOptions(options)
  if (multiQuestionOptions) {
    const labelHint = multiQuestionOptions.labels?.length
      ? ` Detected option groups: ${multiQuestionOptions.labels.slice(0, 5).join(', ')}.`
      : ''
    throw new ToolDomainError(
      'input_validation',
      `skill_ask_user accepts one question only. These options look like multiple questions or dimensions.${labelHint} Use ask_user_questions with one question per item instead.`,
      {
        executionId,
        reason: multiQuestionOptions.reason,
        labels: multiQuestionOptions.labels || null,
      },
    )
  }
  if (looksLikePostCompletionFollowup(args)) {
    return createToolExecutionOutput(
      '任务已经完成后的可选后续帮助不应使用 skill_ask_user，也不应暂停任务。请直接用普通总结回复说明产物已完成，并简短询问用户是否需要调整。',
      {
        shape: 'json',
        data: {
          executionId,
          skipped: true,
          reason: 'post_completion_followup',
          askedAt,
        },
      },
    )
  }

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
      scopeId,
      agent,
      requestId,
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
        scopeId,
        agent,
        requestId,
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
