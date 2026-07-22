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
import { recordConfirmationGrant } from './authorization-fact-store'
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
/** EP2-I-auth — offered ONLY when an M3 grant candidate exists (M2 never). */
export const FROZEN_CALL_SESSION_CONFIRM_OPTION = '确认（本次会话内同对象免再确认）'

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
  agentId?: string | null
  /** EP2-Q4a — frozen-call audit events become task proofs (kind task_event). */
  appendProof?: ((taskId: string, ref: string) => void) | null
  /** EP2-I-auth WRITE ENTRY 2 — only honored when the user picked
   *  "本次会话内有效" on the card (default 仅此一次 = no grant). */
  sessionEffectiveGrant?: {
    actionCategory: 'login' | 'upload' | 'send_external' | 'collect_risky_site'
    objectRef: string
  } | null
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

  // Surface split: the CARD shows the redacted summary (the user must see
  // the object they approve, 05 §3.2); the DB row stores a value-free shape;
  // metrics carry the sha256 fingerprint only. Full params stay in the
  // store's memory record (the byte-identical release source). The
  // fingerprint joins card ↔ pending_confirmations row ↔ release metric.
  const auditSummary = frozen.auditSummary
  const fingerprint = frozen.paramsSha256.slice(0, 12)

  // 动作 + 对象 + 风险一句话 — a structured confirmation card, not a
  // free-text question (05 §3.2).
  const question = {
    id: FROZEN_CALL_QUESTION_ID,
    question: `确认执行 ${toolName}：${auditSummary}。风险：${decision.reason}（${decision.mode}，参数指纹 ${fingerprint}）`,
    kind: 'single_choice' as const,
    options: deps.sessionEffectiveGrant
      ? [FROZEN_CALL_CONFIRM_OPTION, FROZEN_CALL_SESSION_CONFIRM_OPTION, FROZEN_CALL_DENY_OPTION]
      : [FROZEN_CALL_CONFIRM_OPTION, FROZEN_CALL_DENY_OPTION],
  }

  let answer: string | null = null
  try {
    const cardOutput = await executeAskUserQuestions({ questions: [question] }, {
      sessionId: sessionId || undefined,
      conversationId: deps.conversationId || undefined,
      scopeId: deps.scopeId || undefined,
      agent: deps.agentId || undefined,
      requestId: deps.runId || undefined,
      lifecycleType: 'action_confirmation',
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
    if (deps.taskId && deps.appendProof) deps.appendProof(deps.taskId, `frozen:${frozen.id}|expired`)
    return { kind: 'expired', frozenCallId: frozen.id, reason }
  }

  if (answer === FROZEN_CALL_CONFIRM_OPTION || answer === FROZEN_CALL_SESSION_CONFIRM_OPTION) {
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
      if (deps.taskId && deps.appendProof) deps.appendProof(deps.taskId, `frozen:${frozen.id}|expired`)
      return { kind: 'expired', frozenCallId: frozen.id, reason: released.reason }
    }
    logAgentMetric(METRIC_FROZEN_CALL_RELEASED, {
      frozenCallId: frozen.id,
      toolName,
      sessionId,
      paramsSha256: frozen.paramsSha256,
    })
    if (deps.taskId && deps.appendProof) deps.appendProof(deps.taskId, `frozen:${frozen.id}|released`)
    if (answer === FROZEN_CALL_SESSION_CONFIRM_OPTION && deps.sessionEffectiveGrant && deps.scopeId) {
      recordConfirmationGrant({
        scopeId: deps.scopeId,
        actionCategory: deps.sessionEffectiveGrant.actionCategory,
        objectRef: deps.sessionEffectiveGrant.objectRef,
        frozenCallId: frozen.id,
        paramsSha256: frozen.paramsSha256,
      })
    }
    return { kind: 'released', frozenCallId: frozen.id, params: released.params }
  }

  deps.store.deny(frozen.id)
  logAgentMetric(METRIC_FROZEN_CALL_DENIED, {
    frozenCallId: frozen.id,
    toolName,
    sessionId,
    paramsSha256: frozen.paramsSha256,
  })
  if (deps.taskId && deps.appendProof) deps.appendProof(deps.taskId, `frozen:${frozen.id}|denied`)
  return { kind: 'denied_by_user', frozenCallId: frozen.id }
}
