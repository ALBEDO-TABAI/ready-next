/**
 * EP2-E1 — emergence kernel v1 (10 篇 §3): three intent-density card types
 * extracted from structured task/knowledge signals. Deterministic, zero LLM.
 *
 * Triplet rule: every projected card carries evidence chain + confidence +
 * an action exit. A card without an exit never reaches the feed (纯信息归
 * 各自面板). Crystallize cards (system-learned candidates / duplicates)
 * always require explicit confirmation — never one-click — and use
 * observation wording, not judgment wording (10 §4 用户边界).
 *
 * Feed controls: global ≤8, per-type ≤3, confidence floor. (反馈降权 joins
 * with E2's interaction loop.)
 */

import type { TaskProjectionRecord } from '../contracts/run-contracts'

export interface EmergenceEvidence {
  fact: string
  ref: string
}

export interface EmergenceAction {
  kind: 'resume_task' | 'adjudicate_task' | 'supply_input' | 'adopt_candidate' | 'review_duplicate'
  ref: string
}

export interface EmergenceCard {
  id: string
  type: 'resume' | 'follow_up' | 'crystallize'
  title: string
  evidence: EmergenceEvidence[]
  confidence: number
  action: EmergenceAction
  /** Crystallize cards must be explicitly confirmed — no one-click, no batch. */
  requiresExplicitConfirm: boolean
}

export const EMERGENCE_GLOBAL_LIMIT = 8
export const EMERGENCE_PER_TYPE_LIMIT = 3
export const EMERGENCE_CONFIDENCE_FLOOR = 0.5

const RESUMABLE_STATUSES = new Set(['blocked', 'recoverable_paused', 'budget_paused'])

/** "我刚才/昨天做到哪了" — blocked/paused tasks with a continuation handle. */
export function extractResumeCards(projections: ReadonlyArray<TaskProjectionRecord>): EmergenceCard[] {
  const out: EmergenceCard[] = []
  for (const record of projections) {
    if (!RESUMABLE_STATUSES.has(String(record.status))) continue
    const ref = record.continuationRef as Record<string, unknown> | null | undefined
    if (!ref && record.canResume !== true) continue
    const blockerType = ref && typeof ref.blockerType === 'string' ? ref.blockerType : null
    out.push({
      id: `resume:${record.taskId}`,
      type: 'resume',
      title: `「${record.taskTitle || record.taskId}」停在半路，可以续跑`,
      evidence: [
        { fact: `状态 ${record.status}${blockerType ? `，阻塞类型 ${blockerType}` : ''}`, ref: `task:${record.taskId}` },
        { fact: `最后更新 ${record.updatedAt}`, ref: `task:${record.taskId}` },
      ],
      confidence: record.canResume === true ? 0.85 : 0.65,
      action: { kind: 'resume_task', ref: record.taskId },
      requiresExplicitConfirm: false,
    })
  }
  return out
}

/** "有什么在等我" — pending adjudication or missing user input. */
export function extractFollowUpCards(projections: ReadonlyArray<TaskProjectionRecord>): EmergenceCard[] {
  const out: EmergenceCard[] = []
  for (const record of projections) {
    const ref = record.continuationRef as Record<string, unknown> | null | undefined
    const blockerType = ref && typeof ref.blockerType === 'string' ? ref.blockerType : null
    if (record.interactionState === 'check_in_pending') {
      out.push({
        id: `followup:adjudicate:${record.taskId}`,
        type: 'follow_up',
        title: `「${record.taskTitle || record.taskId}」完成待裁决`,
        evidence: [{ fact: 'interaction_state=check_in_pending', ref: `task:${record.taskId}` }],
        confidence: 0.9,
        action: { kind: 'adjudicate_task', ref: record.taskId },
        requiresExplicitConfirm: false,
      })
      continue
    }
    if (blockerType === 'user_input_missing') {
      out.push({
        id: `followup:input:${record.taskId}`,
        type: 'follow_up',
        title: `「${record.taskTitle || record.taskId}」在等你补充信息`,
        evidence: [
          { fact: 'blockerCategory=user_input_missing', ref: `task:${record.taskId}` },
          ...(record.blockedReason ? [{ fact: String(record.blockedReason), ref: `task:${record.taskId}` }] : []),
        ],
        confidence: 0.8,
        action: { kind: 'supply_input', ref: record.taskId },
        requiresExplicitConfirm: false,
      })
    }
  }
  return out
}

export interface CrystallizeSignalCard {
  relPath: string
  title: string
  tag: string
  status: string
  source: string | null
  /** EP3-C5 candidate stage — stage-carrying cards NEVER project through
   *  this legacy path; they go through extractAgentCandidateCards with the
   *  stricter candidate+evidence≥3 gate. */
  stage?: string | null
}

/** "系统学到了什么、要不要采纳" — aspire candidates + suspected duplicates.
 *  Observation wording only ("最近…" 而非 "你是一个…"). */
export function extractCrystallizeCards(cards: ReadonlyArray<CrystallizeSignalCard>): EmergenceCard[] {
  const out: EmergenceCard[] = []
  for (const card of cards) {
    if (card.source && card.source.startsWith('possible-duplicate-of')) {
      out.push({
        id: `crystallize:dup:${card.relPath}`,
        type: 'crystallize',
        title: `「${card.title}」疑似与已有卡片重复，需要你裁决`,
        evidence: [{ fact: card.source, ref: card.relPath }],
        confidence: 0.6,
        action: { kind: 'review_duplicate', ref: card.relPath },
        requiresExplicitConfirm: true,
      })
      continue
    }
    // EP3-C5 — agent-candidate cards (stage present) are gated by
    // extractAgentCandidateCards (candidate + ≥3 evidence); the legacy
    // aspire path must not leak hint/under-evidenced candidates.
    if (card.tag === 'aspire' && !card.stage) {
      out.push({
        id: `crystallize:candidate:${card.relPath}`,
        type: 'crystallize',
        title: `观察到一个可沉淀的模式：${card.title}`,
        evidence: [{ fact: `候选卡 status=${card.status}`, ref: card.relPath }],
        confidence: 0.7,
        action: { kind: 'adopt_candidate', ref: card.relPath },
        requiresExplicitConfirm: true,
      })
    }
  }
  return out
}

export interface AgentCandidateFeedSignal {
  relPath: string
  title: string
  /** EP3-C5 candidate lifecycle stage from card frontmatter. */
  stage: string
  /** Dated evidence entries parsed from the card body. */
  evidenceDates: string[]
}

/**
 * EP3-C5 — candidate → intent-feed projection: ONLY stage 'candidate' with
 * ≥3 dated evidence entries projects; reuses the crystallize explicit-
 * confirm discipline (never one-click). The action exit is the phase-3
 * placeholder — confirmation records adoption; derivation itself is the
 * phase-4 A6 flow.
 */
export function extractAgentCandidateCards(signals: ReadonlyArray<AgentCandidateFeedSignal>): EmergenceCard[] {
  const out: EmergenceCard[] = []
  for (const signal of signals) {
    if (signal.stage !== 'candidate') continue
    if (signal.evidenceDates.length < 3) continue
    out.push({
      id: `crystallize:agent-candidate:${signal.relPath}`,
      type: 'crystallize',
      title: `最近多次出现同类请求：${signal.title}`,
      evidence: [
        ...signal.evidenceDates.slice(0, 3).map((date) => ({ fact: `同域请求出现于 ${date}`, ref: signal.relPath })),
        { fact: '确认后仅记录采纳——派生流程属阶段四', ref: signal.relPath },
      ],
      confidence: 0.7,
      action: { kind: 'adopt_candidate', ref: signal.relPath },
      requiresExplicitConfirm: true,
    })
  }
  return out
}

/** Apply the four feed controls and a stable ordering. */
export function assembleEmergenceFeed(
  cards: ReadonlyArray<EmergenceCard>,
  opts: { globalLimit?: number; perTypeLimit?: number; confidenceFloor?: number } = {},
): EmergenceCard[] {
  const globalLimit = opts.globalLimit ?? EMERGENCE_GLOBAL_LIMIT
  const perTypeLimit = opts.perTypeLimit ?? EMERGENCE_PER_TYPE_LIMIT
  const floor = opts.confidenceFloor ?? EMERGENCE_CONFIDENCE_FLOOR
  const eligible = cards
    .filter((card) => card.action && card.action.ref && card.evidence.length > 0)
    .filter((card) => card.confidence >= floor)
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
  const perType = new Map<string, number>()
  const out: EmergenceCard[] = []
  for (const card of eligible) {
    if (out.length >= globalLimit) break
    const used = perType.get(card.type) ?? 0
    if (used >= perTypeLimit) continue
    perType.set(card.type, used + 1)
    out.push(card)
  }
  return out
}
