/**
 * EP1-I3-2 — Frozen-call confirmation flow（冻结 → 确认卡 → 放行/拒绝/过期）.
 *
 * Runs INSIDE the original run's tool-execution context ("原 run 内同步
 * 等待"): the caller (tool-executor confirmation gate) awaits this function
 * while abortSignal / browser host / allowlists stay alive. The confirmation
 * card is an `ask_user_questions` VARIANT — a host-generated single-choice
 * card (动作 + 对象 + 风险一句话) that reuses the existing card machinery
 * (store / emitter / persistor / renderer card UI / submit IPC), inheriting
 * its per-turn and single-pending discipline. The dedicated
 * `agent:frozenCall:respond` IPC converges on the same card via
 * `submitAskUserQuestionsAnswersCore`, so there is exactly one decision
 * mechanism.
 *
 * Outcome semantics (合同红线):
 *   - released → caller re-enters the SAME dispatch path with the frozen
 *     params; the one-shot token was consumed by `store.release`.
 *   - denied_by_user / expired / pending_exists → caller returns a
 *     structured denial; the tool never runs.
 *   - ANY abnormal card outcome (timeout, abort, overlapping card,
 *     persistence failure) voids the frozen call — never executes.
 *
 * Audit: released/denied/expired events land in metrics.
 * TODO(02 篇 Q1): migrate the audit rows to proof_refs once Q1 lands.
 */

import { logAgentMetric } from '../metrics'
import {
  executeAskUserQuestions,
} from '../../tools/builtins/ask-user-questions'
import type {
  EmitAskUserQuestionsCard,
  PersistAskUserQuestionsCardPending,
} from '../../tools/builtins/ask-user-questions'
import type { AskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'
import { ToolDomainError } from '../../tools/tool-errors'
import type { ConfirmationGateDecision } from './action-confirmation-policy'
import {
  DEFAULT_FROZEN_CALL_TTL_MS,
  type FrozenCallStore,
} from './frozen-call-store'

export const FROZEN_CALL_QUESTION_ID = 'frozen_call_confirm'
export const FROZEN_CALL_CONFIRM_OPTION = '确认执行'
export const FROZEN_CALL_DENY_OPTION = '取消'

const METRIC_FROZEN_CALL_RELEASED = 'frozen_call_released'
const METRIC_FROZEN_CALL_DENIED = 'frozen_call_denied'
const METRIC_FROZEN_CALL_EXPIRED = 'frozen_call_expired'

/**
 * Rules whose frozen params carry credentials / sensitive payloads — the
 * audit copy (DB row, card text, metrics) masks ALL free-text values for
 * these, not just sensitively-named keys (a login fill's password sits in a
 * generic `text`/`value` argument).
 */
const SENSITIVE_PARAM_RULE_IDS = new Set([
  'm3-login-existing-account',
  'm2-send-sensitive',
])

export interface FrozenCallConfirmationDeps {
  store: FrozenCallStore
  sessionId?: string | null
  conversationId?: string | null
  runId?: string | null
  taskId?: string | null
  scopeId?: string | null
  signal?: AbortSignal
  emitCard?: EmitAskUserQuestionsCard
  persistCard?: PersistAskUserQuestionsCardPending
  /** Defaults to the shared singleton; injectable for tests. */
  askUserStore?: AskUserQuestionsStore
  /** Confirmation TTL — defaults to the store's 10-minute TTL. */
  timeoutMs?: number
}

export type FrozenCallConfirmationOutcome =
  | { kind: 'released'; frozenCallId: string; params: Record<string, unknown> }
  | { kind: 'denied_by_user'; frozenCallId: string }
  | { kind: 'expired'; frozenCallId: string; reason: string }
  | { kind: 'pending_exists' }
  | { kind: 'unavailable'; reason: string }

export async function runFrozenCallConfirmation(
  toolName: string,
  args: Record<string, unknown>,
  decision: ConfirmationGateDecision,
  deps: FrozenCallConfirmationDeps,
): Promise<FrozenCallConfirmationOutcome> {
  const sessionId = deps.sessionId ?? null
  // One TTL for the whole confirmation: the frozen call AND the card expire
  // together (Codex review P1#3 — without this the card defaulted to the
  // ask_user_questions 24h timeout while the frozen call died at 10min,
  // pinning the run and the single-pending card slot for hours).
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FROZEN_CALL_TTL_MS
  const sensitiveParams = SENSITIVE_PARAM_RULE_IDS.has(decision.ruleId)
  const frozen = deps.store.freeze({
    toolName,
    params: args,
    runId: deps.runId ?? null,
    taskId: deps.taskId ?? null,
    scopeId: deps.scopeId ?? null,
    sessionId,
    ttlMs: timeoutMs,
    sensitiveParams,
  })
  if (!frozen.ok) {
    return frozen.reason === 'pending_exists'
      ? { kind: 'pending_exists' }
      : { kind: 'unavailable', reason: frozen.reason }
  }

  // Card/metrics only ever see the store's REDACTED summary + the sha256
  // fingerprint — full params stay in the store's memory record (the
  // byte-identical release source). The fingerprint lets an audit join the
  // card the user approved ↔ the pending_confirmations row ↔ the release
  // metric, without any of them carrying the raw bytes.
  const auditSummary = frozen.auditSummary
  const fingerprint = frozen.paramsSha256.slice(0, 12)

  // 动作 + 对象 + 风险一句话 — a structured confirmation card, not a
  // free-text question (05 §3.2).
  const question = {
    id: FROZEN_CALL_QUESTION_ID,
    question: `确认执行 ${toolName}：${auditSummary}。风险：${decision.reason}（${decision.mode}，参数指纹 ${fingerprint}）`,
    kind: 'single_choice' as const,
    options: [FROZEN_CALL_CONFIRM_OPTION, FROZEN_CALL_DENY_OPTION],
  }

  let answer: string | null = null
  try {
    const cardOutput = await executeAskUserQuestions({ questions: [question] }, {
      sessionId: sessionId || undefined,
      conversationId: deps.conversationId || undefined,
      signal: deps.signal,
      emitAskUserQuestionsCard: deps.emitCard,
      persistCardPending: deps.persistCard,
      store: deps.askUserStore,
      timeoutMs,
    })
    const answers = (cardOutput.data?.answers ?? []) as Array<{ id: string; answer: unknown }>
    const found = answers.find((a) => a.id === FROZEN_CALL_QUESTION_ID)
    answer = typeof found?.answer === 'string' ? found.answer : null
  } catch (error) {
    const reason = error instanceof ToolDomainError ? error.errorKind : 'card_failed'
    deps.store.expire(frozen.id)
    logAgentMetric(METRIC_FROZEN_CALL_EXPIRED, {
      frozenCallId: frozen.id,
      toolName,
      sessionId,
      reason,
      paramsSha256: frozen.paramsSha256,
    })
    if (reason === 'overlapping_card') {
      return { kind: 'pending_exists' }
    }
    return { kind: 'expired', frozenCallId: frozen.id, reason }
  }

  if (answer === FROZEN_CALL_CONFIRM_OPTION) {
    const released = deps.store.release(frozen.id, frozen.token)
    if (!released.ok) {
      // Confirmed too late (TTL elapsed / state raced) — never execute.
      logAgentMetric(METRIC_FROZEN_CALL_EXPIRED, {
        frozenCallId: frozen.id,
        toolName,
        sessionId,
        reason: released.reason,
        paramsSha256: frozen.paramsSha256,
      })
      return { kind: 'expired', frozenCallId: frozen.id, reason: released.reason }
    }
    logAgentMetric(METRIC_FROZEN_CALL_RELEASED, {
      frozenCallId: frozen.id,
      toolName,
      sessionId,
      paramsSummary: auditSummary,
      paramsSha256: frozen.paramsSha256,
    })
    return { kind: 'released', frozenCallId: frozen.id, params: released.params }
  }

  deps.store.deny(frozen.id)
  logAgentMetric(METRIC_FROZEN_CALL_DENIED, {
    frozenCallId: frozen.id,
    toolName,
    sessionId,
    paramsSummary: auditSummary,
    paramsSha256: frozen.paramsSha256,
  })
  return { kind: 'denied_by_user', frozenCallId: frozen.id }
}
