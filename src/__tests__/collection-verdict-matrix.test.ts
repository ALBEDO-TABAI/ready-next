import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrowserCapabilityService } from '../main/modules/browser-engine/capability-service'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskProgress,
  BrowserCapabilityTaskStatus,
  BrowserStartTaskRequest,
  BrowserTaskCheckpoint,
} from '../main/modules/browser-engine/capability-types'
import { BrowserContentTaskRunner } from '../main/modules/browser-engine/content-task-runner'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { resolveCollectionVerdict } from '../main/modules/browser-engine/collection-verdict'

interface StoredTask {
  taskId: string
  kind: string
  status: BrowserCapabilityTaskStatus
  payload: Record<string, unknown>
  progress: BrowserCapabilityTaskProgress
  checkpoint?: BrowserTaskCheckpoint | null
  result?: unknown
  error?: string | null
}

class FakePersistence {
  store = new Map<string, StoredTask>()
  private seq = 0

  createTask(request: BrowserStartTaskRequest): BrowserCapabilityTaskHandle {
    const taskId = `task-${(this.seq += 1)}`
    this.store.set(taskId, {
      taskId,
      kind: request.kind,
      status: 'queued',
      payload: request.payload || {},
      progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
    })
    return this.getTask(taskId) as BrowserCapabilityTaskHandle
  }

  getTask(taskId: string): BrowserCapabilityTaskHandle | null {
    const t = this.store.get(taskId)
    if (!t) return null
    return {
      taskId: t.taskId,
      kind: t.kind as never,
      status: t.status,
      progress: t.progress,
      checkpoint: t.checkpoint ?? null,
      result: t.result ?? null,
      error: t.error ?? null,
    }
  }

  getTaskPayload(taskId: string): Record<string, unknown> | null {
    return this.store.get(taskId)?.payload ?? null
  }

  updateProgress(
    taskId: string,
    progress: Partial<BrowserCapabilityTaskProgress>,
    extras?: {
      checkpoint?: BrowserTaskCheckpoint | null
      status?: BrowserCapabilityTaskStatus
      error?: string | null
      result?: unknown
      startedAt?: string | null
      finishedAt?: string | null
    },
  ): BrowserCapabilityTaskHandle | null {
    const t = this.store.get(taskId)
    if (!t) return null
    t.progress = {
      total: progress.total ?? t.progress.total,
      completed: progress.completed ?? t.progress.completed,
      failed: progress.failed ?? t.progress.failed,
      currentLabel: progress.currentLabel ?? t.progress.currentLabel ?? null,
    }
    if (extras?.status) t.status = extras.status
    if (extras?.checkpoint !== undefined) t.checkpoint = extras.checkpoint
    if (extras?.result !== undefined) t.result = extras.result
    if (extras?.error !== undefined) t.error = extras.error
    return this.getTask(taskId)
  }

  listPendingTasks(): BrowserCapabilityTaskHandle[] {
    return [...this.store.values()]
      .filter((t) => ['queued', 'running', 'paused'].includes(t.status))
      .map((t) => this.getTask(t.taskId) as BrowserCapabilityTaskHandle)
  }
}

async function waitForStatus(persistence: FakePersistence, taskId: string, statuses: BrowserCapabilityTaskStatus[], timeoutMs = 2_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const task = persistence.getTask(taskId)
    if (task && statuses.includes(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`task ${taskId} did not reach ${statuses.join('/')} in time`)
}

describe('collection verdict matrix', () => {
  it('Q1 marks empty collection as needing attention via failed status fallback', () => {
    const verdict = resolveCollectionVerdict({
      collected: 0,
      expected: 10,
      stopReason: 'completed',
      failures: 0,
      cursorValid: false,
    })

    assert.equal(verdict.status, 'failed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.empty_collection')
    assert.equal(verdict.verdict, 'needs_attention')
  })

  it('Q2 keeps a valid cursor for recoverable partial collection', () => {
    const verdict = resolveCollectionVerdict({
      collected: 5,
      expected: 10,
      stopReason: 'max_duration',
      failures: 0,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'paused')
    assert.equal(verdict.keepCursor, true)
    assert.equal(verdict.labelKey, 'verdict.recoverable_paused')
    assert.equal(verdict.verdict, 'recoverable_paused')
  })

  it('Q3 fails unrecoverable partial collection without a valid cursor', () => {
    const verdict = resolveCollectionVerdict({
      collected: 5,
      expected: 10,
      stopReason: 'completed',
      failures: 5,
      cursorValid: false,
    })

    assert.equal(verdict.status, 'failed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.unrecoverable_partial')
    assert.equal(verdict.verdict, 'completed_partial')
  })

  it('Q4 completes when collected reaches expected count', () => {
    const verdict = resolveCollectionVerdict({
      collected: 10,
      expected: 10,
      stopReason: 'completed',
      failures: 0,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'completed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.completed')
    assert.equal(verdict.verdict, 'completed')
  })

  it('Q5 completes natural collection when expected count is unknown', () => {
    const verdict = resolveCollectionVerdict({
      collected: 5,
      expected: undefined,
      stopReason: 'no_new_content',
      failures: 0,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'completed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.completed')
    assert.equal(verdict.verdict, 'completed')
  })

  it('Q6 replays 06-06 partial collection as recoverable with cursor kept', () => {
    const verdict = resolveCollectionVerdict({
      collected: 62,
      expected: 69,
      stopReason: 'completed',
      failures: 7,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'paused')
    assert.equal(verdict.keepCursor, true)
    assert.equal(verdict.labelKey, 'verdict.recoverable_paused')
    assert.equal(verdict.verdict, 'recoverable_paused')
  })

  it('S3-3 treats a terminal retryable failure ledger as recoverable partial output', () => {
    const failedItems = [
      { url: 'https://example.com/retry-still-fails', reason: 'navigate:navigation_failed', attempts: 3, retryable: true },
    ]
    const verdict = resolveCollectionVerdict({
      collected: 4,
      expected: 5,
      stopReason: 'completed',
      failures: failedItems.length,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'paused')
    assert.equal(verdict.keepCursor, true)
    assert.equal(verdict.labelKey, 'verdict.recoverable_paused')
    assert.equal(verdict.verdict, 'recoverable_paused')
  })

  it('continues visible discovery when the escalation probe finds new content after empty rounds', async () => {
    const persistence = new FakePersistence()
    let probeRead = false
    let normalExtractsAfterProbe = 0
    const capability = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async (_tabId: string | null, options: { wait?: { condition?: string } }) => {
        if (options.wait?.condition === 'custom_js') {
          probeRead = true
          return {
            template: 'card_list' as const,
            items: [{ sourceUrl: 'https://example.com/feed', title: 'Probe', link: 'https://example.com/probe' }],
            sourceUrl: 'https://example.com/feed',
          }
        }
        if (probeRead) {
          normalExtractsAfterProbe += 1
          return {
            template: 'card_list' as const,
            items: [
              { sourceUrl: 'https://example.com/feed', title: 'Probe', link: 'https://example.com/probe' },
              { sourceUrl: 'https://example.com/feed', title: 'After', link: 'https://example.com/after' },
            ],
            sourceUrl: 'https://example.com/feed',
          }
        }
        return { template: 'card_list' as const, items: [], sourceUrl: 'https://example.com/feed' }
      },
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: false }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', emptyRoundsToStop: 2, maxRounds: 8 },
    })

    const done = await waitForStatus(persistence, handle.taskId, ['completed'])
    const result = done.result as { items: Array<{ link?: string }>; stopReason?: string }

    assert.equal(probeRead, true)
    assert.ok(normalExtractsAfterProbe > 0, 'loop must continue after escalation adds content')
    assert.deepEqual(result.items.map((item) => item.link).sort(), [
      'https://example.com/after',
      'https://example.com/probe',
    ])
  })

  it('stops after an empty escalation probe and attaches needs-attention diagnostics for zero items', async () => {
    const persistence = new FakePersistence()
    let probeReads = 0
    let emptyDiagnostics = 0
    const capability = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async (_tabId: string | null, options: { wait?: { condition?: string } }) => {
        if (options.wait?.condition === 'custom_js') probeReads += 1
        return { template: 'card_list' as const, items: [], sourceUrl: 'https://example.com/feed' }
      },
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: false }),
      probeEmptyPageDiagnostic: async () => {
        emptyDiagnostics += 1
        return { reason: 'login_wall' as const, evidence: ['登录后查看内容'] }
      },
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', emptyRoundsToStop: 2, maxRounds: 8 },
    })

    const done = await waitForStatus(persistence, handle.taskId, ['failed'])
    const result = done.result as {
      stopReason?: string
      verdict?: string
      emptyDiagnostics?: { reason?: string; evidence?: string[] }
    }

    assert.equal(probeReads, 1)
    assert.equal(emptyDiagnostics, 1)
    assert.equal(result.stopReason, 'no_new_content')
    assert.equal(result.verdict, 'needs_attention')
    assert.equal(result.emptyDiagnostics?.reason, 'login_wall')
    assert.deepEqual(result.emptyDiagnostics?.evidence, ['登录后查看内容'])
  })
})
