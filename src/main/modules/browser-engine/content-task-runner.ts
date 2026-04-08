import { BrowserCapabilityService } from './capability-service'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskKind,
  BrowserResearchBundle,
  BrowserStartTaskRequest,
  BrowserStructuredItem,
} from './capability-types'
import { BrowserTaskPersistenceService } from './task-persistence-service'

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
}

export class BrowserContentTaskRunner {
  private activeRuns = new Map<string, Promise<void>>()
  private cancelledTasks = new Set<string>()

  constructor(
    private readonly capabilityService: BrowserCapabilityService,
    private readonly persistenceService = new BrowserTaskPersistenceService(),
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
