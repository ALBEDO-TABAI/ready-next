/**
 * EP2-E1 — emergence kernel v1 (10 篇 §3): three intent-density card types
 * extracted from structured task/knowledge signals. Deterministic, zero LLM.
 *
 * 2026-07-03 梯队三通电：由 `claude-bridge/ipc/emergence-feed-group.ts` 组装
 * （fired 账本 `emergence_feed_assembled`），正向 gate 见
 * `check-mandated-capability-is-live.cjs`。prepare/harvest/forming 三类的
 * 信号采集（日历联动/产物打开跟踪/文件聚类）尚无数据源，提取器保留出口。
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
import { isPossibleDuplicateOfSource } from '../knowledge/reserved-card-source'

export interface EmergenceEvidence {
  fact: string
  ref: string
}

export interface EmergenceAction {
  kind:
    | 'resume_task'
    | 'adjudicate_task'
    | 'supply_input'
    | 'adopt_candidate'
    | 'review_duplicate'
    | 'open_project'
    | 'open_artifact'
    | 'open_project_group'
  ref: string
  targetPath?: string | null
  memberPaths?: string[]
}

export interface EmergenceCard {
  id: string
  projectKey?: string
  type: 'resume' | 'follow_up' | 'crystallize' | 'prepare' | 'harvest' | 'forming'
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
    // EP3-C5 — stage-carrying candidate cards NEVER project through this
    // legacy path (any branch); they go through extractAgentCandidateCards
    // with the candidate+evidence≥3 gate.
    if (card.stage) continue
    if (isPossibleDuplicateOfSource(card.source)) {
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
    if (card.tag === 'aspire') {
      out.push({
        id: `crystallize:candidate:${card.relPath}`,
        type: 'crystallize',
        title: `观察到一个可沉淀的模式：${card.title}`,
        evidence: [{ fact: `候选卡 status=${card.status}`, ref: card.relPath }],
        confidence: 0.7,
        action: { kind: 'adopt_candidate', ref: card.relPath },
        requiresExplicitConfirm: true,
      })
      continue
    }
    // D10-b（2026-07-04 真机实锚）：浏览器失败学习产出的 staged 站点卡
    // （新卡/旁卡/风险建议）此前在 feed 完全不可见——agent 带着已学到但
    // 未确认的知识原地重摔（site_card_user_override_skipped）。这里只投影
    // 站点卡学习的三种 source 前缀，不把其他 staged 信念卡拉进 feed；
    // 确认动作仍走 Settings 信念卡面板（后台积累 + 设置页确认的产品观）。
    if (card.status === 'staged' && isSiteCardLearningSource(card.source)) {
      const risky = String(card.source).startsWith('possible-risk-update-of:')
      out.push({
        id: `crystallize:site:${card.relPath}`,
        type: 'crystallize',
        title: risky
          ? `浏览器发现「${card.title}」有风险提示待你处理`
          : `浏览器学到了「${card.title}」，确认后下次生效`,
        evidence: [{ fact: `staged 站点卡 source=${card.source}`, ref: card.relPath }],
        confidence: 0.7,
        action: { kind: 'adopt_candidate', ref: card.relPath },
        requiresExplicitConfirm: true,
      })
    }
  }
  return out
}

const SITE_CARD_LEARNING_SOURCE_PREFIXES = ['failure-learning:', 'possible-update-of:', 'possible-risk-update-of:'] as const

function isSiteCardLearningSource(source: string | null): boolean {
  if (!source) return false
  return SITE_CARD_LEARNING_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix))
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

export interface PrepareCardSignal {
  id: string
  title: string
  startsAt: string
  projectRef: string
  sourceDomain?: string | null
  confidence?: number
}

export interface HarvestCardSignal {
  id: string
  title: string
  completedAt: string
  artifactRef: string
  artifactLabel: string
  openedAfterCompletion: boolean
  protectedPath?: boolean
  sourceDomain?: string | null
  confidence?: number
}

export interface HarvestIntentProjection {
  /** Cards allowed to enter the intent feed when R-E2 is unlocked. */
  cards: EmergenceCard[]
  /** Same sanitized cards, held back while the intent-feed surface is blocked. */
  deferredCards: EmergenceCard[]
  blockedBy: 'R-E2' | null
}

export interface FormingCardSignal {
  id: string
  title: string
  fileRefs: string[]
  projectRef: string
  sourceDomain?: string | null
  confidence?: number
}

function sourceEvidence(sourceDomain: string | null | undefined): EmergenceEvidence[] {
  return sourceDomain ? [{ fact: `第三方来源域名 ${sourceDomain}`, ref: `domain:${sourceDomain}` }] : []
}

function isProtectedArtifact(signal: HarvestCardSignal): boolean {
  if (signal.protectedPath) return true
  const text = `${signal.artifactLabel}\n${signal.artifactRef}`.toLowerCase()
  return /(^|[/\\])\.(ssh|aws|config|env)([/\\]|$)/.test(text)
    || /(^|[/\\])\.env(?:[./\\-]|$)/.test(text)
    || /\b(secret|credential|credentials|password|private[-_ ]?key|id_rsa|token)\b/.test(text)
}

/** "接下来有什么要来" — future calendar/project signals with an exit. */
export function extractPrepareCards(signals: ReadonlyArray<PrepareCardSignal>): EmergenceCard[] {
  return signals
    .filter((signal) => signal.projectRef.trim().length > 0)
    .map((signal) => ({
      id: `prepare:${signal.id}`,
      type: 'prepare' as const,
      title: `接下来要准备：${signal.title}`,
      evidence: [
        { fact: `未来事件 ${signal.startsAt}`, ref: signal.id },
        ...sourceEvidence(signal.sourceDomain),
      ],
      confidence: signal.confidence ?? 0.72,
      action: { kind: 'open_project' as const, ref: signal.projectRef },
      requiresExplicitConfirm: false,
    }))
}

/** "做完的东西在哪" — completed proof artifacts not reopened yet. */
export function extractHarvestCards(signals: ReadonlyArray<HarvestCardSignal>): EmergenceCard[] {
  return signals
    .filter((signal) => !signal.openedAfterCompletion)
    .filter((signal) => signal.artifactRef.trim().length > 0)
    .map((signal) => {
      const label = isProtectedArtifact(signal) ? '产物已生成（受保护路径）' : signal.artifactLabel
      return {
        id: `harvest:${signal.id}`,
        type: 'harvest' as const,
        title: `已完成产物：${label}`,
        evidence: [
          { fact: `任务完成于 ${signal.completedAt}`, ref: signal.id },
          { fact: `产物 ${label}`, ref: signal.artifactRef },
          ...sourceEvidence(signal.sourceDomain),
        ],
        confidence: signal.confidence ?? 0.7,
        action: { kind: 'open_artifact' as const, ref: signal.artifactRef },
        requiresExplicitConfirm: false,
      }
    })
}

export function buildHarvestIntentProjection(
  signals: ReadonlyArray<HarvestCardSignal>,
  opts: { intentFeedEnabled?: boolean } = {},
): HarvestIntentProjection {
  const cards = assembleEmergenceFeed(extractHarvestCards(signals), {
    globalLimit: EMERGENCE_PER_TYPE_LIMIT,
    perTypeLimit: EMERGENCE_PER_TYPE_LIMIT,
    confidenceFloor: EMERGENCE_CONFIDENCE_FLOOR,
  })
  if (opts.intentFeedEnabled) {
    return { cards, deferredCards: [], blockedBy: null }
  }
  return { cards: [], deferredCards: cards, blockedBy: 'R-E2' }
}

/** "手头在长出什么项目" — file/project clusters with a project-group exit. */
export function extractFormingCards(signals: ReadonlyArray<FormingCardSignal>): EmergenceCard[] {
  return signals
    .filter((signal) => signal.projectRef.trim().length > 0 && signal.fileRefs.length > 0)
    .map((signal) => ({
      id: `forming:${signal.id}`,
      type: 'forming' as const,
      title: `正在成形：${signal.title}`,
      evidence: [
        { fact: `相关文件 ${signal.fileRefs.length} 个`, ref: signal.projectRef },
        ...signal.fileRefs.slice(0, 3).map((ref) => ({ fact: '文件聚类证据', ref })),
        ...sourceEvidence(signal.sourceDomain),
      ],
      confidence: signal.confidence ?? 0.68,
      action: { kind: 'open_project_group' as const, ref: signal.projectRef },
      requiresExplicitConfirm: false,
    }))
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
