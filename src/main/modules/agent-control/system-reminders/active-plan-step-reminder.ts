/**
 * S4-3 — per-scope active plan store with per-turn re-injection (C4.2a).
 *
 * The live Agent SDK loop has no cross-turn plan memory: a multi-step task is
 * re-guessed every turn from the recalled summary. This module gives the loop
 * a code-owned plan slot:
 *
 *  - collection dispatch tools synthesize a deterministic plan (no LLM);
 *  - structured task handles, terminal state, and reconciled counts are the
 *    only facts that may advance a step;
 *  - before each model call the current step + completion hint is re-injected
 *    through the system-reminder seam, so follow-up turns keep the plan
 *    without re-deriving intent.
 *
 * The in-memory slot is backed by conversation-scope metadata when the live
 * runtime is attached, so a Ready restart restores the same evidence snapshot.
 */

import { logAgentMetric } from '../metrics'

export interface ActivePlanStep {
  id: string
  title: string
  advanceOnTools: string[]
  evidenceRequirement:
    | 'collection_manifest'
    | 'collection_run'
    | 'media_download_complete'
    | 'task_terminal_complete'
  status: 'pending' | 'done'
}

export interface ActivePlanEvidence {
  discoveryTaskId?: string
  discoveryStatus?: string
  discoveryResultStatus?: string
  executionTaskId?: string
  executionStatus?: string
  expectedCount?: number
  savedCount?: number
  failedCount?: number
  remainingCount?: number
  mediaComplete?: boolean
  mediaOk?: boolean
  mediaCompletion?: string
  reviewedTaskId?: string
  reviewStatus?: string
  reviewSavedCount?: number
  reviewFailedCount?: number
  reviewRemainingCount?: number
}

export interface ActivePlan {
  taskGoal: string
  steps: ActivePlanStep[]
  verify: 'evidence'
  evidence: ActivePlanEvidence
  updatedAtMs: number
}

const plansByScope = new Map<string, ActivePlan>()

export interface ActivePlanPersistence {
  load: (scope: string) => ActivePlan | null
  save: (scope: string, plan: ActivePlan) => void
  remove: (scope: string) => void
}

let persistence: ActivePlanPersistence | null = null

export function configureActivePlanPersistence(next: ActivePlanPersistence | null): void {
  persistence = next
}

function logPersistenceFailure(operation: 'load' | 'save' | 'remove', error: unknown): void {
  logAgentMetric('active_plan_persistence_failed', {
    operation,
    error: error instanceof Error ? error.message : String(error),
  })
}

function removePersistedPlan(scope: string): void {
  try {
    persistence?.remove(scope)
  } catch (error) {
    logPersistenceFailure('remove', error)
  }
}

function isActivePlan(value: unknown): value is ActivePlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as Partial<ActivePlan>
  const requirements = new Set<ActivePlanStep['evidenceRequirement']>([
    'collection_manifest',
    'collection_run',
    'media_download_complete',
    'task_terminal_complete',
  ])
  return (
    plan.verify === 'evidence' &&
    typeof plan.taskGoal === 'string' &&
    typeof plan.updatedAtMs === 'number' &&
    Boolean(plan.evidence && typeof plan.evidence === 'object' && !Array.isArray(plan.evidence)) &&
    Array.isArray(plan.steps) && plan.steps.length > 0 &&
    plan.steps.every((step) =>
      Boolean(
        step &&
        typeof step.id === 'string' &&
        typeof step.title === 'string' &&
        Array.isArray(step.advanceOnTools) &&
        step.advanceOnTools.every((toolName) => typeof toolName === 'string') &&
        requirements.has(step.evidenceRequirement) &&
        ['pending', 'done'].includes(step.status)
      )
    )
  )
}

function loadPlan(scope: string, nowMs: number = Date.now()): ActivePlan | null {
  const live = plansByScope.get(scope)
  if (live && nowMs - live.updatedAtMs <= ACTIVE_PLAN_TTL_MS) return live
  if (live) plansByScope.delete(scope)
  let restored: ActivePlan | null = null
  try {
    restored = persistence?.load(scope) || null
  } catch (error) {
    logPersistenceFailure('load', error)
    return null
  }
  if (!isActivePlan(restored)) return null
  if (nowMs - restored.updatedAtMs > ACTIVE_PLAN_TTL_MS) {
    removePersistedPlan(scope)
    return null
  }
  plansByScope.set(scope, restored)
  return restored
}

function savePlan(scope: string, plan: ActivePlan): void {
  plansByScope.set(scope, plan)
  try {
    persistence?.save(scope, plan)
  } catch (error) {
    logPersistenceFailure('save', error)
  }
}

/** Plans older than this are stale — do not re-inject. */
const ACTIVE_PLAN_TTL_MS = 30 * 60_000

const COLLECTION_DISPATCH_TOOLS = new Set([
  'browser_collect',
  'browser_download'
])
const COLLECTION_EVIDENCE_TOOLS = new Set([...COLLECTION_DISPATCH_TOOLS, 'browser_task'])
const TRACKABLE_TASK_STATUSES = new Set(['queued', 'running', 'paused', 'completed'])

function resultRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      // silent-catch: non-JSON result text falls back to the Error-prefix heuristic
      return value.startsWith('Error:') ? { ok: false } : null
    }
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.data && typeof record.data === 'object') return record.data as Record<string, unknown>
  if (typeof record.text === 'string') return resultRecord(record.text)
  return record
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function evidenceRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const result = nestedRecord(record.result)
  const mediaDownload = nestedRecord(result?.mediaDownload)
  const progress = nestedRecord(record.progress)
  return [record, result, mediaDownload, progress].filter((item): item is Record<string, unknown> =>
    Boolean(item)
  )
}

function firstString(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return null
}

function countValue(raw: unknown): number | null {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw)
        : Number.NaN
  return Number.isInteger(value) && value >= 0 ? value : null
}

function firstCount(records: Record<string, unknown>[], keys: string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      const value = countValue(record[key])
      if (value !== null) return value
    }
  }
  return null
}

function countSnapshot(records: Record<string, unknown>[]): {
  saved: number
  failed: number
  remaining: number
} | null {
  for (const record of records) {
    const saved = firstCount([record], ['saved', 'completed', 'success'])
    const failed = firstCount([record], ['failedCount', 'failed'])
    const remaining = firstCount([record], ['remaining'])
    if (saved !== null && failed !== null && remaining !== null) {
      return { saved, failed, remaining }
    }
  }
  return null
}

function discoveredCount(records: Record<string, unknown>[]): number | null {
  for (const record of records) {
    for (const key of ['targets', 'notes', 'mediaUrls', 'items']) {
      const value = record[key]
      if (Array.isArray(value) && value.length > 0) return value.length
    }
  }
  return firstCount(records, [
    'expectedCount',
    'expected_count',
    'total',
    'count',
    'discovered',
    'mediaCandidateCount'
  ])
}

function recordsShowIncompleteWork(records: Record<string, unknown>[]): boolean {
  for (const record of records) {
    if (Array.isArray(record.failedItems) && record.failedItems.length > 0) return true
    const failed = firstCount([record], ['failedCount', 'failed'])
    const remaining = firstCount([record], ['remaining'])
    if ((failed !== null && failed > 0) || (remaining !== null && remaining > 0)) return true
  }
  return false
}

function applyTerminalCounts(plan: ActivePlan, records: Record<string, unknown>[]): void {
  plan.evidence.savedCount = undefined
  plan.evidence.failedCount = undefined
  plan.evidence.remainingCount = undefined
  const snapshot = countSnapshot(records)
  if (!snapshot) return
  plan.evidence.savedCount = snapshot.saved
  plan.evidence.failedCount = snapshot.failed
  plan.evidence.remainingCount = snapshot.remaining
}

function countsAreComplete(evidence: ActivePlanEvidence): boolean {
  return (
    typeof evidence.expectedCount === 'number' &&
    evidence.expectedCount > 0 &&
    evidence.savedCount === evidence.expectedCount &&
    evidence.failedCount === 0 &&
    evidence.remainingCount === 0
  )
}

function applyReviewCounts(plan: ActivePlan, records: Record<string, unknown>[]): void {
  plan.evidence.reviewSavedCount = undefined
  plan.evidence.reviewFailedCount = undefined
  plan.evidence.reviewRemainingCount = undefined
  const snapshot = countSnapshot(records)
  if (!snapshot) return
  plan.evidence.reviewSavedCount = snapshot.saved
  plan.evidence.reviewFailedCount = snapshot.failed
  plan.evidence.reviewRemainingCount = snapshot.remaining
}

function reviewCountsAreComplete(evidence: ActivePlanEvidence): boolean {
  return (
    typeof evidence.expectedCount === 'number' &&
    evidence.expectedCount > 0 &&
    evidence.reviewSavedCount === evidence.expectedCount &&
    evidence.reviewFailedCount === 0 &&
    evidence.reviewRemainingCount === 0
  )
}

function absorbStructuredEvidence(
  plan: ActivePlan,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown
): void {
  const record = resultRecord(result)
  if (!record) return
  if (record.ok === false && toolName !== 'browser_download') return
  const records = evidenceRecords(record)
  const taskId = firstString(records, ['taskId', 'task_id'])
  const status = firstString(records, ['status'])
  const discoveryResultStatus = firstString(records, ['discoveryStatus', 'discovery_status'])

  if (toolName === 'browser_collect' && String(args.mode || 'visible') !== 'notes') {
    if (!taskId || (plan.evidence.discoveryTaskId && plan.evidence.discoveryTaskId !== taskId))
      return
    plan.evidence.discoveryTaskId = taskId
    if (status) plan.evidence.discoveryStatus = status
    if (discoveryResultStatus) plan.evidence.discoveryResultStatus = discoveryResultStatus
    const discoveryExplicitlyIncomplete = discoveryResultStatus
      ? !['complete', 'completed'].includes(discoveryResultStatus)
      : false
    if (status === 'completed' && !discoveryExplicitlyIncomplete && !recordsShowIncompleteWork(records)) {
      const count = discoveredCount(records)
      if (count !== null && count > 0 && plan.evidence.expectedCount === undefined) {
        plan.evidence.expectedCount = count
      }
    }
    return
  }

  if (toolName === 'browser_collect' && String(args.mode || '') === 'notes') {
    const sourceTaskId = String(
      args.source_task_id || firstString(records, ['sourceTaskId', 'source_task_id']) || ''
    ).trim()
    if (!sourceTaskId) return
    if (!plan.evidence.discoveryTaskId) plan.evidence.discoveryTaskId = sourceTaskId
    if (sourceTaskId !== plan.evidence.discoveryTaskId) return
    if (!taskId || taskId === sourceTaskId || !status || !TRACKABLE_TASK_STATUSES.has(status))
      return
    plan.evidence.executionTaskId = taskId
    plan.evidence.executionStatus = status
    return
  }

  if (toolName === 'browser_download') {
    const sourceTaskId = String(
      args.source_task_id || firstString(records, ['sourceTaskId', 'source_task_id']) || ''
    ).trim()
    if (
      !sourceTaskId ||
      (plan.evidence.discoveryTaskId && plan.evidence.discoveryTaskId !== sourceTaskId)
    )
      return
    plan.evidence.discoveryTaskId = sourceTaskId
    plan.evidence.mediaOk = record.ok === true
    plan.evidence.mediaCompletion = firstString(records, ['completion']) || undefined
    if (record.ok === false) return
    const count = discoveredCount(records)
    if (count !== null && count > 0 && plan.evidence.expectedCount === undefined) {
      plan.evidence.expectedCount = count
    }
    applyTerminalCounts(plan, records)
    plan.evidence.mediaComplete =
      plan.evidence.mediaOk === true &&
      plan.evidence.mediaCompletion === 'complete' &&
      (count === null || count === plan.evidence.expectedCount) &&
      countsAreComplete(plan.evidence)
    if (plan.evidence.mediaComplete) plan.evidence.discoveryStatus = 'completed'
    return
  }

  if (toolName === 'browser_task') {
    const queriedTaskId = String(args.task_id || '').trim()
    if (!queriedTaskId || !taskId || queriedTaskId !== taskId) return
    if (queriedTaskId === plan.evidence.discoveryTaskId) {
      if (status) plan.evidence.discoveryStatus = status
      if (discoveryResultStatus) plan.evidence.discoveryResultStatus = discoveryResultStatus
      if (status === 'completed' && !recordsShowIncompleteWork(records)) {
        const count = discoveredCount(records)
        if (count !== null && count > 0 && plan.evidence.expectedCount === undefined) {
          plan.evidence.expectedCount = count
        }
      }
      if (plan.evidence.mediaComplete === true) {
        plan.evidence.reviewedTaskId = queriedTaskId
        if (status) plan.evidence.reviewStatus = status
        applyReviewCounts(plan, records)
      }
      return
    }
    if (queriedTaskId !== plan.evidence.executionTaskId) return
    if (status) plan.evidence.executionStatus = status
    plan.evidence.reviewedTaskId = queriedTaskId
    if (status) plan.evidence.reviewStatus = status
    applyReviewCounts(plan, records)
  }
}

function stepHasEvidence(step: ActivePlanStep, evidence: ActivePlanEvidence): boolean {
  if (step.evidenceRequirement === 'collection_manifest') {
    return (
      evidence.discoveryStatus === 'completed' &&
      (!evidence.discoveryResultStatus ||
        ['complete', 'completed'].includes(evidence.discoveryResultStatus)) &&
      typeof evidence.expectedCount === 'number' &&
      evidence.expectedCount > 0
    )
  }
  if (step.evidenceRequirement === 'collection_run') {
    return Boolean(
      evidence.executionTaskId &&
      evidence.executionStatus &&
      TRACKABLE_TASK_STATUSES.has(evidence.executionStatus)
    )
  }
  if (step.evidenceRequirement === 'media_download_complete') return evidence.mediaComplete === true
  const expectedReviewTaskId =
    evidence.executionTaskId || (evidence.mediaComplete ? evidence.discoveryTaskId : undefined)
  return Boolean(
    expectedReviewTaskId &&
    evidence.reviewedTaskId === expectedReviewTaskId &&
    evidence.reviewStatus === 'completed' &&
    reviewCountsAreComplete(evidence)
  )
}

function advanceEvidenceBackedSteps(plan: ActivePlan): void {
  while (true) {
    const current = plan.steps.find((step) => step.status === 'pending')
    if (!current || !stepHasEvidence(current, plan.evidence)) return
    current.status = 'done'
  }
}

export function deriveCollectionPlanFromToolCall(
  toolName: string,
  args: Record<string, unknown>,
  nowMs: number
): ActivePlan | null {
  if (!COLLECTION_DISPATCH_TOOLS.has(toolName)) return null
  const target =
    typeof args.url === 'string'
      ? args.url
      : typeof args.target_profile_url === 'string'
        ? args.target_profile_url
        : '目标页面'
  const template = typeof args.template === 'string' ? args.template : ''
  const mediaPlan = toolName === 'browser_download' || template === 'image_gallery'
  return {
    taskGoal: `采集 ${target} 的内容并交付到指定位置`,
    steps: mediaPlan
      ? [
          {
            id: 'discover',
            title: '发现并冻结图片清单',
            advanceOnTools: [
              'browser_collect',
              'browser_task',
              'browser_download'
            ],
            evidenceRequirement: 'collection_manifest',
            status: 'pending'
          },
          {
            id: 'download',
            title: '下载已发现图片到本地目录',
            advanceOnTools: ['browser_download'],
            evidenceRequirement: 'media_download_complete',
            status: 'pending'
          },
          {
            id: 'review',
            title: '复核图片下载数量并向用户交付',
            advanceOnTools: ['browser_task', 'browser_download'],
            evidenceRequirement: 'task_terminal_complete',
            status: 'pending'
          }
        ]
      : [
          {
            id: 'discover',
            title: '发现并冻结条目清单',
            advanceOnTools: ['browser_collect', 'browser_task'],
            evidenceRequirement: 'collection_manifest',
            status: 'pending'
          },
          {
            id: 'collect',
            title: '启动逐项后台采集',
            advanceOnTools: ['browser_collect'],
            evidenceRequirement: 'collection_run',
            status: 'pending'
          },
          {
            id: 'review',
            title: '复核采集结果并向用户交付（核对数量与失败明细）',
            advanceOnTools: ['browser_task'],
            evidenceRequirement: 'task_terminal_complete',
            status: 'pending'
          }
        ],
    verify: 'evidence',
    evidence: {},
    updatedAtMs: nowMs
  }
}

/**
 * Single funnel hook — called for every recorded tool result. Synthesizes the
 * plan on first dispatch and advances the current step on matching results.
 */
export function noteToolResultForActivePlan(
  scope: string | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
  nowMs: number = Date.now(),
  result?: unknown
): void {
  if (!scope) return
  let plan = loadPlan(scope, nowMs)
  if (!plan && COLLECTION_DISPATCH_TOOLS.has(toolName)) {
    plan = deriveCollectionPlanFromToolCall(toolName, args, nowMs)
    if (plan) savePlan(scope, plan)
  }
  if (!plan || !COLLECTION_EVIDENCE_TOOLS.has(toolName)) return
  absorbStructuredEvidence(plan, toolName, args, result)
  advanceEvidenceBackedSteps(plan)
  plan.updatedAtMs = nowMs
  savePlan(scope, plan)
}

export function getActivePlanForScope(scope: string | null | undefined): ActivePlan | null {
  if (!scope) return null
  return loadPlan(scope)
}

export function clearActivePlanForScope(scope: string | null | undefined): void {
  if (!scope) return
  plansByScope.delete(scope)
  removePersistedPlan(scope)
}

export function resetActivePlansForTests(): void {
  plansByScope.clear()
}

function missingEvidenceText(step: ActivePlanStep, evidence: ActivePlanEvidence): string {
  const missing: string[] = []
  if (step.evidenceRequirement === 'collection_manifest') {
    if (!evidence.discoveryTaskId) missing.push('发现任务句柄')
    if (evidence.discoveryStatus !== 'completed') missing.push('发现任务完成状态')
    if (!evidence.expectedCount) missing.push('非空冻结清单数量')
  } else if (step.evidenceRequirement === 'collection_run') {
    if (!evidence.discoveryTaskId) missing.push('已验证的发现任务')
    if (!evidence.executionTaskId) missing.push('新的后台执行任务句柄')
    if (!evidence.executionStatus || !TRACKABLE_TASK_STATUSES.has(evidence.executionStatus)) {
      missing.push('可追踪任务状态')
    }
  } else if (step.evidenceRequirement === 'media_download_complete') {
    if (!evidence.mediaComplete) {
      if (evidence.mediaOk !== true) missing.push('下载成功状态')
      if (evidence.mediaCompletion !== 'complete') missing.push('完整完成标记')
      if (!evidence.expectedCount) missing.push('冻结清单数量')
      if (evidence.savedCount !== evidence.expectedCount) missing.push('与清单相等的已保存数')
      if (evidence.failedCount !== 0) missing.push('失败数为 0')
      if (evidence.remainingCount !== 0) missing.push('剩余数为 0')
    }
  } else {
    const expectedTaskId =
      evidence.executionTaskId || (evidence.mediaComplete ? evidence.discoveryTaskId : undefined)
    if (!expectedTaskId) missing.push('待复核任务句柄')
    if (evidence.reviewedTaskId !== expectedTaskId) missing.push('绑定句柄的查询结果')
    if (evidence.reviewStatus !== 'completed') missing.push('任务完成状态')
    if (evidence.reviewSavedCount !== evidence.expectedCount) missing.push('完整已保存数')
    if (evidence.reviewFailedCount !== 0) missing.push('失败数为 0')
    if (evidence.reviewRemainingCount !== 0) missing.push('剩余数为 0')
  }
  return missing.length > 0 ? missing.join('、') : '可核对的结构化结果'
}

export function buildActivePlanReminderText(
  scope: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (!scope) return null
  const plan = loadPlan(scope, nowMs)
  if (!plan) return null
  if (nowMs - plan.updatedAtMs > ACTIVE_PLAN_TTL_MS) return null
  const total = plan.steps.length
  const doneTitles = plan.steps.filter((step) => step.status === 'done').map((step) => step.title)
  const current = plan.steps.find((step) => step.status === 'pending')
  if (!current) {
    return [
      `[活动计划] 目标：${plan.taskGoal}。`,
      `全部 ${total} 步已由结构化证据验证。请按已核对的交付物与失败明细向用户收口，不要重新规划。`
    ].join('')
  }
  const currentIndex = plan.steps.indexOf(current) + 1
  return [
    `[活动计划] 目标：${plan.taskGoal}。`,
    `当前步骤 ${currentIndex}/${total}：${current.title}`,
    `（当前缺少：${missingEvidenceText(current, plan.evidence)}）。`,
    doneTitles.length > 0 ? `已完成：${doneTitles.join('、')}。` : '',
    '请按计划推进当前步骤，不要跳步、不要重新规划、不要只口头宣布。'
  ].join('')
}
