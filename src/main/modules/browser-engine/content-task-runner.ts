import { BrowserCapabilityService } from './capability-service'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskKind,
  BrowserResearchBundle,
  BrowserStartTaskRequest,
  BrowserStructuredItem,
} from './capability-types'
import { BrowserTaskPersistenceService } from './task-persistence-service'
import {
  DEFAULT_VISIBLE_COLLECT_LIMITS,
  VisibleCollectDeduper,
  evaluateStop,
  type VisibleCollectItem,
  type VisibleCollectLimits,
} from './agent-browser-collect'
import { getBrowserWriteLeaseService } from './agent-browser-lease-singleton'
import { isAgentBrowserError, type AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import { parseCollectionPlan, type CollectionLoopState, type CollectionPlan } from './agent-collection-plan'
import { runBrowserCollection } from './browser-collector-engine'
import type { NoteCollectFacade } from './browser-collector-actions'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import { deriveCollectionTargets } from './collection-targets'

/**
 * Per-task collector binding (plan §3.4). The controller provides this factory
 * (it owns executeBrowserTool + the AgentTabControlGate); the runner stays
 * decoupled from tools/ and only sees the NoteCollectFacade + a freeze probe.
 */
export interface CollectorFacadeBundle {
  facade: NoteCollectFacade
  isControlFrozen: () => boolean
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
  scopeId: string
  title: string
  summary: string
  state: 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  total: number
  completed: number
  failed: number
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

function noteCollectSummary(total: number, completed: number, failed: number, current: string | null, state: BrowserTaskProjectionInput['state']): string {
  if (state === 'completed') return `采集完成：成功 ${completed}${failed > 0 ? ` · 失败 ${failed}` : ''}，共 ${total} 篇`
  if (state === 'paused') return `采集已暂停：成功 ${completed}/${total}${failed > 0 ? ` · 失败 ${failed}` : ''}，等待验证或继续`
  if (state === 'cancelled') return `已中断：已采集 ${completed}/${total} 篇`
  if (state === 'failed') return `采集失败：已采集 ${completed}/${total} 篇`
  return `已采集 ${completed}/${total} 篇${current ? ` · 当前：${current}` : ''}`
}

function visibleCollectSummary(total: number, current: string | null, state: BrowserTaskProjectionInput['state']): string {
  if (state === 'completed') return `可见页面采集完成：找到 ${total} 条`
  if (state === 'paused') return `可见页面采集已暂停：找到 ${total} 条，可能还没到底`
  if (state === 'cancelled') return `可见页面采集已中断：已找到 ${total} 条`
  if (state === 'failed') return `可见页面采集失败：已找到 ${total} 条`
  return `正在滚动采集页面${current ? ` · ${current}` : ''}`
}

function toNumberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function discoveryStatusFor(stopReason: string): 'complete' | 'partial' | 'paused' {
  if (stopReason === 'no_new_content') return 'complete'
  if (stopReason === 'cancelled' || stopReason === 'lease_lost') return 'paused'
  return 'partial'
}

function visibleCollectResult(taskId: string, items: BrowserStructuredItem[], rounds: number, stopReason: string, targetUrl: string, outputRootDir: unknown) {
  const noteCandidates = deriveCollectionTargets(items)
  const discoveryStatus = discoveryStatusFor(stopReason)
  const canStartNoteCollect = discoveryStatus === 'complete'
  return {
    items,
    rounds,
    stopReason,
    targetUrl,
    discoveryStatus,
    hasMoreLikely: discoveryStatus !== 'complete',
    frozenCount: noteCandidates.length,
    noteCandidates,
    candidateCount: noteCandidates.length,
    sourceTaskId: taskId,
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
  }
}

function completedAllExpected(expected: number, completed: number, failed: number, stopReason: string | null): boolean {
  return stopReason === 'completed' && expected > 0 && completed === expected && failed === 0
}

function finalNoteCollectError(expected: number, completed: number, failed: number, stopReason: string | null): string | null {
  if (completedAllExpected(expected, completed, failed, stopReason)) return null
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
  const successfulLines = state.outputs.filter((item) => item.success).map((item) => `- ${item.order ?? ''} ${item.title || item.url}：${item.imageCount} 张`)
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
    for (const task of await this.listTasks()) {
      if (task.kind !== 'note_collect' && task.kind !== 'visible_collect') continue
      const payload = this.persistenceService.getTaskPayload(task.taskId)
      const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
      if (!scopeId) continue
      const state = noteCollectState(task.status)
      const { total, completed, failed, currentLabel } = task.progress
      if (task.kind === 'note_collect') {
        sink.upsert({
          taskId: task.taskId,
          scopeId,
          title: '浏览器逐篇采集',
          summary: noteCollectSummary(total, completed, failed, currentLabel ?? null, state),
          state,
          total,
          completed,
          failed,
        })
      } else {
        this.projectVisibleCollect(task.taskId, scopeId, state, total, currentLabel ?? null)
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
  ): void {
    const sink = this.taskProjectionSink
    if (!sink || !scopeId) return
    sink.upsert({
      taskId,
      scopeId,
      title: '浏览器逐篇采集',
      summary: noteCollectSummary(total, completed, failed, current, state),
      state,
      total,
      completed,
      failed,
    })
  }

  private projectVisibleCollect(
    taskId: string,
    scopeId: string,
    state: BrowserTaskProjectionInput['state'],
    total: number,
    current: string | null,
  ): void {
    const sink = this.taskProjectionSink
    if (!sink || !scopeId) return
    sink.upsert({
      taskId,
      scopeId,
      title: '浏览器可见页面采集',
      summary: visibleCollectSummary(total, current, state),
      state,
      total,
      completed: total,
      failed: 0,
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

  async resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    const current = this.persistenceService.getTask(taskId)
    const payload = this.persistenceService.getTaskPayload(taskId)
    if (!current || !payload) return null
    if (current.status === 'completed' || current.status === 'failed') return current
    this.cancelledTasks.delete(taskId)
    this.scheduleTask(taskId, current.kind, payload)
    return this.persistenceService.getTask(taskId)
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
    if (handle?.kind === 'note_collect') {
      const payload = this.persistenceService.getTaskPayload(taskId)
      const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
      const p = handle.progress
      this.projectNoteCollect(taskId, scopeId, 'cancelled', p.total, p.completed, p.failed, null)
    } else if (handle?.kind === 'visible_collect') {
      const payload = this.persistenceService.getTaskPayload(taskId)
      const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
      this.projectVisibleCollect(taskId, scopeId, 'cancelled', handle.progress.total, null)
    }
    return handle
  }

  async resumePendingTasks(): Promise<void> {
    for (const task of this.persistenceService.listPendingTasks()) {
      // note_collect is bound to a session-specific agent tab (ensureAgentTab).
      // After an app restart that tab is gone, so resuming would re-acquire an
      // agent-view lease against a dead tab and block new collections (it never
      // makes progress, just holds the lease until it fails out). Cancel these
      // stale collections on startup instead of resuming them.
      if (task.kind === 'note_collect') {
        const payload = this.persistenceService.getTaskPayload(task.taskId)
        const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId.trim() : ''
        this.persistenceService.updateProgress(task.taskId, { currentLabel: null }, {
          status: 'cancelled',
          error: 'note_collect not resumable across app restart (agent tab gone)',
          finishedAt: new Date().toISOString(),
        })
        const p = task.progress
        this.projectNoteCollect(task.taskId, scopeId, 'cancelled', p.total, p.completed, p.failed, null)
        continue
      }
      const payload = this.persistenceService.getTaskPayload(task.taskId)
      if (!payload) continue
      this.scheduleTask(task.taskId, task.kind, payload)
    }
  }

  private scheduleTask(taskId: string, kind: BrowserCapabilityTaskKind, payload: Record<string, unknown>): void {
    if (this.activeRuns.has(taskId)) return
    const run = this.runTask(taskId, kind, payload)
      .catch((error) => {
        this.persistenceService.updateProgress(taskId, {}, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        })
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
        this.projectVisibleCollect(taskId, scopeId, 'failed', 0, null)
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
        status: 'cancelled',
        checkpoint: { taskId, stage: 'cancelled', cursor: null, partialResults: [] },
        result: visibleCollectResult(taskId, [], 0, 'lease_lost', '', payload.outputRootDir),
        finishedAt: new Date().toISOString(),
      })
      const scopeId = typeof payload.scopeId === 'string' ? payload.scopeId.trim() : ''
      this.projectVisibleCollect(taskId, scopeId, 'cancelled', 0, null)
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
      this.projectVisibleCollect(taskId, scopeId, 'failed', 0, null)
      return
    }

    const limits: VisibleCollectLimits = {
      maxItems: toNumberOr(payload.maxItems, DEFAULT_VISIBLE_COLLECT_LIMITS.maxItems),
      maxRounds: toNumberOr(payload.maxRounds, DEFAULT_VISIBLE_COLLECT_LIMITS.maxRounds),
      maxExpandsPerRound: toNumberOr(payload.maxExpandsPerRound, DEFAULT_VISIBLE_COLLECT_LIMITS.maxExpandsPerRound),
      maxDurationMs: toNumberOr(payload.maxDurationMs, DEFAULT_VISIBLE_COLLECT_LIMITS.maxDurationMs),
      emptyRoundsToStop: toNumberOr(payload.emptyRoundsToStop, DEFAULT_VISIBLE_COLLECT_LIMITS.emptyRoundsToStop),
    }
    // High-control platforms (小红书/抖音/…): cap volume/rounds/duration to a more
    // conservative ceiling and pace rounds (plan §4.4 限速限量). Explicit caller
    // limits still win when they are lower than the conservative ceiling.
    const highControl = payload.highControl === true
    let interRoundDelayMs = 0
    if (highControl) {
      limits.maxItems = Math.min(limits.maxItems, 60)
      limits.maxRounds = Math.min(limits.maxRounds, 12)
      limits.maxDurationMs = Math.min(limits.maxDurationMs, 90_000)
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
      const freshOriginals: BrowserStructuredItem[] = []
      for (const item of extracted.items) {
        const identityInput: VisibleCollectItem = {
          link: item.link,
          text: item.title || item.summary,
          containerPath: item.sourceUrl,
        }
        if (deduper.addBatch([identityInput]).length > 0) {
          freshOriginals.push(item)
        }
      }
      if (freshOriginals.length === 0) {
        consecutiveEmptyRounds += 1
      } else {
        consecutiveEmptyRounds = 0
        collected.push(...freshOriginals)
      }

      // Checkpoint EVERY round so a crash/cancel resumes from here.
      this.persistenceService.updateProgress(taskId, {
        total: collected.length,
        completed: collected.length,
        failed: 0,
        currentLabel: `round ${round}`,
      }, {
        checkpoint: {
          taskId,
          stage: 'visible_collect_round',
          cursor: String(round),
          partialResults: collected,
        },
      })
      this.projectVisibleCollect(taskId, scopeId, 'running', collected.length, `round ${round}`)

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

    const discoveryStatus = discoveryStatusFor(stopReason)
    const finalStatus = stopReason === 'cancelled' || stopReason === 'lease_lost'
      ? 'cancelled'
      : discoveryStatus === 'complete'
        ? 'completed'
        : 'paused'
    const finalCheckpointStage = finalStatus === 'paused' || finalStatus === 'cancelled'
      ? 'visible_collect_round'
      : finalStatus
    const finalResult = visibleCollectResult(taskId, collected, round, stopReason, targetUrl, payload.outputRootDir)
    this.persistenceService.updateProgress(taskId, {
      total: collected.length,
      completed: collected.length,
      failed: 0,
      currentLabel: null,
    }, {
      status: finalStatus,
      checkpoint: {
        taskId,
        stage: finalCheckpointStage,
        cursor: finalCheckpointStage === 'visible_collect_round' ? String(round) : null,
        partialResults: collected,
      },
      result: finalResult,
      finishedAt: new Date().toISOString(),
    })
    this.projectVisibleCollect(taskId, scopeId, finalStatus, collected.length, null)
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
      this.projectNoteCollect(taskId, scopeId, 'failed', 0, 0, 0, null)
      return
    }
    // High-control platforms (小红书/抖音/…): clamp volume + pace between notes
    // (plan §4.4 限速限量). Explicit lower caller caps still win.
    const isHighControl = isHighControlPlatformText(parsed.plan.targetProfileUrl) || parsed.plan.notes.some((n) => isHighControlPlatformText(n.url))
    const plan: CollectionPlan = isHighControl
      ? {
          ...parsed.plan,
          stopConditions: {
            ...parsed.plan.stopConditions,
            maxNotes: Math.min(parsed.plan.stopConditions?.maxNotes ?? 60, 60),
            maxDurationMs: Math.min(parsed.plan.stopConditions?.maxDurationMs ?? 20 * 60_000, 20 * 60_000),
            maxConsecutiveFailures: Math.min(parsed.plan.stopConditions?.maxConsecutiveFailures ?? 3, 3),
          },
        }
      : parsed.plan
    const interNoteDelayMs = isHighControl ? 1_500 : 0
    // Download-volume budget on high-control platforms (Codex result-review #5):
    // a safety ceiling on total images saved across the collection.
    const maxTotalImages = isHighControl ? 400 : 0

    // Own an agent-view lease for the whole task, tied to the agent tab, so the
    // background loop never collides with the user's foreground writes.
    const surface: AgentBrowserSurface = 'agent-view'
    const acquired = this.leaseService.acquire({ surface, taskId, runId: taskId, tabId: agentTabId })
    if (isAgentBrowserError(acquired)) {
      this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
        status: 'failed',
        error: `note_collect could not acquire ${surface} lease: ${acquired.errorCode}`,
        finishedAt: new Date().toISOString(),
      })
      this.projectNoteCollect(taskId, scopeId, 'failed', plan.notes.length, 0, 0, null)
      return
    }
    const leaseId = acquired.leaseId
    const { facade, isControlFrozen } = this.collectorFacadeFactory({ agentTabId, leaseId, surface })
    // Project a running card as soon as the collection starts (plan §3.4).
    this.projectNoteCollect(taskId, scopeId, 'running', plan.notes.length, 0, 0, null)

    try {
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
          shouldStop: () => {
            if (this.cancelledTasks.has(taskId)) return 'cancelled'
            // A user freeze (AgentTabControlGate) stops the agent cleanly, not as
            // a string of write failures. Freeze is NOT a lease state (Codex R2).
            if (isControlFrozen()) return 'cancelled'
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
            this.projectNoteCollect(taskId, scopeId, 'running', progress.total, progress.completed, progress.failed, progress.currentTitle)
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
            failed: result.failed,
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
        this.projectNoteCollect(taskId, scopeId, 'cancelled', plan.notes.length, result.collected.length, result.failed.length, null)
        return
      }
      // A user freeze or a lease takeover is NOT a successful completion (Codex
      // result-review #1): reflect the interruption in the task status.
      const incompleteError = finalNoteCollectError(plan.notes.length, result.collected.length, result.failed.length, result.stopReason)
      const finalStatus: BrowserCapabilityTaskHandle['status'] = result.stopReason === 'needs_verification'
        ? 'waiting_human'
        : result.stopReason === 'cancelled' || result.stopReason === 'lease_lost'
          ? 'cancelled'
          : incompleteError && result.collected.length > 0 && ['max_notes', 'max_duration', 'max_images'].includes(String(result.stopReason))
            ? 'paused'
            : incompleteError
              ? 'failed'
              : 'completed'
      const checkpointStage = finalStatus === 'waiting_human' || finalStatus === 'paused'
        ? 'note_collect_round'
        : finalStatus
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
        failed: result.failed.length,
        currentLabel: null,
      }, {
        status: finalStatus,
        checkpoint: {
          taskId,
          stage: checkpointStage,
          cursor: finalStatus === 'waiting_human' || finalStatus === 'paused' ? String(result.state.cursor) : null,
          partialResults: finalStatus === 'waiting_human' || finalStatus === 'paused' ? result.state : null,
        },
        result: {
          status: publicNoteCollectStatus(finalStatus, result.collected.length),
          collected: result.collected,
          failed: result.failed,
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
      this.projectNoteCollect(taskId, scopeId, noteCollectState(finalStatus), plan.notes.length, result.collected.length, result.failed.length, null)
    } catch (error) {
      // An uncaught throw from runBrowserCollection would otherwise leave the
      // chat card stuck in 'running' forever (Codex result-review #A). Mark the
      // browser task AND the chat projection failed.
      this.persistenceService.updateProgress(taskId, { currentLabel: null }, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      })
      this.projectNoteCollect(taskId, scopeId, 'failed', plan.notes.length, 0, 0, null)
    } finally {
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
      return
    }

    if (kind === 'visible_collect') {
      await this.runVisibleCollect(taskId, payload)
      return
    }

    if (kind === 'note_collect') {
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
    }
  }
}
