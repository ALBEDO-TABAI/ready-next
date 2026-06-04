import { BrowserCapabilityService } from './capability-service'
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

function toNumberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
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
  ) {}

  async startTask(request: BrowserStartTaskRequest): Promise<BrowserCapabilityTaskHandle> {
    const handle = this.persistenceService.createTask(request)
    this.scheduleTask(handle.taskId, request.kind, request.payload)
    return this.persistenceService.getTask(handle.taskId) || handle
  }

  async getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.persistenceService.getTask(taskId)
  }

  async resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    const current = this.persistenceService.getTask(taskId)
    const payload = this.persistenceService.getTaskPayload(taskId)
    if (!current || !payload) return null
    this.cancelledTasks.delete(taskId)
    this.scheduleTask(taskId, current.kind, payload)
    return this.persistenceService.getTask(taskId)
  }

  async cancelTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    this.cancelledTasks.add(taskId)
    return this.persistenceService.updateProgress(taskId, {}, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
    })
  }

  async resumePendingTasks(): Promise<void> {
    for (const task of this.persistenceService.listPendingTasks()) {
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
        status: 'completed',
        checkpoint: { taskId, stage: 'completed', cursor: null, partialResults: [] },
        result: { items: [], rounds: 0, stopReason: 'lease_lost' },
        finishedAt: new Date().toISOString(),
      })
      return
    }

    const targetUrl = String(payload.url || '').trim()
    const tabId = targetUrl
      ? (await this.capabilityService.openTarget(targetUrl, 'prefer_reuse')).tabId || null
      : (typeof payload.tabId === 'string' ? payload.tabId : null)

    const limits: VisibleCollectLimits = {
      maxItems: toNumberOr(payload.maxItems, DEFAULT_VISIBLE_COLLECT_LIMITS.maxItems),
      maxRounds: toNumberOr(payload.maxRounds, DEFAULT_VISIBLE_COLLECT_LIMITS.maxRounds),
      maxExpandsPerRound: toNumberOr(payload.maxExpandsPerRound, DEFAULT_VISIBLE_COLLECT_LIMITS.maxExpandsPerRound),
      maxDurationMs: toNumberOr(payload.maxDurationMs, DEFAULT_VISIBLE_COLLECT_LIMITS.maxDurationMs),
      emptyRoundsToStop: toNumberOr(payload.emptyRoundsToStop, DEFAULT_VISIBLE_COLLECT_LIMITS.emptyRoundsToStop),
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

    while (true) {
      // Before any page write this round, confirm we still hold the lease; a
      // user takeover or expiry stops the loop with lease_lost (counterplan
      // §5.5). Heartbeat so a long collection does not expire mid-run.
      const leaseDenied = this.leaseService.checkWrite({ surface, leaseId })
      const stop = evaluateStop(
        {
          collectedCount: collected.length,
          round,
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

      if (this.cancelledTasks.has(taskId)) {
        stopReason = 'cancelled'
        break
      }

      const scroll = await this.capabilityService.scrollViewportOnce(tabId)
      if (scroll.atBottom) {
        // One more extract pass already happened; let an empty round confirm end.
        consecutiveEmptyRounds += 1
      }
    }

    if (this.cancelledTasks.has(taskId)) return

    this.persistenceService.updateProgress(taskId, {
      total: collected.length,
      completed: collected.length,
      failed: 0,
      currentLabel: null,
    }, {
      status: 'completed',
      checkpoint: {
        taskId,
        stage: 'completed',
        cursor: null,
        partialResults: collected,
      },
      result: {
        items: collected,
        rounds: round,
        stopReason,
      },
      finishedAt: new Date().toISOString(),
    })
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
