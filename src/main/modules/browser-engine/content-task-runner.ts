import { BrowserCapabilityService } from './capability-service'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskKind,
  BrowserCapabilityTaskStatus,
  BrowserResearchBundle,
  BrowserStartTaskRequest,
  BrowserStructuredItem,
} from './capability-types'
import { BrowserTaskPersistenceService } from './task-persistence-service'
import { isTaskEventBridgeStatus, taskEventBridge } from './task-event-bridge'
import {
  DEFAULT_VISIBLE_COLLECT_LIMITS,
  DISCOVERY_ESCALATION_LOADING_GONE_JS,
  DISCOVERY_ESCALATION_TIMEOUT_MS,
  VisibleCollectDeduper,
  evaluateStop,
  runDiscoveryEscalationProbe,
  type VisibleCollectItem,
  type VisibleCollectLimits,
} from './agent-browser-collect'
import { getBrowserWriteLeaseService } from './agent-browser-lease-singleton'
import { isAgentBrowserError, type AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import {
  inferCollectionFailureRetryable,
  normalizeCollectionLoopState,
  retryableCollectionFailures,
  parseCollectionPlan,
  type CollectionLoopState,
  type CollectionPlan,
} from './agent-collection-plan'
import { runBrowserCollection } from './browser-collector-engine'
import type { NoteCollectFacade } from './browser-collector-actions'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import { deriveCollectionTargets, type BrowserCollectionTarget } from './collection-targets'
import { resolveCollectionVerdict } from './collection-verdict'
import type { BrowserAgentRuntime } from './agent-runtime-adapter'
import { BrowserPageStateService, normalizeEmptyPageDiagnostic, type BrowserEmptyPageDiagnostic } from './page-state-service'

/**
 * Per-task collector binding (plan §3.4). The controller provides this factory
 * (it owns executeBrowserTool + the AgentTabControlGate); the runner stays
 * decoupled from tools/ and only sees the NoteCollectFacade + a freeze probe.
 */
export interface CollectorFacadeBundle {
  facade: NoteCollectFacade
  isControlFrozen: () => boolean
  releaseLayoutLock?: () => void
}
export type CollectorFacadeFactory = (opts: {
  agentTabId: string
  leaseId: string
  surface: AgentBrowserSurface
}) => CollectorFacadeBundle

/**
 * Minimal projection input the runner emits for a note_collect task (plan §3).
 * The runtime-backed sink (wired in setupAgentIPC) maps this onto a full
 * TaskProjectionRecord, so browser-engine stays decoupled from agent-control.
 */
export interface BrowserTaskProjectionInput {
  taskId: string
  sourceTaskId?: string
  scopeId: string
  title: string
  summary: string
  state: 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  publicStatus?: 'paused_verification' | 'partial' | 'completed' | 'failed' | 'cancelled'
  waitingFor?: 'verification' | 'background' | 'none'
  total: number
  completed: number
  failed: number
  discovered?: number
  userExpectedTotal?: number
  saved?: number
  remaining?: number
  hasMoreLikely?: boolean
  completedSourceIds?: string[]
  failedSourceIds?: string[]
  terminalDwell?: boolean
  /** EP2 dogfood — progress-only refresh: update the EXISTING projection in
   *  place (status untouched) so download write-backs move the card numbers
   *  even when no status transition fires an event. */
  refreshOnly?: boolean
}
export interface BrowserTaskProjectionSink {
  upsert(input: BrowserTaskProjectionInput): void
}

function noteCollectState(status: string): BrowserTaskProjectionInput['state'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'paused' || status === 'waiting_human') return 'paused'
  return 'running'
}

function shouldReprojectBrowserCollectTask(status: BrowserCapabilityTaskHandle['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'paused' || status === 'waiting_human'
}

function shouldReprojectLinkedTerminalCollectionTask(status: BrowserCapabilityTaskHandle['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function noteCollectSummary(total: number, completed: number, failed: number, current: string | null, state: BrowserTaskProjectionInput['state']): string {
  if (state === 'completed') return `采集完成：成功 ${completed}${failed > 0 ? ` · 失败 ${failed}` : ''}，共 ${total} 篇`
  if (state === 'paused') return `采集已暂停：成功 ${completed}/${total}${failed > 0 ? ` · 失败 ${failed}` : ''}，等待验证或继续`
  if (state === 'cancelled') return `已中断：已采集 ${completed}/${total} 篇`
  if (state === 'failed') return `采集失败：已采集 ${completed}/${total} 篇`
  return `已采集 ${completed}/${total} 篇${current ? ` · 当前：${current}` : ''}`
}

function visibleCollectSummary(total: number, current: string | null, state: BrowserTaskProjectionInput['state'], opts?: { hasMoreLikely?: boolean; userExpectedTotal?: number; mediaOnly?: boolean }): string {
  const expected = opts?.userExpectedTotal && opts.userExpectedTotal > 0 ? opts.userExpectedTotal : null
  const incomplete = opts?.hasMoreLikely === true || (expected !== null && total < expected)
  const expectedSuffix = expected !== null ? ` / 用户目标 ${expected}` : ''
  if (opts?.mediaOnly) {
    if (state === 'completed' && !incomplete) return `图片发现完成：已找到 ${total} 张${expectedSuffix}；等待下载到本地`
    if (state === 'completed') return `图片发现未完整：已找到 ${total} 张${expectedSuffix}，可能还有更多；等待下载到本地`
    if (state === 'paused') return `图片发现已暂停：已找到 ${total} 张${expectedSuffix}，可能还没到底；等待继续发现或下载已发现图片`
    if (state === 'cancelled') return `图片采集已中断：已找到 ${total} 张`
    if (state === 'failed') return `图片采集失败：已找到 ${total} 张`
    return `正在发现页面图片${current ? ` · ${current}` : ''}`
  }
  if (state === 'completed' && !incomplete) return `可见页面发现完成：已冻结 ${total} 条${expectedSuffix}；尚未开始逐篇保存`
  if (state === 'completed') return `可见页面发现未完整：已冻结 ${total} 条${expectedSuffix}，可能还有更多；尚未开始逐篇保存`
  if (state === 'paused') return `可见页面发现已暂停：已冻结 ${total} 条${expectedSuffix}，可能还没到底；尚未开始逐篇保存`
  if (state === 'cancelled') return `可见页面采集已中断：已找到 ${total} 条`
  if (state === 'failed') return `可见页面采集失败：已找到 ${total} 条`
  return `正在发现页面目标${current ? ` · ${current}` : ''}`
}

function toNumberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function resultObject(task: BrowserCapabilityTaskHandle | null): Record<string, unknown> | null {
  return task?.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
}

function browserToolErrorCode(output: string): string | null {
  try {
    const parsed = JSON.parse(output)
    return isAgentBrowserError(parsed) ? parsed.errorCode : null
  } catch {
    return null
  }
}

function sourceTaskIdFromPayload(payload: Record<string, unknown> | null | undefined): string | undefined {
  const plan = payload?.plan && typeof payload.plan === 'object' ? payload.plan as Record<string, unknown> : null
  const sourceTaskId = String(plan?.sourceTaskId || '').trim()
  return sourceTaskId || undefined
}

function sourceIdsFromOutputs(outputs: Array<{ sourceId?: string; success?: boolean }> | null | undefined): {
  completedSourceIds: string[]
  failedSourceIds: string[]
} {
  const completedSourceIds = new Set<string>()
  const failedSourceIds = new Set<string>()
  for (const output of outputs || []) {
    const sourceId = String(output?.sourceId || '').trim()
    if (!sourceId) continue
    if (output.success) completedSourceIds.add(sourceId)
    else failedSourceIds.add(sourceId)
  }
  return {
    completedSourceIds: Array.from(completedSourceIds),
    failedSourceIds: Array.from(failedSourceIds),
  }
}

function discoveryStatusFor(stopReason: string): 'complete' | 'partial' | 'paused' {
  if (stopReason === 'no_new_content') return 'complete'
  if (stopReason === 'cancelled' || stopReason === 'lease_lost') return 'paused'
  return 'partial'
}

function visibleCollectFrozenCount(items: BrowserStructuredItem[], template: string): number {
  if (template === 'image_gallery') return mediaCandidatesFromVisibleItems(items).length
  return deriveCollectionTargets(items).length
}

function mediaCandidatesFromVisibleItems(items: BrowserStructuredItem[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: unknown): void => {
    const url = String(value || '').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    out.push(url)
  }
  for (const item of items) {
    const record = item as unknown as Record<string, unknown>
    if (Array.isArray(record.media)) {
      for (const value of record.media) push(value)
    }
    push(record.link)
    push(record.image)
    const rawFields = record.rawFields && typeof record.rawFields === 'object'
      ? record.rawFields as Record<string, unknown>
      : null
    push(rawFields?.link)
    push(rawFields?.image)
    if (Array.isArray(rawFields?.media)) {
      for (const value of rawFields.media) push(value)
    }
  }
  return out
}

function visibleCollectResult(taskId: string, items: BrowserStructuredItem[], rounds: number, stopReason: string, targetUrl: string, outputRootDir: unknown, userExpectedTotal?: number, template = 'card_list') {
  const noteCandidates = deriveCollectionTargets(items)
  const mediaCandidates = template === 'image_gallery' ? mediaCandidatesFromVisibleItems(items) : []
  const frozenCount = visibleCollectFrozenCount(items, template)
  const rawDiscoveryStatus = discoveryStatusFor(stopReason)
  const emptyComplete = frozenCount === 0 && rawDiscoveryStatus === 'complete'
  const expectedIncomplete = Boolean(userExpectedTotal && userExpectedTotal > 0 && frozenCount < userExpectedTotal)
  const discoveryStatus = rawDiscoveryStatus === 'complete' && (expectedIncomplete || emptyComplete) ? 'partial' : rawDiscoveryStatus
    const canStartNoteCollect = discoveryStatus === 'complete'
    const outputDir = typeof outputRootDir === 'string' && outputRootDir.trim() ? outputRootDir.trim() : ''
    return {
      items,
      template,
      rounds,
    stopReason,
    targetUrl,
    discoveryStatus,
    hasMoreLikely: discoveryStatus !== 'complete',
    ...(userExpectedTotal && userExpectedTotal > 0 ? { userExpectedTotal } : {}),
    frozenCount,
    noteCandidates,
    candidateCount: noteCandidates.length,
    ...(template === 'image_gallery'
      ? {
          mediaCandidates,
          mediaCandidateCount: mediaCandidates.length,
        }
      : {}),
    sourceTaskId: taskId,
    ...(outputDir
      ? { outputRootDir: outputDir }
      : {}),
    ...(discoveryStatus !== 'complete' ? { continueTaskId: taskId } : {}),
    ...(discoveryStatus !== 'complete'
      ? {
          suggestedContinueTool: {
            name: 'browser_resume_task',
            args: { task_id: taskId },
          },
        }
      : {}),
    ...(canStartNoteCollect && noteCandidates.length > 0
      ? {
          suggestedNextTool: {
            name: 'browser_collect_notes',
            args: {
              target_profile_url: targetUrl,
              source_task_id: taskId,
              expected_count: noteCandidates.length,
              ...(typeof outputRootDir === 'string' && outputRootDir.trim()
                ? { output_root_dir: outputRootDir.trim() }
                : {}),
            },
          },
        }
      : {}),
    ...(canStartNoteCollect && template === 'image_gallery' && mediaCandidates.length > 0
      ? {
          suggestedNextTool: {
            name: 'browser_download_collected_media',
            args: {
              source_task_id: taskId,
              ...(outputDir ? { directory: outputDir } : {}),
              filename_prefix: 'image',
            },
            ...(outputDir ? {} : { requires: ['directory'] }),
          },
        }
      : {}),
  }
}

function pageStateRuntimeFromCapabilityService(capabilityService: BrowserCapabilityService): BrowserAgentRuntime | null {
  const host = (capabilityService as unknown as {
    host?: {
      executeJS?: (tabId: string | null, code: string) => Promise<unknown>
      getActiveTab?: () => { id?: string; url?: string; title?: string; domain?: string } | undefined
    }
  }).host
  if (!host || typeof host.executeJS !== 'function' || typeof host.getActiveTab !== 'function') return null
  return {
    executeJS: (tabId, code) => host.executeJS?.(tabId, code) ?? Promise.resolve(null),
    getActiveTab: () => {
      const active = host.getActiveTab?.()
      if (!active) return undefined
      const url = String(active.url || '')
      let domain = String(active.domain || '')
      if (!domain && url) {
        try {
          domain = new URL(url).hostname
        } catch {
          domain = ''
        }
      }
      return {
        id: String(active.id || ''),
        url,
        title: String(active.title || ''),
        domain,
        active: true,
      }
    },
  } as BrowserAgentRuntime
}

async function probeVisibleCollectEmptyDiagnostics(
  capabilityService: BrowserCapabilityService,
  params: { targetUrl: string; itemSelector?: string; template: string },
): Promise<BrowserEmptyPageDiagnostic> {
  const provider = capabilityService as BrowserCapabilityService & {
    probeEmptyPageDiagnostic?: (params: { targetUrl?: string; itemSelector?: string; template?: string }) => Promise<unknown>
  }
  if (typeof provider.probeEmptyPageDiagnostic === 'function') {
    try {
      return normalizeEmptyPageDiagnostic(await provider.probeEmptyPageDiagnostic(params))
    } catch {
      return normalizeEmptyPageDiagnostic({ reason: 'selector_mismatch', evidence: ['empty_diagnostic_probe_failed'] })
    }
  }
  const runtime = pageStateRuntimeFromCapabilityService(capabilityService)
  if (runtime) {
    try {
      return await new BrowserPageStateService(runtime).probeEmptyPageDiagnostic(params)
    } catch {
      return normalizeEmptyPageDiagnostic({ reason: 'selector_mismatch', evidence: ['empty_diagnostic_probe_failed'] })
    }
  }
  return normalizeEmptyPageDiagnostic({
    reason: params.itemSelector ? 'selector_mismatch' : 'empty_list',
    evidence: ['visible_collect_empty_result'],
  })
}

function completedAllExpected(expected: number, completed: number, failed: number, stopReason: string | null): boolean {
  return stopReason === 'completed' && expected > 0 && completed === expected && failed === 0
}

const TERMINAL_NOTE_SKIP_REASONS = new Set(['skipped_video', 'unavailable'])
export interface BrowserTaskFailedItem {
  url: string
  reason: string
  attempts: number
  retryable: boolean
}

export function normalizeBrowserTaskFailedItems(value: unknown): BrowserTaskFailedItem[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const reason = String(record.reason || record.error || record.message || 'unknown').trim() || 'unknown'
    const attempts = Number(record.attempts)
    const explicitRetryable = typeof record.retryable === 'boolean' ? record.retryable : null
    return {
      url: String(record.url || record.canonicalUrl || record.openUrl || record.sourceUrl || '').trim(),
      reason,
      attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1,
      retryable: explicitRetryable ?? inferFailureRetryable(reason),
    }
  })
}

export function inferFailureRetryable(reason: string): boolean {
  return inferCollectionFailureRetryable(reason)
}

function finalNoteCollectError(
  expected: number,
  completed: number,
  failed: number,
  stopReason: string | null,
  failures: Array<{ reason?: string }> = [],
): string | null {
  if (completedAllExpected(expected, completed, failed, stopReason)) return null
  if (
    stopReason === 'completed' &&
    expected > 0 &&
    completed + failed === expected &&
    failures.length === failed &&
    failures.every((item) => TERMINAL_NOTE_SKIP_REASONS.has(String(item.reason || '')))
  ) {
    return null
  }
  if (stopReason === 'cancelled' || stopReason === 'lease_lost' || stopReason === 'needs_verification') return null
  return `collection incomplete: expected ${expected}, collected ${completed}, failed ${failed}, stopReason ${stopReason || 'unknown'}`
}

function publicNoteCollectStatus(taskStatus: BrowserCapabilityTaskHandle['status'], collected: number): 'completed' | 'partial' | 'paused_verification' | 'failed' | 'cancelled' {
  if (taskStatus === 'completed') return 'completed'
  if (taskStatus === 'waiting_human') return 'paused_verification'
  if (taskStatus === 'cancelled') return 'cancelled'
  if (collected > 0) return 'partial'
  return 'failed'
}

export function normalizeHighControlCollectionPlan(plan: CollectionPlan): CollectionPlan {
  const isHighControl = isHighControlPlatformText(plan.targetProfileUrl) || plan.notes.some((n) => isHighControlPlatformText(n.url))
  if (!isHighControl) return plan
  const isCardLoop = plan.strategy === 'card_loop'
  return {
    ...plan,
    stopConditions: {
      ...plan.stopConditions,
      maxDurationMs: Math.min(plan.stopConditions?.maxDurationMs ?? 20 * 60_000, 20 * 60_000),
      maxConsecutiveFailures: Math.min(plan.stopConditions?.maxConsecutiveFailures ?? (isCardLoop ? 8 : 3), isCardLoop ? 8 : 3),
    },
  }
}

async function writeCollectionSummaryArtifacts(args: {
  plan: CollectionPlan
  taskId: string
  taskStatus: BrowserCapabilityTaskHandle['status']
  state: CollectionLoopState
  rounds: number
  stopReason: string | null
  sourceTaskId?: string
}): Promise<{ collectionManifestPath?: string; collectionReportPath?: string }> {
  const { plan, taskId, taskStatus, state, rounds, stopReason, sourceTaskId } = args
  const outputRootDir = plan.outputRootDir
  if (!outputRootDir) return {}
  await mkdir(outputRootDir, { recursive: true })
  const remaining = plan.notes.slice(state.cursor).map((note, index) => ({
    order: note.order ?? state.cursor + index + 1,
    url: note.canonicalUrl || note.url,
    openUrl: note.openUrl || note.url,
    title: note.title,
    sourceId: note.sourceId,
  }))
  const status = publicNoteCollectStatus(taskStatus, state.collected.length)
  const manifestPath = join(outputRootDir, 'collection-manifest.json')
  const reportPath = join(outputRootDir, '采集报告.md')
  const manifest = {
    taskId,
    status,
    taskStatus,
    targetProfileUrl: plan.targetProfileUrl,
    expectedCount: plan.expectedCount ?? plan.notes.length,
    total: plan.notes.length,
    completed: state.collected.length,
    failed: state.failed.length,
    remaining: remaining.length,
    resumeFromCursor: state.cursor,
    rounds,
    stopReason,
    outputRootDir,
    sourceTaskId,
    notes: state.outputs,
    failures: state.failed,
    remainingTargets: remaining,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  const successfulLines = state.outputs.filter((item) => item.success).map((item) => {
    const videoCount = Number(item.videoCount || 0)
    const label = videoCount > 0 ? `${videoCount} 个视频` : `${item.imageCount} 张`
    return `- ${item.order ?? ''} ${item.title || item.url}：${label}`
  })
  const failedLines = state.failed.map((item) => `- ${item.url}：${item.reason}`)
  const remainingLines = remaining.map((item) => `- ${item.order} ${item.title || item.url}`)
  const report = [
    '# 采集报告',
    '',
    `任务状态：${status}`,
    `目标总数：${plan.notes.length}`,
    `成功：${state.collected.length}`,
    `失败：${state.failed.length}`,
    `剩余：${remaining.length}`,
    `停止原因：${stopReason || 'unknown'}`,
    `输出目录：${outputRootDir}`,
    '',
    '## 成功结果',
    '',
    ...(successfulLines.length > 0 ? successfulLines : ['无']),
    '',
    '## 失败或待处理',
    '',
    ...(failedLines.length > 0 ? failedLines : ['无']),
    '',
    '## 剩余目标',
    '',
    ...(remainingLines.length > 0 ? remainingLines : ['无']),
    '',
  ].join('\n')
  await writeFile(reportPath, report, 'utf8')
  return { collectionManifestPath: manifestPath, collectionReportPath: reportPath }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
}

function publishBrowserTaskEvent(taskId: string, status: BrowserCapabilityTaskStatus, extra?: unknown): void {
  if (!isTaskEventBridgeStatus(status)) return
  taskEventBridge.publish(extra === undefined ? { taskId, status } : { taskId, status, extra })
}

export class BrowserContentTaskRunner {
  private activeRuns = new Map<string, Promise<void>>()
  private cancelledTasks = new Set<string>()

  constructor(
    private readonly capabilityService: BrowserCapabilityService,
    private readonly persistenceService = new BrowserTaskPersistenceService(),
    private readonly leaseService: BrowserWriteLeaseService = getBrowserWriteLeaseService(),
    private readonly collectorFacadeFactory: CollectorFacadeFactory | null = null,
  ) {}

  /** Set/replace the projection sink and re-project active note_collect tasks. */
  setTaskProjectionSink(sink: BrowserTaskProjectionSink | null): void {
    this.taskProjectionSink = sink
    // §3.6: resumePendingTasks runs in the controller constructor, before the
    // sink is wired — re-project active browser collection tasks now so chat cards
    // appear for tasks that were already running/resumed when the sink arrived.
    if (sink) void this.reprojectActiveBrowserCollect()
  }

  private taskProjectionSink: BrowserTaskProjectionSink | null = null

  private async reprojectActiveBrowserCollect(): Promise<void> {
    const sink = this.taskProjectionSink
    if (!sink) return
    const tasks = (await this.listTasks()).slice().sort((a, b) => {
      const aTime = new Date(a.updatedAt || 0).getTime()
      const bTime = new Date(b.updatedAt || 0).getTime()
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0)
    })
    const projectedSourceTaskIds = new Set<string>()
    for (const task of tasks) {
      if (task.kind !== 'note_collect' && task.kind !== 'visible_collect' && task.kind !== 'card_loop') continue
      const payload = this.persistenceService.getTaskPayload(task.taskId)
      const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
      if (!scopeId) continue
      const state = noteCollectState(task.status)
      const { total, completed, failed, currentLabel } = task.progress
      if (task.kind === 'note_collect' || task.kind === 'card_loop') {
        const sourceTaskId = sourceTaskIdFromPayload(payload)
        const shouldProject = shouldReprojectBrowserCollectTask(task.status)
          || (sourceTaskId && shouldReprojectLinkedTerminalCollectionTask(task.status))
        if (!shouldProject) continue
        if (sourceTaskId && projectedSourceTaskIds.has(sourceTaskId)) continue
        sink.upsert({
          taskId: task.taskId,
          sourceTaskId,
          scopeId,
          title: task.kind === 'card_loop' ? '浏览器逐张点开采集' : '浏览器逐篇采集',
          summary: noteCollectSummary(total, completed, failed, currentLabel ?? null, state),
          state,
          total,
          completed,
          failed,
          waitingFor: task.status === 'waiting_human' ? 'verification' : undefined,
          publicStatus: publicNoteCollectStatus(task.status, completed),
          terminalDwell: shouldReprojectLinkedTerminalCollectionTask(task.status) ? false : undefined,
        })
        if (sourceTaskId) projectedSourceTaskIds.add(sourceTaskId)
      } else {
        if (!shouldReprojectBrowserCollectTask(task.status)) continue
        if (projectedSourceTaskIds.has(task.taskId)) continue
        const result = resultObject(task)
        const template = String(payload?.template || result?.template || '')
        this.projectVisibleCollect(task.taskId, scopeId, state, total, currentLabel ?? null, {
          hasMoreLikely: result?.hasMoreLikely === true,
          userExpectedTotal: Number(result?.userExpectedTotal || payload?.userExpectedTotal || 0) || undefined,
          mediaOnly: template === 'image_gallery' || Number(result?.mediaCandidateCount || 0) > 0,
        })
      }
    }
  }

  /** Emit a projection for a note_collect task (no-op without sink or scopeId). */
  private projectNoteCollect(
    taskId: string,
    scopeId: string,
    state: BrowserTaskProjectionInput['state'],
    total: number,
    completed: number,
    failed: number,
    current: string | null,
    opts?: {
      waitingFor?: BrowserTaskProjectionInput['waitingFor']
      publicStatus?: BrowserTaskProjectionInput['publicStatus']
      sourceTaskId?: string
      title?: string
      completedSourceIds?: string[]
      failedSourceIds?: string[]
    },
  ): void {
    const sink = this.taskProjectionSink
    if (!sink || !scopeId) return
    const sourceTaskId = opts?.sourceTaskId ?? sourceTaskIdFromPayload(this.persistenceService.getTaskPayload(taskId))
    sink.upsert({
      taskId,
      sourceTaskId,
      scopeId,
      title: opts?.title || '浏览器逐篇采集',
      summary: noteCollectSummary(total, completed, failed, current, state),
      state,
      waitingFor: opts?.waitingFor ?? (state === 'running' ? 'background' : 'none'),
      publicStatus: opts?.publicStatus,
      total,
      completed,
      failed,
      saved: completed,
      remaining: Math.max(0, total - completed - failed),
      completedSourceIds: opts?.completedSourceIds,
      failedSourceIds: opts?.failedSourceIds,
    })
  }

  private projectVisibleCollect(
    taskId: string,
    scopeId: string,
    state: BrowserTaskProjectionInput['state'],
    total: number,
    current: string | null,
    opts?: { hasMoreLikely?: boolean; userExpectedTotal?: number; mediaOnly?: boolean },
  ): void {
    const sink = this.taskProjectionSink
    if (!sink || !scopeId) return
    sink.upsert({
      taskId,
      scopeId,
      title: opts?.mediaOnly ? '浏览器图片采集' : '浏览器可见页面采集',
      summary: visibleCollectSummary(total, current, state, opts),
      state,
      waitingFor: state === 'running' ? 'background' : 'none',
      total,
      completed: 0,
      failed: 0,
      discovered: total,
      saved: 0,
      remaining: total,
      hasMoreLikely: opts?.hasMoreLikely,
      userExpectedTotal: opts?.userExpectedTotal,
    })
  }

  async startTask(request: BrowserStartTaskRequest): Promise<BrowserCapabilityTaskHandle> {
    const handle = this.persistenceService.createTask(request)
    this.scheduleTask(handle.taskId, request.kind, request.payload)
    return this.persistenceService.getTask(handle.taskId) || handle
  }

  async getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.persistenceService.getTask(taskId)
  }

  createSyntheticVisibleCollection(params: {
    scopeId?: string
    targets: BrowserCollectionTarget[]
    targetUrl?: string
    outputRootDir?: string
    sourceMessageIds?: string[]
  }): BrowserCapabilityTaskHandle {
    const handle = this.persistenceService.createTask({
      kind: 'visible_collect',
      payload: {
        synthetic: true,
        source: 'user_provided_urls',
        targetUrl: params.targetUrl || undefined,
        outputRootDir: params.outputRootDir || undefined,
        sourceMessageIds: params.sourceMessageIds || [],
        ...(params.scopeId && params.scopeId.trim() ? { scopeId: params.scopeId.trim() } : {}),
      },
    })
    const targets = params.targets.map((target, index) => ({ ...target, order: index + 1 }))
    const result = {
      status: 'completed',
      synthetic: true,
      source: 'user_provided_urls',
      discoveryStatus: 'complete',
      frozenCount: targets.length,
      noteCandidates: targets,
      targetUrl: params.targetUrl || '',
      outputRootDir: params.outputRootDir || '',
      sourceMessageIds: params.sourceMessageIds || [],
      hasMoreLikely: false,
      summary: `用户直接提供 URL 列表，已合成冻结清单 ${targets.length} 条。`,
    }
    this.persistenceService.updateProgress(handle.taskId, {
      total: targets.length,
      completed: 0,
      failed: 0,
      currentLabel: null,
    }, {
      status: 'completed',
      checkpoint: { taskId: handle.taskId, stage: 'visible_collect_round', cursor: null, partialResults: [] },
      result,
      finishedAt: new Date().toISOString(),
    })
    publishBrowserTaskEvent(handle.taskId, 'completed')
    if (params.scopeId) {
      this.projectVisibleCollect(handle.taskId, params.scopeId, 'completed', targets.length, null, { hasMoreLikely: false })
    }
    return this.persistenceService.getTask(handle.taskId) || handle
  }

  /** All known tasks when the persistence layer supports it, optionally filtered to one kind. */
  async listTasks(kind?: BrowserCapabilityTaskKind): Promise<BrowserCapabilityTaskHandle[]> {
    const persistence = this.persistenceService as BrowserTaskPersistenceService & {
      listTasks?: () => BrowserCapabilityTaskHandle[]
    }
    const tasks = typeof persistence.listTasks === 'function'
      ? persistence.listTasks()
      : this.persistenceService.listPendingTasks()
    return kind ? tasks.filter((task) => task.kind === kind) : tasks
  }

  getTaskPayload(taskId: string): Record<string, unknown> | null {
    return this.persistenceService.getTaskPayload(taskId)
  }

  /** EP2 dogfood gap 3 — download results flow BACK onto the source
   *  collection task so the card's numbers move: discovered/saved/failed
   *  land in the browser_tasks progress columns (execution-ledger owner =
   *  browser-engine per the ownership matrix) and the result payload. */
  async recordCollectedMediaDownload(taskId: string, summary: {
    discovered: number
    saved: number
    failed: number
    remaining: number
    directory: string
    expectedTotal?: number | null
  }): Promise<BrowserCapabilityTaskHandle | null> {
    const task = await this.getTask(taskId)
    if (!task) return null
    const result = {
      ...(task.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : {}),
      mediaDownload: summary,
    }
    const updated = this.persistenceService.updateProgress(taskId, {
      total: summary.discovered,
      completed: summary.saved,
      failed: summary.failed,
    }, { result })
    // EP2 dogfood follow-up — the ledger write alone never refreshes the
    // chat card (updateProgress only emits on STATUS change). Re-upsert the
    // projection directly so saved/failed/remaining move on screen, with
    // the page-claimed total preferred over the discovered count.
    try {
      const payload = this.persistenceService.getTaskPayload(taskId)
      const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
      const sourceResult = resultObject(task)
      const claimed = Number(summary.expectedTotal ?? sourceResult?.userExpectedTotal ?? payload?.userExpectedTotal ?? 0) || 0
      if (scopeId && this.taskProjectionSink) {
        this.taskProjectionSink.upsert({
          taskId: `${taskId}#media-download`,
          sourceTaskId: taskId,
          scopeId,
          title: '图片采集',
          summary: `已保存 ${summary.saved} 张${summary.failed > 0 ? ` · 失败 ${summary.failed}` : ''}${summary.remaining > 0 ? ` · 剩余 ${summary.remaining}` : ''}`,
          state: 'completed',
          refreshOnly: true,
          total: summary.discovered,
          completed: summary.saved,
          failed: summary.failed,
          discovered: summary.discovered,
          saved: summary.saved,
          remaining: summary.remaining,
          ...(claimed > 0 ? { userExpectedTotal: claimed } : {}),
        })
      }
    } catch { /* projection refresh must not fail the ledger write */ }
    return updated
  }

  updateTaskPayload(taskId: string, payload: Record<string, unknown>): void {
    this.persistenceService.updateTaskPayload(taskId, payload)
  }

  async resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    const current = this.persistenceService.getTask(taskId)
    const payload = this.persistenceService.getTaskPayload(taskId)
    if (!current || !payload) return null
    if (current.status === 'completed' || current.status === 'failed') return current
    this.cancelledTasks.delete(taskId)
    this.prepareFailureLedgerResume(current, payload)
    this.scheduleTask(taskId, current.kind, payload)
    return this.persistenceService.getTask(taskId)
  }

  private prepareFailureLedgerResume(task: BrowserCapabilityTaskHandle, payload: Record<string, unknown>): void {
    if (task.kind !== 'note_collect' && task.kind !== 'card_loop') return
    const checkpoint = task.checkpoint
    if (checkpoint?.stage !== 'note_collect_round' || !checkpoint.partialResults) return
    const parsed = parseCollectionPlan(payload.plan)
    if (!parsed.ok) return
    const state = normalizeCollectionLoopState(checkpoint.partialResults as CollectionLoopState)
    const retryFailures = retryableCollectionFailures(state)
    if (retryFailures.length === 0) return
    this.persistenceService.updateProgress(task.taskId, {}, {
      checkpoint: {
        ...checkpoint,
        cursor: String(state.cursor),
        partialResults: {
          ...state,
          consecutiveFailures: 0,
          startedAt: Date.now(),
          retryCursor: retryFailures.map((item) => item.url),
        },
      },
    })
  }

  async cancelTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    const current = this.persistenceService.getTask(taskId)
    if (current && (current.status === 'completed' || current.status === 'failed' || current.status === 'waiting_human')) {
      return current
    }
    this.cancelledTasks.add(taskId)
    const handle = this.persistenceService.updateProgress(taskId, {}, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
    })
    // Reflect the cancel in the chat card immediately, even if the loop already
    // exited (race) so the terminal projection never fires.
    if (handle?.kind === 'note_collect' || handle?.kind === 'card_loop') {
      const payload = this.persistenceService.getTaskPayload(taskId)
      const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
      const p = handle.progress
      this.projectNoteCollect(taskId, scopeId, 'cancelled', p.total, p.completed, p.failed, null)
    } else if (handle?.kind === 'visible_collect') {
      const payload = this.persistenceService.getTaskPayload(taskId)
      const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
      this.projectVisibleCollect(taskId, scopeId, 'cancelled', handle.progress.total, null, {
        mediaOnly: String(payload?.template || '') === 'image_gallery',
      })
    }
    return handle
  }

  async resumePendingTasks(): Promise<void> {
    for (const task of this.persistenceService.listPendingTasks()) {
      if (task.status === 'paused') continue
      const payload = this.persistenceService.getTaskPayload(task.taskId)
      if (!payload) continue
      if (this.reconcileStartupNoteCollectionTask(task)) continue
      this.scheduleTask(task.taskId, task.kind, payload)
    }
  }

  private reconcileStartupNoteCollectionTask(task: BrowserCapabilityTaskHandle): boolean {
    if (task.kind !== 'note_collect' && task.kind !== 'card_loop') return false
    const checkpoint = task.checkpoint
    const hasSavedCursor = checkpoint?.stage === 'note_collect_round'
      && typeof checkpoint.cursor === 'string'
      && checkpoint.cursor.trim().length > 0
      && checkpoint.partialResults !== undefined
      && checkpoint.partialResults !== null
    if (hasSavedCursor) {
      this.persistenceService.updateProgress(task.taskId, { currentLabel: null }, {
        status: 'paused',
        error: 'note_collect paused on startup; resume from the saved cursor explicitly',
        finishedAt: null,
      })
      publishBrowserTaskEvent(task.taskId, 'paused')
    } else {
      this.cancelledTasks.add(task.taskId)
      this.persistenceService.updateProgress(task.taskId, { currentLabel: null }, {
        status: 'cancelled',
        error: 'note_collect cancelled on startup: missing saved cursor',
        finishedAt: new Date().toISOString(),
      })
    }
    return true
  }

  private scheduleTask(taskId: string, kind: BrowserCapabilityTaskKind, payload: Record<string, unknown>): void {
    taskEventBridge.scheduleTask(taskId, kind)
    if (this.activeRuns.has(taskId)) return
    const run = this.runTask(taskId, kind, payload)
      .catch((error) => {
        this.persistenceService.updateProgress(taskId, {}, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        })
        publishBrowserTaskEvent(taskId, 'failed')
      })
      .finally(() => {
        this.activeRuns.delete(taskId)
      })
    this.activeRuns.set(taskId, run)
  }

  /**
   * Visible-collect loop (counterplan §5.5, WP4): extract current items → dedup
   * across rounds → scroll one screen → checkpoint EVERY round (fixing the
   * legacy "checkpoint only on completion"). Stop conditions are hard budgets
   * via evaluateStop. Resumable from the last cursor via resumePendingTasks.
   */
  private async runVisibleCollect(taskId: string, payload: Record<string, unknown>): Promise<void> {
    const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId.trim() : ''
    // Lease handling (counterplan §5.2/§5.5): the background loop writes the page
    // (scroll), so every round must hold a valid write lease and stop with
    // lease_lost the instant the user takes over or the lease expires.
    //   - inherited leaseId (started from a lane-A run that holds the lease):
    //     check + heartbeat it, do NOT acquire/release (the run owns it).
    //   - standalone (no inherited lease, e.g. resumed after restart): acquire
    //     our own user-view lease for the task duration and release at the end.
    const surface = (typeof payload.surface === 'string' ? payload.surface : 'user-view') as AgentBrowserSurface
    const inheritedLeaseId = typeof payload.leaseId === 'string' ? payload.leaseId : null
    let leaseId = inheritedLeaseId
    let ownsLease = false
    if (!leaseId) {
      const acquired = this.leaseService.acquire({ surface, taskId, runId: taskId })
      if (isAgentBrowserError(acquired)) {
        this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
          status: 'failed',
          error: `visible_collect could not acquire ${surface} lease: ${acquired.errorCode}`,
          finishedAt: new Date().toISOString(),
        })
        publishBrowserTaskEvent(taskId, 'failed')
        this.projectVisibleCollect(taskId, scopeId, 'failed', 0, null, {
          mediaOnly: String(payload.template || '') === 'image_gallery',
        })
        return
      }
      leaseId = acquired.leaseId
      ownsLease = true
    }

    try {
      await this.runVisibleCollectLoop(taskId, payload, surface, leaseId)
    } finally {
      if (ownsLease && leaseId) this.leaseService.release(leaseId)
    }
  }

  private async runVisibleCollectLoop(
    taskId: string,
    payload: Record<string, unknown>,
    surface: AgentBrowserSurface,
    leaseId: string,
  ): Promise<void> {
    // Guard BEFORE the first page write: opening/navigating the target page is
    // itself a write. If an inherited lease is already lost (user took over),
    // stop with lease_lost without touching the page (counterplan §5.5).
    if (this.leaseService.checkWrite({ surface, leaseId }) !== null) {
      this.persistenceService.updateProgress(taskId, { total: 0, completed: 0, failed: 0, currentLabel: null }, {
        status: 'paused',
        checkpoint: { taskId, stage: 'visible_collect_round', cursor: null, partialResults: [] },
        result: visibleCollectResult(taskId, [], 0, 'lease_lost', '', payload.outputRootDir, Number(payload.userExpectedTotal || 0) || undefined, String(payload.template || 'card_list')),
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'paused')
      const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId.trim() : ''
      this.projectVisibleCollect(taskId, scopeId, 'paused', 0, null, {
        hasMoreLikely: true,
        userExpectedTotal: Number(payload.userExpectedTotal || 0) || undefined,
        mediaOnly: String(payload.template || 'card_list') === 'image_gallery',
      })
      return
    }

    const targetUrl = String(payload.url || '').trim()
    const requestedTabId = typeof payload.tabId === 'string' ? payload.tabId : null
    const tabId = await (async () => {
      if (!targetUrl) return requestedTabId
      if (requestedTabId) {
        const opened = await this.capabilityService.navigateTargetTab(requestedTabId, targetUrl)
        return opened.success ? opened.tabId || requestedTabId : null
      }
      return (await this.capabilityService.openTarget(targetUrl, 'prefer_reuse')).tabId || null
    })()
    const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId.trim() : ''
    if (targetUrl && requestedTabId && !tabId) {
      this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
        status: 'failed',
        error: `visible_collect could not navigate agent tab: ${requestedTabId}`,
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'failed')
      this.projectVisibleCollect(taskId, scopeId, 'failed', 0, null, {
        mediaOnly: String(payload.template || '') === 'image_gallery',
      })
      return
    }

    const limits: VisibleCollectLimits = {
      maxItems: toNumberOr(payload.maxItems, DEFAULT_VISIBLE_COLLECT_LIMITS.maxItems),
      maxRounds: toNumberOr(payload.maxRounds, DEFAULT_VISIBLE_COLLECT_LIMITS.maxRounds),
      maxExpandsPerRound: toNumberOr(payload.maxExpandsPerRound, DEFAULT_VISIBLE_COLLECT_LIMITS.maxExpandsPerRound),
      maxDurationMs: toNumberOr(payload.maxDurationMs, DEFAULT_VISIBLE_COLLECT_LIMITS.maxDurationMs),
      emptyRoundsToStop: toNumberOr(payload.emptyRoundsToStop, DEFAULT_VISIBLE_COLLECT_LIMITS.emptyRoundsToStop),
    }
    const highControl = payload.highControl === true
    let interRoundDelayMs = 0
    if (highControl) {
      const expectedMinimum = Number(payload.userExpectedTotal || 0) || DEFAULT_VISIBLE_COLLECT_LIMITS.maxItems
      limits.maxItems = Math.max(limits.maxItems, expectedMinimum)
      limits.maxRounds = Math.max(limits.maxRounds, DEFAULT_VISIBLE_COLLECT_LIMITS.maxRounds)
      limits.maxDurationMs = Math.max(limits.maxDurationMs, DEFAULT_VISIBLE_COLLECT_LIMITS.maxDurationMs)
      interRoundDelayMs = 1_200
    }
    const template = String(payload.template || 'card_list') as never
    const itemSelector = typeof payload.itemSelector === 'string' ? payload.itemSelector : undefined

    const deduper = new VisibleCollectDeduper()
    const collected: BrowserStructuredItem[] = []
    const startedAt = Date.now()
    let round = 0
    let consecutiveEmptyRounds = 0
    let stopReason: string = 'no_new_content'

    // Resume: seed from the last round checkpoint so we continue from where we
    // stopped (counterplan §5.5 "恢复后从 checkpoint 继续"), not from scratch.
    const existing = this.persistenceService.getTask(taskId)
    const checkpoint = existing?.checkpoint
    if (checkpoint?.stage === 'visible_collect_round' && Array.isArray(checkpoint.partialResults)) {
      const prior = checkpoint.partialResults as BrowserStructuredItem[]
      for (const item of prior) {
        deduper.addBatch([{ link: item.link, text: item.title || item.summary, containerPath: item.sourceUrl }])
      }
      collected.push(...prior)
      round = Number(checkpoint.cursor || 0) || 0
    }
    const batchStartCount = collected.length
    const batchStartRound = round
    const addFreshItems = (items: BrowserStructuredItem[]): BrowserStructuredItem[] => {
      const freshOriginals: BrowserStructuredItem[] = []
      for (const item of items) {
        const identityInput: VisibleCollectItem = {
          link: item.link,
          text: item.title || item.summary,
          containerPath: item.sourceUrl,
        }
        if (deduper.addBatch([identityInput]).length > 0) {
          freshOriginals.push(item)
        }
      }
      return freshOriginals
    }
    const checkpointVisibleCollect = (label: string): void => {
      const frozenCount = visibleCollectFrozenCount(collected, template)
      this.persistenceService.updateProgress(taskId, {
        total: frozenCount,
        completed: 0,
        failed: 0,
        currentLabel: label,
      }, {
        checkpoint: {
          taskId,
          stage: 'visible_collect_round',
          cursor: String(round),
          partialResults: collected,
        },
      })
      this.projectVisibleCollect(taskId, scopeId, 'running', frozenCount, label, {
        hasMoreLikely: true,
        userExpectedTotal: Number(payload.userExpectedTotal || 0) || undefined,
        mediaOnly: template === 'image_gallery',
      })
    }

    while (true) {
      // Before any page write this round, confirm we still hold the lease; a
      // user takeover or expiry stops the loop with lease_lost (counterplan
      // §5.5). Heartbeat so a long collection does not expire mid-run.
      const leaseDenied = this.leaseService.checkWrite({ surface, leaseId })
      const stop = evaluateStop(
        {
          collectedCount: Math.max(0, collected.length - batchStartCount),
          round: Math.max(0, round - batchStartRound),
          consecutiveEmptyRounds,
          elapsedMs: Date.now() - startedAt,
          cancelled: this.cancelledTasks.has(taskId),
          leaseLost: leaseDenied !== null,
        },
        limits,
      )
      if (stop) {
        if (stop === 'no_new_content') {
          const escalation = await runDiscoveryEscalationProbe<BrowserStructuredItem>({
            scrollViewportOnce: () => this.capabilityService.scrollViewportOnce(tabId),
            readFreshItems: async () => {
              const extracted = await this.capabilityService.extractStructured(tabId, {
                template,
                itemSelector,
                limit: limits.maxItems,
                wait: {
                  condition: 'custom_js',
                  customJs: DISCOVERY_ESCALATION_LOADING_GONE_JS,
                  timeoutMs: DISCOVERY_ESCALATION_TIMEOUT_MS,
                  checkIntervalMs: 250,
                },
              })
              return addFreshItems(extracted.items)
            },
          })
          if (escalation.freshItems.length > 0) {
            round += 1
            consecutiveEmptyRounds = 0
            collected.push(...escalation.freshItems)
            checkpointVisibleCollect(`probe ${round}`)
            continue
          }
        }
        stopReason = stop
        break
      }
      this.leaseService.heartbeat(leaseId)
      round += 1

      const extracted = await this.capabilityService.extractStructured(tabId, {
        template,
        itemSelector,
        limit: limits.maxItems,
      })
      const freshOriginals = addFreshItems(extracted.items)
      if (freshOriginals.length === 0) {
        consecutiveEmptyRounds += 1
      } else {
        consecutiveEmptyRounds = 0
        collected.push(...freshOriginals)
      }

      // Checkpoint EVERY round so a crash/cancel resumes from here.
      checkpointVisibleCollect(`round ${round}`)

      if (this.cancelledTasks.has(taskId)) {
        stopReason = 'cancelled'
        break
      }

      const scroll = await this.capabilityService.scrollViewportOnce(tabId)
      if (scroll.atBottom) {
        // One more extract pass already happened; let an empty round confirm end.
        consecutiveEmptyRounds += 1
      }
      // Pace rounds on high-control platforms (plan §4.4 限速).
      if (interRoundDelayMs > 0 && !this.cancelledTasks.has(taskId)) {
        await new Promise((resolve) => setTimeout(resolve, interRoundDelayMs))
      }
    }

    const userExpectedTotal = Number(payload.userExpectedTotal || 0) || undefined
    const finalResult = visibleCollectResult(taskId, collected, round, stopReason, targetUrl, payload.outputRootDir, userExpectedTotal, template)
    const collectionVerdict = resolveCollectionVerdict({
      collected: Number(finalResult.frozenCount || 0),
      expected: userExpectedTotal,
      stopReason,
      failures: 0,
      cursorValid: round > 0,
    })
    const finalStatus = stopReason === 'cancelled'
      ? 'cancelled'
      : stopReason === 'lease_lost'
        ? 'paused'
        : collectionVerdict.status
    const keepCursor = stopReason === 'lease_lost' || (stopReason !== 'cancelled' && collectionVerdict.keepCursor)
    const finalCheckpointStage = keepCursor
      ? 'visible_collect_round'
      : finalStatus
    const emptyDiagnostics = (
      stopReason !== 'cancelled' &&
      stopReason !== 'lease_lost' &&
      collectionVerdict.verdict === 'needs_attention'
    )
      ? await probeVisibleCollectEmptyDiagnostics(this.capabilityService, { targetUrl, itemSelector, template })
      : null
    const finalResultWithVerdict = stopReason === 'cancelled' || stopReason === 'lease_lost'
      ? finalResult
      : {
          ...finalResult,
          labelKey: collectionVerdict.labelKey,
          verdict: collectionVerdict.verdict,
          ...(emptyDiagnostics ? { emptyDiagnostics } : {}),
        }
    this.persistenceService.updateProgress(taskId, {
      total: Number(finalResult.frozenCount || 0),
      completed: 0,
      failed: 0,
      currentLabel: null,
    }, {
      status: finalStatus,
      checkpoint: {
        taskId,
        stage: finalCheckpointStage,
        cursor: keepCursor ? String(round) : null,
        partialResults: keepCursor ? collected : null,
      },
      result: finalResultWithVerdict,
      finishedAt: new Date().toISOString(),
    })
    publishBrowserTaskEvent(taskId, finalStatus)
    this.projectVisibleCollect(taskId, scopeId, finalStatus, Number(finalResult.frozenCount || 0), null, {
      hasMoreLikely: finalResult.hasMoreLikely === true,
      userExpectedTotal,
      mediaOnly: template === 'image_gallery',
    })
  }

  /**
   * note_collect loop (plan §3.3/§3.4): the background browser-collection
   * sub-agent. Acquires its OWN agent-view lease tied to the agent tab, then
   * runs the deterministic per-note engine through the ScopedBrowserFacade.
   * Decoupled from the chat turn (a background task), so a preempting chat run
   * never aborts it; it stops only on its own cancel / lease loss / user freeze.
   */
  private async runNoteCollect(taskId: string, payload: Record<string, unknown>): Promise<void> {
    const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId.trim() : ''
    if (!this.collectorFacadeFactory) {
      this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
        status: 'failed',
        error: 'note_collect is not available: no collector facade factory wired',
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'failed')
      this.projectNoteCollect(taskId, scopeId, 'failed', 0, 0, 0, null)
      return
    }
    const agentTabId = typeof payload.agentTabId === 'string' ? payload.agentTabId : ''
    const parsed = parseCollectionPlan(payload.plan)
    if (!agentTabId || !parsed.ok) {
      this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
        status: 'failed',
        error: !agentTabId ? 'note_collect requires an agentTabId' : `invalid collection plan: ${parsed.ok ? '' : parsed.issues.join('; ')}`,
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'failed')
      this.projectNoteCollect(taskId, scopeId, 'failed', 0, 0, 0, null)
      return
    }
    const strategy = parsed.plan.strategy === 'card_loop' ? 'card_loop' : 'url_batch'
    const plan = normalizeHighControlCollectionPlan(parsed.plan)
    const isHighControl = plan !== parsed.plan
    const interNoteDelayMs = isHighControl ? 3_000 : 0
    // Download-volume budget on high-control platforms (Codex result-review #5):
    // a safety ceiling on total images saved across the collection.
    const maxTotalImages = 0

    const surface = (typeof payload.surface === 'string' ? payload.surface : 'agent-view') as AgentBrowserSurface
    const acquired = this.leaseService.acquire({ surface, taskId, runId: taskId, tabId: agentTabId })
    if (isAgentBrowserError(acquired)) {
      this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
        status: 'failed',
        error: `note_collect could not acquire ${surface} lease: ${acquired.errorCode}`,
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'failed')
      this.projectNoteCollect(taskId, scopeId, 'failed', plan.notes.length, 0, 0, null)
      return
    }
    const leaseId = acquired.leaseId
    const { facade, isControlFrozen, releaseLayoutLock } = this.collectorFacadeFactory({ agentTabId, leaseId, surface })
    // Project a running card as soon as the collection starts (plan §3.4).
    this.projectNoteCollect(taskId, scopeId, 'running', plan.notes.length, 0, 0, null)

    try {
      if (strategy === 'card_loop' && plan.targetProfileUrl) {
        const navOut = await facade.run('browser_navigate', { url: plan.targetProfileUrl })
        const navErr = browserToolErrorCode(navOut)
        if (navErr) throw new Error(`card_loop profile navigation failed: ${navErr}`)
        await facade.run('browser_wait', { ms: isHighControl ? 1500 : 500 }).catch(() => '')
      }

      // Resume from the last per-note checkpoint if one exists.
      const existing = this.persistenceService.getTask(taskId)
      const checkpoint = existing?.checkpoint
      const initialState = checkpoint?.stage === 'note_collect_round' && checkpoint.partialResults
        ? (checkpoint.partialResults as CollectionLoopState)
        : undefined

      const result = await runBrowserCollection(
        plan,
        {
          facade,
          pathJoin: (...parts) => join(...parts),
          fileOps: {
            ensureDir: async (path) => { await mkdir(path, { recursive: true }) },
            writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
          },
          now: () => Date.now(),
          interNoteDelayMs,
          maxTotalImages,
          strategy,
          shouldStop: () => {
            if (this.cancelledTasks.has(taskId)) return 'cancelled'
            // A user freeze (AgentTabControlGate) stops the agent cleanly, not as
            // a string of write failures. Freeze is NOT a lease state (Codex R2).
            if (surface === 'agent-view' && isControlFrozen()) return 'cancelled'
            // Lease loss (expiry, or a takeover by another surface) stops writing.
            if (this.leaseService.checkWrite({ surface, leaseId }) !== null) return 'lease_lost'
            this.leaseService.heartbeat(leaseId)
            return null
          },
          onProgress: (progress) => {
            this.persistenceService.updateProgress(taskId, {
              total: progress.total,
              completed: progress.completed,
              failed: progress.failed,
              currentLabel: progress.currentTitle,
            })
          },
          onCheckpoint: (state, progress) => {
            this.persistenceService.updateProgress(taskId, {
              total: progress.total,
              completed: progress.completed,
              failed: progress.failed,
              currentLabel: progress.currentTitle,
            }, {
              checkpoint: { taskId, stage: 'note_collect_round', cursor: String(state.cursor), partialResults: state },
            })
            // Live progress in the chat card after every note (plan §3.6).
            this.projectNoteCollect(taskId, scopeId, 'running', progress.total, progress.completed, progress.failed, progress.currentTitle, sourceIdsFromOutputs(state.outputs))
          },
        },
        initialState,
      )

      // cancelTask() (incl. the confirm→cancel path) already wrote 'cancelled';
      // keep it cancelled, but persist the partial result so the task can be
      // inspected/resumed instead of becoming an empty cancelled shell.
      if (this.cancelledTasks.has(taskId)) {
        const artifacts = await writeCollectionSummaryArtifacts({
          plan,
          taskId,
          taskStatus: 'cancelled',
          state: result.state,
          rounds: result.rounds,
          stopReason: result.stopReason,
          sourceTaskId: plan.sourceTaskId,
        }).catch(() => ({}))
        this.persistenceService.updateProgress(taskId, {
          total: plan.notes.length,
          completed: result.collected.length,
          failed: result.failed.length,
          currentLabel: null,
        }, {
          status: 'cancelled',
          checkpoint: { taskId, stage: 'note_collect_round', cursor: String(result.state.cursor), partialResults: result.state },
          result: {
            status: publicNoteCollectStatus('cancelled', result.collected.length),
            collected: result.collected,
            failed: normalizeBrowserTaskFailedItems(result.failed),
            notes: result.notes,
            rounds: result.rounds,
            stopReason: result.stopReason,
            expectedCount: plan.expectedCount ?? plan.notes.length,
            sourceTaskId: plan.sourceTaskId,
            outputRootDir: plan.outputRootDir,
            remaining: Math.max(0, plan.notes.length - result.state.cursor),
            resumeFromCursor: result.state.cursor,
            ...artifacts,
          },
          finishedAt: new Date().toISOString(),
        })
        this.projectNoteCollect(taskId, scopeId, 'cancelled', plan.notes.length, result.collected.length, result.failed.length, null, sourceIdsFromOutputs(result.notes))
        return
      }
      // A user freeze or a lease takeover is NOT a successful completion (Codex
      // result-review #1): reflect the interruption in the task status.
      const failedItems = normalizeBrowserTaskFailedItems(result.failed)
      const incompleteError = finalNoteCollectError(plan.notes.length, result.collected.length, failedItems.length, result.stopReason, failedItems)
      const collectionVerdict = resolveCollectionVerdict({
        collected: result.collected.length,
        expected: plan.expectedCount ?? plan.notes.length,
        stopReason: result.stopReason || 'unknown',
        failures: failedItems.length,
        cursorValid: Number.isFinite(result.state.cursor),
      })
      const completedByTerminalNoteRule = incompleteError === null && result.collected.length > 0
      const finalStatus: BrowserCapabilityTaskHandle['status'] = result.stopReason === 'needs_verification'
        ? 'waiting_human'
        : result.stopReason === 'cancelled'
          ? 'cancelled'
          : result.stopReason === 'lease_lost'
            ? 'paused'
            : completedByTerminalNoteRule
              ? 'completed'
              : collectionVerdict.status
      const keepCursor = finalStatus === 'waiting_human'
        || result.stopReason === 'lease_lost'
        || (finalStatus === collectionVerdict.status && collectionVerdict.keepCursor)
      const checkpointStage = keepCursor
        ? 'note_collect_round'
        : finalStatus
      const verdictFields = result.stopReason === 'needs_verification' || result.stopReason === 'cancelled' || result.stopReason === 'lease_lost'
        ? {}
        : completedByTerminalNoteRule && collectionVerdict.status !== 'completed'
          ? { labelKey: 'verdict.unrecoverable_partial', verdict: 'completed_partial' }
          : { labelKey: collectionVerdict.labelKey, verdict: collectionVerdict.verdict }
      const artifacts = await writeCollectionSummaryArtifacts({
        plan,
        taskId,
        taskStatus: finalStatus,
        state: result.state,
        rounds: result.rounds,
        stopReason: result.stopReason,
        sourceTaskId: plan.sourceTaskId,
      }).catch(() => ({}))
      this.persistenceService.updateProgress(taskId, {
        total: plan.notes.length,
        completed: result.collected.length,
        failed: failedItems.length,
        currentLabel: null,
      }, {
        status: finalStatus,
        checkpoint: {
          taskId,
          stage: checkpointStage,
          cursor: keepCursor ? String(result.state.cursor) : null,
          partialResults: keepCursor ? result.state : null,
        },
        result: {
          status: publicNoteCollectStatus(finalStatus, result.collected.length),
          ...verdictFields,
          collected: result.collected,
          failed: failedItems,
          notes: result.notes,
          rounds: result.rounds,
          stopReason: result.stopReason,
          expectedCount: plan.expectedCount ?? plan.notes.length,
          sourceTaskId: plan.sourceTaskId,
          outputRootDir: plan.outputRootDir,
          remaining: Math.max(0, plan.notes.length - result.state.cursor),
          resumeFromCursor: result.state.cursor,
          ...artifacts,
        },
        error: finalStatus === 'waiting_human' ? null : incompleteError,
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, finalStatus)
      this.projectNoteCollect(taskId, scopeId, noteCollectState(finalStatus), plan.notes.length, result.collected.length, failedItems.length, null, {
        waitingFor: finalStatus === 'waiting_human' ? 'verification' : undefined,
        publicStatus: publicNoteCollectStatus(finalStatus, result.collected.length),
        ...sourceIdsFromOutputs(result.notes),
      })
    } catch (error) {
      // An uncaught throw from runBrowserCollection would otherwise leave the
      // chat card stuck in 'running' forever (Codex result-review #A). Mark the
      // browser task AND the chat projection failed.
      this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'failed')
      this.projectNoteCollect(taskId, scopeId, 'failed', plan.notes.length, 0, 0, null)
    } finally {
      releaseLayoutLock?.()
      this.leaseService.release(leaseId)
    }
  }

  private async runTask(taskId: string, kind: BrowserCapabilityTaskKind, payload: Record<string, unknown>): Promise<void> {
    this.persistenceService.updateProgress(taskId, {}, {
      status: 'running',
      startedAt: new Date().toISOString(),
      error: null,
    })

    if (kind === 'download_urls') {
      const urls = toStringArray(payload.urls)
      const result = await this.capabilityService.batchDownload(urls, {
        directory: typeof payload.directory === 'string' ? payload.directory : undefined,
        filenamePrefix: typeof payload.filenamePrefix === 'string' ? payload.filenamePrefix : undefined,
        overwrite: payload.overwrite === true,
        retryFailed: payload.retryFailed === true,
        onProgress: (progress) => {
          if (this.cancelledTasks.has(taskId)) return
          this.persistenceService.updateProgress(taskId, progress, {
            checkpoint: {
              taskId,
              stage: 'batch_download',
              cursor: progress.currentLabel || null,
            },
          })
        },
      })
      if (this.cancelledTasks.has(taskId)) return
      this.persistenceService.updateProgress(taskId, {
        total: result.total,
        completed: result.success,
        failed: result.failed,
        currentLabel: null,
      }, {
        status: 'completed',
        result,
        checkpoint: {
          taskId,
          stage: 'completed',
          cursor: null,
        },
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'completed')
      return
    }

    if (kind === 'scroll_collect') {
      const targetUrl = String(payload.url || '').trim()
      const opened = await this.capabilityService.openTarget(targetUrl, 'prefer_reuse')
      if (!opened.success || !opened.tabId) {
        throw new Error(opened.error || 'Failed to open task target')
      }
      const wait = payload.wait && typeof payload.wait === 'object' ? payload.wait as Record<string, unknown> : null
      if (wait?.condition) {
        await this.capabilityService.waitForCondition(opened.tabId, {
          condition: String(wait.condition) as never,
          selector: typeof wait.selector === 'string' ? wait.selector : undefined,
          customJs: typeof wait.customJs === 'string' ? wait.customJs : undefined,
          timeoutMs: Number(wait.timeoutMs || 0) || undefined,
          checkIntervalMs: Number(wait.checkIntervalMs || 0) || undefined,
          stableIterations: Number(wait.stableIterations || 0) || undefined,
        })
      }
      const collected = await this.capabilityService.scrollCollect(opened.tabId, {
        template: String(payload.template || 'card_list') as never,
        itemSelector: typeof payload.itemSelector === 'string' ? payload.itemSelector : undefined,
        limit: Number(payload.limit || 0) || undefined,
        maxScrolls: Number(payload.maxScrolls || 0) || undefined,
        scrollDelayMs: Number(payload.scrollDelayMs || 0) || undefined,
        stableRounds: Number(payload.stableRounds || 0) || undefined,
        customScript: typeof payload.customScript === 'string' ? payload.customScript : undefined,
      })

      const mediaUrls = collected.items.flatMap((item) => item.media || []).filter(Boolean)
      const shouldDownload = payload.download === true && mediaUrls.length > 0
      const downloadResult = shouldDownload
        ? await this.capabilityService.batchDownload(mediaUrls, {
            directory: typeof payload.directory === 'string' ? payload.directory : undefined,
            retryFailed: payload.retryFailed === true,
          })
        : null

      this.persistenceService.updateProgress(taskId, {
        total: collected.items.length,
        completed: collected.items.length,
        failed: downloadResult?.failed || 0,
      }, {
        status: 'completed',
        checkpoint: {
          taskId,
          stage: 'completed',
          cursor: null,
          partialResults: collected.items,
        },
        result: {
          collected,
          downloadResult,
        },
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'completed')
      return
    }

    if (kind === 'visible_collect') {
      await this.runVisibleCollect(taskId, payload)
      return
    }

    if (kind === 'note_collect' || kind === 'card_loop') {
      await this.runNoteCollect(taskId, payload)
      return
    }

    if (kind === 'research') {
      const maxPages = Math.max(1, Math.min(20, Number(payload.maxPages || 6)))
      let urls = toStringArray(payload.urls).slice(0, maxPages)
      if (urls.length === 0 && payload.query) {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(String(payload.query || ''))}`
        const searchResults = await this.capabilityService.extractStructuredFromUrl(searchUrl, {
          template: 'link_list',
          openMode: 'prefer_reuse',
          limit: maxPages * 2,
          wait: { condition: 'page_readable', timeoutMs: 10_000 },
        })
        urls = searchResults.items.map((item) => String(item.link || '').trim()).filter(Boolean).slice(0, maxPages)
      }

      const sources: BrowserStructuredItem[] = []
      for (let index = 0; index < urls.length; index += 1) {
        if (this.cancelledTasks.has(taskId)) return
        const url = urls[index]
        const extracted = await this.capabilityService.extractStructuredFromUrl(url, {
          template: String(payload.template || 'article_list') as never,
          openMode: 'prefer_reuse',
          limit: Number(payload.limitPerPage || 0) || 12,
          wait: { condition: 'content_stable', timeoutMs: 12_000, checkIntervalMs: 250, stableIterations: 2 },
        })
        sources.push(...extracted.items)
        this.persistenceService.updateProgress(taskId, {
          total: urls.length,
          completed: index + 1,
          failed: 0,
          currentLabel: url,
        }, {
          checkpoint: {
            taskId,
            stage: 'research_collect',
            cursor: url,
            partialResults: sources,
          },
        })
      }

      const dedupedItems = this.capabilityService.aggregateResults(sources, {
        mergeStrategy: 'dedupe',
        sortBy: 'source',
      })
      const bundle: BrowserResearchBundle = {
        sources,
        dedupedItems,
      }
      this.persistenceService.updateProgress(taskId, {
        total: urls.length,
        completed: urls.length,
        failed: 0,
        currentLabel: null,
      }, {
        status: 'completed',
        checkpoint: {
          taskId,
          stage: 'completed',
          cursor: null,
          partialResults: dedupedItems,
        },
        result: bundle,
        finishedAt: new Date().toISOString(),
      })
      publishBrowserTaskEvent(taskId, 'completed')
    }
  }
}
