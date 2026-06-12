/**
 * EP3-A4 — agent handoff proposal (04 篇): 提议 → 用户采纳 → owner 切换.
 *
 * The proposal card is an `ask_user_questions` VARIANT (same paradigm as
 * the EP1-I3-2 frozen-call confirmation): a host-generated single-choice
 * card reusing the existing store / emitter / persistor / renderer card UI
 * / submit IPC — §7 minimal closed loop satisfied by reuse, zero new
 * channels. The tool is M4 (advisory, executes no external action); the
 * adoption is ALWAYS a user click — confirm-free automatic handoff does
 * not exist.
 *
 * Verbatim iron law (05 §4, the I4 立面): `userRequestVerbatim` passes
 * through this flow byte-for-byte — proposal input → adopted outcome →
 * new-session prefill. The card TEXT may clip for display; the carried
 * field never does.
 *
 * Owner switch: adoption with a taskId writes `ownerAgentId` through the
 * injected updater (repository.update — the ONLY value-writing point in
 * the codebase). Same-session continuation is the default; the new-session
 * path returns a prefill payload instead of writing the current task.
 */

import { logAgentMetric } from '../metrics'
import { executeAskUserQuestions } from '../../tools/builtins/ask-user-questions'
import type {
  EmitAskUserQuestionsCard,
  PersistAskUserQuestionsCardPending,
} from '../../tools/builtins/ask-user-questions'
import type { AskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'
import { ToolDomainError } from '../../tools/tool-errors'
import { validatePacketFields } from '../quality/packet-fields'
import { MAIN_AGENT_ID, type AgentRegistryRecord } from '../../repositories/agent-registry-repository'

export const HANDOFF_QUESTION_ID = 'agent_handoff_proposal'
export const HANDOFF_ADOPT_OPTION = '转给ta（当前会话继续）'
export const HANDOFF_NEW_SESSION_OPTION = '新会话接手（预填原话）'
export const HANDOFF_REJECT_OPTION = '不用转'

const METRIC_PROPOSED = 'agent_handoff_proposed'
const METRIC_ADOPTED = 'agent_handoff_adopted'
const METRIC_REJECTED = 'agent_handoff_rejected'

const clipForDisplay = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

export interface HandoffProposalInput {
  targetAgentId: string
  /** One-line model reason — advisory, shown on the card. */
  reason: string
  /** 用户原话逐字 — carried byte-for-byte, never summarized. */
  userRequestVerbatim: string
  contextRefs?: string[]
  taskId?: string | null
}

export interface HandoffProposalDeps {
  getAgent: (id: string) => AgentRegistryRecord | null
  /** The ONLY ownerAgentId value writer in the codebase
   *  (TaskProjectionRepository.update behind this seam). */
  updateTaskOwner: (taskId: string, ownerAgentId: string) => void
  sessionId?: string | null
  conversationId?: string | null
  scopeId?: string | null
  signal?: AbortSignal
  emitCard?: EmitAskUserQuestionsCard
  persistCard?: PersistAskUserQuestionsCardPending
  askUserStore?: AskUserQuestionsStore
  timeoutMs?: number
}

export type HandoffProposalOutcome =
  | { kind: 'adopted'; targetAgentId: string; taskId: string | null; ownerWritten: boolean }
  | {
      kind: 'adopted_new_session'
      targetAgentId: string
      /** Byte-identical to the proposal input — the new session prefill. */
      prefillVerbatim: string
      contextRefs: string[]
      taskId: string | null
    }
  | { kind: 'rejected_by_user'; targetAgentId: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'card_failed'; reason: string }

export async function runHandoffProposal(
  input: HandoffProposalInput,
  deps: HandoffProposalDeps,
): Promise<HandoffProposalOutcome> {
  // ---- structural validation (structured errors back to the model)
  if (typeof input.userRequestVerbatim !== 'string' || input.userRequestVerbatim.length === 0) {
    return { kind: 'invalid', reason: 'userRequestVerbatim is required — 携用户原话逐字，禁止摘要' }
  }
  const contextRefs = Array.isArray(input.contextRefs) ? input.contextRefs.map(String) : []
  try {
    validatePacketFields({ contextRefs })
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) }
  }
  const target = deps.getAgent(String(input.targetAgentId || '').trim())
  if (!target) {
    return { kind: 'invalid', reason: `unknown agent: ${String(input.targetAgentId)} — 只能转给 agents 表里已存在的专项 agent` }
  }
  if (target.id === MAIN_AGENT_ID) {
    return { kind: 'invalid', reason: 'cannot hand off to the main agent itself' }
  }
  if (target.status !== 'active') {
    return { kind: 'invalid', reason: `agent ${target.id} is not active (${target.status})` }
  }

  logAgentMetric(METRIC_PROPOSED, {
    targetAgentId: target.id,
    sessionId: deps.sessionId ?? null,
    taskId: input.taskId ?? null,
  })

  // ---- the proposal card (display text may clip; the carried field never does)
  const question = {
    id: HANDOFF_QUESTION_ID,
    question: [
      `建议把这个任务转给「${target.name}」（${clipForDisplay(target.charter || '专项 agent', 80)}）。`,
      `理由：${clipForDisplay(input.reason || '更对口', 120)}`,
      `原话：「${clipForDisplay(input.userRequestVerbatim, 120)}」`,
    ].join('\n'),
    kind: 'single_choice' as const,
    options: [HANDOFF_ADOPT_OPTION, HANDOFF_NEW_SESSION_OPTION, HANDOFF_REJECT_OPTION],
  }

  let answer: string | null = null
  try {
    const cardOutput = await executeAskUserQuestions({ questions: [question] }, {
      sessionId: deps.sessionId || undefined,
      conversationId: deps.conversationId || undefined,
      signal: deps.signal,
      emitAskUserQuestionsCard: deps.emitCard,
      persistCardPending: deps.persistCard,
      store: deps.askUserStore,
      timeoutMs: deps.timeoutMs,
    })
    const answers = (cardOutput.data?.answers ?? []) as Array<{ id: string; answer: unknown }>
    const found = answers.find((entry) => entry.id === HANDOFF_QUESTION_ID)
    answer = typeof found?.answer === 'string' ? found.answer : null
  } catch (error) {
    const reason = error instanceof ToolDomainError ? error.errorKind : 'card_failed'
    logAgentMetric(METRIC_REJECTED, { targetAgentId: target.id, sessionId: deps.sessionId ?? null, reason })
    return { kind: 'card_failed', reason }
  }

  if (answer === HANDOFF_ADOPT_OPTION) {
    let ownerWritten = false
    if (input.taskId) {
      // adoption = the user clicked; ONLY here does ownerAgentId get a value.
      deps.updateTaskOwner(input.taskId, target.id)
      ownerWritten = true
    }
    logAgentMetric(METRIC_ADOPTED, {
      targetAgentId: target.id,
      sessionId: deps.sessionId ?? null,
      taskId: input.taskId ?? null,
      mode: 'same_session',
    })
    return { kind: 'adopted', targetAgentId: target.id, taskId: input.taskId ?? null, ownerWritten }
  }

  if (answer === HANDOFF_NEW_SESSION_OPTION) {
    logAgentMetric(METRIC_ADOPTED, {
      targetAgentId: target.id,
      sessionId: deps.sessionId ?? null,
      taskId: input.taskId ?? null,
      mode: 'new_session',
    })
    return {
      kind: 'adopted_new_session',
      targetAgentId: target.id,
      prefillVerbatim: input.userRequestVerbatim,
      contextRefs,
      taskId: input.taskId ?? null,
    }
  }

  logAgentMetric(METRIC_REJECTED, {
    targetAgentId: target.id,
    sessionId: deps.sessionId ?? null,
    reason: 'user_rejected',
  })
  return { kind: 'rejected_by_user', targetAgentId: target.id }
}
