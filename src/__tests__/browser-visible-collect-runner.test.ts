import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { BrowserContentTaskRunner } from '../main/modules/browser-engine/content-task-runner'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import type { BrowserCapabilityService } from '../main/modules/browser-engine/capability-service'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskProgress,
  BrowserCapabilityTaskStatus,
  BrowserStartTaskRequest,
  BrowserTaskCheckpoint,
} from '../main/modules/browser-engine/capability-types'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-visible-collect-runner declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-visible-collect-runner transitive sqlite load')
})

interface StoredTask {
  taskId: string
  kind: string
  status: BrowserCapabilityTaskStatus
  payload: Record<string, unknown>
  progress: BrowserCapabilityTaskProgress
  checkpoint?: BrowserTaskCheckpoint | null
  result?: unknown
  error?: string | null
  checkpointHistory: BrowserTaskCheckpoint[]
}

/** In-memory persistence so the runner can be exercised without SQLite. */
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
      checkpointHistory: [],
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

  updateTaskPayload(taskId: string, payload: Record<string, unknown>): void {
    const task = this.store.get(taskId)
    if (task) task.payload = payload
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
    if (extras?.checkpoint !== undefined) {
      t.checkpoint = extras.checkpoint
      if (extras.checkpoint) t.checkpointHistory.push(extras.checkpoint)
    }
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

/** Capability fake that serves N rounds of feed items then settles at the bottom. */
function createCapability(pages: Array<Array<{ link: string; title: string }>>) {
  let round = -1
  let bottom = false
  const capability = {
    openTarget: async () => ({ success: true, tabId: 'tab-1' }),
    extractStructured: async () => {
      const items = (pages[Math.min(round + 1, pages.length - 1)] || []).map((it) => ({
        sourceUrl: 'https://example.com/feed',
        title: it.title,
        link: it.link,
      }))
      return { template: 'card_list' as const, items, sourceUrl: 'https://example.com/feed' }
    },
    scrollViewportOnce: async () => {
      round += 1
      if (round >= pages.length - 1) bottom = true
      return { scrollY: round * 800, atBottom: bottom }
    },
  }
  return capability as unknown as BrowserCapabilityService
}

async function waitForStatus(persistence: FakePersistence, taskId: string, statuses: BrowserCapabilityTaskStatus[], timeoutMs = 2_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const task = persistence.getTask(taskId)
    if (task && statuses.includes(task.status)) return task
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`task ${taskId} did not reach ${statuses.join('/')} in time`)
}

async function waitForResult<T>(persistence: FakePersistence, taskId: string, predicate: (result: T | null) => boolean, timeoutMs = 2_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const task = persistence.getTask(taskId)
    const result = (task?.result ?? null) as T | null
    if (predicate(result)) return task!
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`task ${taskId} did not publish the expected result in time`)
}

async function waitForProgress(persistence: FakePersistence, taskId: string, predicate: (task: BrowserCapabilityTaskHandle | null) => boolean, timeoutMs = 2_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const task = persistence.getTask(taskId)
    if (predicate(task)) return task!
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`task ${taskId} did not reach expected progress in time`)
}

describe('visible_collect task runner', () => {
  it('collects across rounds, dedupes, and writes a checkpoint every round', async () => {
    const persistence = new FakePersistence()
    const capability = createCapability([
      [{ link: 'https://example.com/1', title: 'One' }, { link: 'https://example.com/2', title: 'Two' }],
      [{ link: 'https://example.com/2', title: 'Two' }, { link: 'https://example.com/3', title: 'Three' }],
      [{ link: 'https://example.com/3', title: 'Three' }],
    ])
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())

    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { url: 'https://example.com/feed', template: 'card_list', maxRounds: 10 },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['completed'], 6_000)

    const result = done.result as { items: Array<{ link: string }>; rounds: number; stopReason: string }
    const links = result.items.map((i) => i.link).sort()
    assert.deepEqual(links, ['https://example.com/1', 'https://example.com/2', 'https://example.com/3'], 'deduped union across rounds')

    const stored = persistence.store.get(handle.taskId)!
    const roundCheckpoints = stored.checkpointHistory.filter((c) => c.stage === 'visible_collect_round')
    assert.ok(roundCheckpoints.length >= 2, 'must checkpoint every round, not only on completion')
    assert.equal(done.status, 'completed')
  })

  it('stops with no_new_content when the feed stops producing new items', async () => {
    const persistence = new FakePersistence()
    const capability = createCapability([
      [{ link: 'https://example.com/1', title: 'One' }],
      [{ link: 'https://example.com/1', title: 'One' }],
      [{ link: 'https://example.com/1', title: 'One' }],
    ])
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', maxRounds: 50 },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['completed'], 6_000)
    const result = done.result as { stopReason: string; items: unknown[] }
    assert.equal(result.stopReason, 'no_new_content')
    assert.equal(result.items.length, 1)
  })

  it('counts image_gallery visible collection items instead of note candidates', async () => {
    const persistence = new FakePersistence()
    const projections: Array<{ title: string; summary: string; discovered?: number; remaining?: number }> = []
    const capability = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async () => ({
        template: 'image_gallery' as const,
        items: [
          { sourceUrl: 'https://example.com/gallery', link: 'https://img.example.com/1.webp', media: ['https://img.example.com/1.webp'] },
          { sourceUrl: 'https://example.com/gallery', link: 'https://img.example.com/2.webp', media: ['https://img.example.com/2.webp'] },
        ],
        sourceUrl: 'https://example.com/gallery',
      }),
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: true }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())
    runner.setTaskProjectionSink({ upsert: (input) => projections.push(input) })
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'image_gallery', tabId: 'tab-1', maxRounds: 4, scopeId: 'scope-image-gallery', outputRootDir: '/tmp/gallery' },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['completed'], 6_000)
    const result = done.result as {
      frozenCount?: number
      candidateCount?: number
      noteCandidates?: unknown[]
      mediaCandidates?: string[]
      mediaCandidateCount?: number
      suggestedNextTool?: { name?: string; args?: { source_task_id?: string; directory?: string; filename_prefix?: string } }
    }

    assert.equal(done.progress.total, 2)
    assert.equal(result.frozenCount, 2)
    assert.equal(result.candidateCount, 0)
    assert.deepEqual(result.noteCandidates, [])
    assert.deepEqual(result.mediaCandidates, ['https://img.example.com/1.webp', 'https://img.example.com/2.webp'])
    assert.equal(result.mediaCandidateCount, 2)
    assert.equal(result.suggestedNextTool?.name, 'browser_download')
    assert.equal(result.suggestedNextTool?.args?.source_task_id, handle.taskId)
    assert.equal(result.suggestedNextTool?.args?.directory, '/tmp/gallery')
    assert.equal(result.suggestedNextTool?.args?.filename_prefix, 'image')
    const finalProjection = projections.at(-1)
    assert.equal(finalProjection?.title, '浏览器图片采集')
    assert.match(finalProjection?.summary || '', /已找到 2 张/)
    assert.match(finalProjection?.summary || '', /等待下载/)
  })

  it('does not complete image_gallery when no valid image URLs were collected', async () => {
    const persistence = new FakePersistence()
    const capability = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async () => ({
        template: 'image_gallery' as const,
        items: [
          { sourceUrl: 'https://example.com/gallery', title: 'empty image shell', link: '' },
        ],
        sourceUrl: 'https://example.com/gallery',
      }),
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: true }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'image_gallery', tabId: 'tab-1', maxRounds: 4 },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['failed'], 6_000)
    const result = done.result as {
      discoveryStatus?: string
      frozenCount?: number
      mediaCandidateCount?: number
      suggestedNextTool?: unknown
    }

    assert.equal(done.progress.total, 0)
    assert.equal(result.discoveryStatus, 'partial')
    assert.equal(result.frozenCount, 0)
    assert.equal(result.mediaCandidateCount, 0)
    assert.equal(result.suggestedNextTool, undefined)
  })

  it('navigates the supplied agent tab for url-based visible collect', async () => {
    const persistence = new FakePersistence()
    const navigations: Array<{ tabId: string; url: string }> = []
    let openTargetCalls = 0
    const capability = {
      openTarget: async () => { openTargetCalls += 1; return { success: true, tabId: 'user-tab' } },
      navigateTargetTab: async (tabId: string, url: string) => {
        navigations.push({ tabId, url })
        return { success: true, tabId, reused: true, url }
      },
      extractStructured: async () => ({
        template: 'article_list' as const,
        items: [{ sourceUrl: 'u', title: 'One', link: 'https://example.com/1' }],
        sourceUrl: 'u',
      }),
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: true }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())

    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: {
        url: 'https://www.xiaohongshu.com/user/profile/abc',
        tabId: 'agent-tab-1',
        surface: 'agent-view',
        template: 'article_list',
      },
    })
    await waitForStatus(persistence, handle.taskId, ['completed'])

    assert.deepEqual(navigations, [{ tabId: 'agent-tab-1', url: 'https://www.xiaohongshu.com/user/profile/abc' }])
    assert.equal(openTargetCalls, 0, 'agent-tab visible collect must not open/reuse the foreground tab')
  })

  it('adds xiaohongshu note candidates and a collect_notes suggestion to completed results', async () => {
    const persistence = new FakePersistence()
    const capability = {
      navigateTargetTab: async (tabId: string, url: string) => ({ success: true, tabId, reused: true, url }),
      extractStructured: async () => ({
        template: 'article_list' as const,
        items: [
          { sourceUrl: 'https://www.xiaohongshu.com/user/profile/abc', title: '首页', link: 'https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend' },
          { sourceUrl: 'https://www.xiaohongshu.com/user/profile/abc', title: '门主', link: 'https://www.xiaohongshu.com/explore/6a0987c5000000003601f3f5' },
          { sourceUrl: 'https://www.xiaohongshu.com/user/profile/abc', title: '同一篇重复', link: 'https://www.xiaohongshu.com/explore/6a0987c5000000003601f3f5' },
          { sourceUrl: 'https://www.xiaohongshu.com/user/profile/abc', title: '外站', link: 'https://example.com/not-note' },
        ],
        sourceUrl: 'https://www.xiaohongshu.com/user/profile/abc',
      }),
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: true }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())

    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: {
        url: 'https://www.xiaohongshu.com/user/profile/abc',
        tabId: 'agent-tab-1',
        surface: 'agent-view',
        template: 'article_list',
        outputRootDir: '/tmp/ao-i',
      },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['completed'], 6_000)
    const result = done.result as { discoveryStatus?: string; outputRootDir?: string; noteCandidates: Array<{ url: string; openUrl: string; title?: string; sourceId?: string }>; suggestedNextTool?: { name: string; args: { output_root_dir?: string; source_task_id?: string; expected_count?: number } } }

    assert.equal(result.discoveryStatus, 'complete')
    assert.equal(done.progress.total, 1)
    assert.equal(done.progress.completed, 0, 'discovery count must not be rendered as saved count')
    assert.deepEqual(result.noteCandidates.map((target) => ({ url: target.url, openUrl: target.openUrl, title: target.title, sourceId: target.sourceId })), [
      {
        url: 'https://www.xiaohongshu.com/explore/6a0987c5000000003601f3f5',
        openUrl: 'https://www.xiaohongshu.com/explore/6a0987c5000000003601f3f5',
        title: '门主',
        sourceId: '6a0987c5000000003601f3f5',
      },
    ])
    assert.equal(result.suggestedNextTool?.name, 'browser_collect')
    assert.equal(result.outputRootDir, '/tmp/ao-i')
    assert.equal(result.suggestedNextTool?.args.output_root_dir, '/tmp/ao-i')
    assert.equal(result.suggestedNextTool?.args.source_task_id, handle.taskId)
    assert.equal(result.suggestedNextTool?.args.expected_count, 1)
  })

  it('accepts Xiaohongshu account-page note-item links as collection targets', async () => {
    const persistence = new FakePersistence()
    const sourceUrl = 'https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f'
    const capability = {
      navigateTargetTab: async (tabId: string, url: string) => ({ success: true, tabId, reused: true, url }),
      extractStructured: async () => ({
        template: 'card_list' as const,
        items: [
          {
            sourceUrl,
            title: '日常的一点静物',
            link: 'https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f/6928017e000000001e0334f4?xsec_token=token-a&xsec_source=pc_user',
            media: ['https://sns-webpic-qc.xhscdn.com/a.webp'],
            rawFields: {
              structure: {
                inNavigationRegion: false,
                inSidebarRegion: true,
                inHeaderRegion: false,
                inMainContentRegion: false,
                nearestTagName: 'section',
                containerClass: 'note-item',
              },
            },
          },
          {
            sourceUrl,
            title: '静物｜固发液',
            link: 'https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f/6a3e596f00000000210088e4?xsec_token=token-b&xsec_source=pc_user',
            media: ['https://sns-webpic-qc.xhscdn.com/b.webp'],
            rawFields: {
              structure: {
                inNavigationRegion: false,
                inSidebarRegion: true,
                inHeaderRegion: false,
                inMainContentRegion: false,
                nearestTagName: 'section',
                containerClass: 'note-item',
              },
            },
          },
          {
            sourceUrl,
            title: 'RED',
            link: 'https://www.xiaohongshu.com/red_video',
            rawFields: {
              structure: {
                inSidebarRegion: true,
              },
            },
          },
        ],
        sourceUrl,
      }),
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: true }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())

    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: {
        url: sourceUrl,
        tabId: 'agent-tab-1',
        surface: 'agent-view',
        template: 'card_list',
        outputRootDir: '/tmp/ahui',
      },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['completed'], 6_000)
    const result = done.result as { discoveryStatus?: string; noteCandidates: Array<{ url: string; openUrl: string; sourceId?: string }>; targetQuality?: string; suggestedNextTool?: { name: string; args: { expected_count?: number } } }

    assert.equal(result.discoveryStatus, 'complete')
    assert.equal(result.targetQuality, 'trustworthy')
    assert.equal(result.noteCandidates.length, 2)
    assert.equal(result.noteCandidates[0].sourceId, '6928017e000000001e0334f4')
    assert.match(result.noteCandidates[0].openUrl, /xsec_token=token-a/)
    assert.equal(result.suggestedNextTool?.name, 'browser_collect')
    assert.equal(result.suggestedNextTool?.args.expected_count, 2)
  })

  it('marks discovery incomplete when frozen count is below userExpectedTotal', async () => {
    const persistence = new FakePersistence()
    const capability = createCapability([
      [{ link: 'https://example.com/post/1', title: 'One' }],
      [{ link: 'https://example.com/post/1', title: 'One' }],
    ])
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', maxRounds: 10, userExpectedTotal: 3 },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['paused'])
    const result = done.result as {
      discoveryStatus?: string
      frozenCount?: number
      userExpectedTotal?: number
      suggestedNextTool?: unknown
      suggestedContinueTool?: { name?: string }
    }
    assert.equal(result.discoveryStatus, 'partial')
    assert.equal(result.frozenCount, 1)
    assert.equal(result.userExpectedTotal, 3)
    assert.equal(result.suggestedNextTool, undefined)
    assert.equal(result.suggestedContinueTool?.name, 'browser_task')
    assert.equal(done.progress.completed, 0)
  })

  it('cancellation leaves the task queryable with cancelled status', async () => {
    const persistence = new FakePersistence()
    // A feed that never runs dry, so the loop relies on cancellation to stop.
    const endless = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async () => {
        const id = Math.random().toString(36).slice(2)
        return {
          template: 'card_list' as const,
          items: [{ sourceUrl: 'https://example.com/feed', title: `Post ${id}`, link: `https://example.com/post/${id}` }],
          sourceUrl: 'u',
        }
      },
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: false }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(endless, persistence as never, new BrowserWriteLeaseService())
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', maxItems: 100000, maxRounds: 100000, maxDurationMs: 60000 },
    })
    await runner.cancelTask(handle.taskId)
    const task = await waitForStatus(persistence, handle.taskId, ['cancelled'])
    assert.equal(task.status, 'cancelled')
  })

  it('cancellation preserves partial items and frozen collect candidates for handoff', async () => {
    const persistence = new FakePersistence()
    let seq = 0
    let releaseScroll: (() => void) | null = null
    const scrollGate = new Promise<void>((resolve) => { releaseScroll = resolve })
    const endless = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async () => {
        await new Promise((r) => setTimeout(r, 0))
        seq += 1
        return {
          template: 'card_list' as const,
          items: [
            { sourceUrl: 'https://example.com/feed', title: `Post ${seq}`, link: `https://example.com/post/${seq}` },
          ],
          sourceUrl: 'https://example.com/feed',
        }
      },
      scrollViewportOnce: async () => {
        await scrollGate
        return { scrollY: 0, atBottom: false }
      },
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(endless, persistence as never, new BrowserWriteLeaseService())
    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', maxItems: 100000, maxRounds: 100000, maxDurationMs: 60000 },
    })
    await waitForProgress(persistence, handle.taskId, (task) => (task?.progress.total || 0) > 0)
    await runner.cancelTask(handle.taskId)
    releaseScroll?.()
    const task = await waitForResult<{ stopReason?: string; noteCandidates?: unknown[] }>(
      persistence,
      handle.taskId,
      (result) => result?.stopReason === 'cancelled' && Array.isArray(result.noteCandidates) && result.noteCandidates.length > 0,
    )

    assert.equal(task.status, 'cancelled')
    const result = task.result as {
      discoveryStatus?: string
      noteCandidates: Array<{ url: string }>
      suggestedNextTool?: { args?: { source_task_id?: string } }
      suggestedContinueTool?: { name?: string; args?: { task_id?: string } }
    }
    assert.equal(result.discoveryStatus, 'paused')
    assert.ok(result.noteCandidates.length > 0)
    assert.equal(result.suggestedNextTool, undefined)
    assert.equal(result.suggestedContinueTool?.name, 'browser_task')
    assert.equal(result.suggestedContinueTool?.args?.task_id, handle.taskId)
  })

  it('does not let a model-supplied high-control maxItems=30 turn into the full target', async () => {
    const persistence = new FakePersistence()
    const visibleItems = Array.from({ length: 75 }, (_, index) => {
      const id = index + 1
      return { sourceUrl: 'https://example.com/feed', title: `Post ${id}`, link: `https://example.com/post/${id}` }
    })
    const capability = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async () => ({
        template: 'card_list' as const,
        items: visibleItems,
        sourceUrl: 'https://example.com/feed',
      }),
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: true }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())

    const handle = await runner.startTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', highControl: true, maxItems: 30 },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['completed'], 6_000)
    const result = done.result as {
      discoveryStatus?: string
      stopReason?: string
      frozenCount?: number
      hasMoreLikely?: boolean
      suggestedNextTool?: unknown
      suggestedContinueTool?: { name?: string; args?: { task_id?: string } }
    }

    assert.equal(result.stopReason, 'no_new_content')
    assert.equal(result.discoveryStatus, 'complete')
    assert.equal(result.frozenCount, 75)
    assert.equal(result.hasMoreLikely, false)
    assert.equal(result.suggestedContinueTool, undefined)
    assert.equal(result.suggestedNextTool && typeof result.suggestedNextTool === 'object', true)
  })

  it('resumes from the last round checkpoint instead of restarting from scratch', async () => {
    const persistence = new FakePersistence()
    // Seed a task that already collected items 1-3 across 2 rounds, then paused.
    const seeded = persistence.createTask({ kind: 'visible_collect', payload: { template: 'card_list', tabId: 'tab-1', maxRounds: 50 } })
    const priorItems = [
      { sourceUrl: 'u', title: 'One', link: 'https://example.com/1' },
      { sourceUrl: 'u', title: 'Two', link: 'https://example.com/2' },
      { sourceUrl: 'u', title: 'Three', link: 'https://example.com/3' },
    ]
    persistence.updateProgress(seeded.taskId, { total: 3, completed: 3 }, {
      status: 'paused',
      checkpoint: { taskId: seeded.taskId, stage: 'visible_collect_round', cursor: '2', partialResults: priorItems },
    })

    // On resume the feed re-serves item 3 (already seen) plus a new item 4.
    const capability = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async () => ({
        template: 'card_list' as const,
        items: [
          { sourceUrl: 'u', title: 'Three', link: 'https://example.com/3' },
          { sourceUrl: 'u', title: 'Four', link: 'https://example.com/4' },
        ],
        sourceUrl: 'u',
      }),
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: true }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, new BrowserWriteLeaseService())

    await runner.resumeTask(seeded.taskId)
    const done = await waitForStatus(persistence, seeded.taskId, ['completed'])
    const result = done.result as { items: Array<{ link: string }>; rounds: number }
    const links = result.items.map((i) => i.link).sort()
    // Prior 3 are retained (not re-collected as duplicates) and only item 4 is added.
    assert.deepEqual(links, ['https://example.com/1', 'https://example.com/2', 'https://example.com/3', 'https://example.com/4'])
    assert.ok(result.rounds > 2, 'round counter continued from the checkpoint cursor (2), not from 0')
  })

  it('reacquires a fresh lease when a restarted task carries a stale process-local lease id', async () => {
    const persistence = new FakePersistence()
    const seeded = persistence.createTask({
      kind: 'visible_collect',
      payload: { template: 'card_list', tabId: 'tab-1', maxRounds: 2, surface: 'user-view', leaseId: 'lease-from-old-process' },
    })
    persistence.updateProgress(seeded.taskId, { total: 1 }, {
      status: 'paused',
      checkpoint: {
        taskId: seeded.taskId,
        stage: 'visible_collect_round',
        cursor: '1',
        partialResults: [{ sourceUrl: 'u', title: 'One', link: 'https://example.com/1' }],
      },
    })
    const lease = new BrowserWriteLeaseService()
    const seenLeaseIds: string[] = []
    const capability = {
      extractStructured: async () => ({
        template: 'card_list' as const,
        items: [{ sourceUrl: 'u', title: 'Two', link: 'https://example.com/2' }],
        sourceUrl: 'u',
      }),
      scrollViewportOnce: async (_tabId: string, gate: { leaseId: string }) => {
        seenLeaseIds.push(gate.leaseId)
        assert.equal(lease.checkWrite({ surface: 'user-view', leaseId: gate.leaseId }), null)
        return { scrollY: 0, atBottom: true }
      },
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, lease)

    await runner.resumeTask(seeded.taskId)
    const done = await waitForStatus(persistence, seeded.taskId, ['completed'])
    assert.equal(done.status, 'completed')
    assert.ok(seenLeaseIds.length > 0)
    assert.notEqual(seenLeaseIds[0], 'lease-from-old-process')
    assert.equal(persistence.store.get(seeded.taskId)?.payload.leaseId, seenLeaseIds[0])
  })

  it('the background loop stops with lease_lost when the user takes over (no bypass of the lease)', async () => {
    const persistence = new FakePersistence()
    const lease = new BrowserWriteLeaseService()
    // An agent run holds the user-view lease, then the user takes over.
    const held = lease.acquire({ surface: 'user-view', taskId: 'agent-run', runId: 'agent-run' })
    if ('errorCode' in held) throw new Error('expected lease')
    lease.recordUserSignal({ surface: 'user-view', source: 'keyboard' })

    // An endless feed: only the lease check can stop it.
    let extractCalls = 0
    const endless = {
      openTarget: async () => ({ success: true, tabId: 'tab-1' }),
      extractStructured: async () => {
        extractCalls += 1
        const id = Math.random().toString(36).slice(2)
        return { template: 'card_list' as const, items: [{ sourceUrl: 'u', title: id, link: `https://example.com/${id}` }], sourceUrl: 'u' }
      },
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: false }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(endless, persistence as never, lease)

    const handle = await runner.startTask({
      kind: 'visible_collect',
      // Inherit the (now taken-over) lease so the loop must detect the takeover.
      payload: { template: 'card_list', tabId: 'tab-1', maxRounds: 100000, surface: 'user-view', leaseId: held.leaseId },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['paused'])
    const result = done.result as { stopReason: string; items: unknown[] }
    assert.equal(result.stopReason, 'lease_lost', 'must stop because the lease was lost to the user')
    assert.equal(extractCalls, 0, 'must not perform any page write/extract after losing the lease')
  })

  it('does NOT open/navigate the url when an inherited lease is already taken over', async () => {
    const persistence = new FakePersistence()
    const lease = new BrowserWriteLeaseService()
    const held = lease.acquire({ surface: 'user-view', taskId: 'agent-run', runId: 'agent-run' })
    if ('errorCode' in held) throw new Error('expected lease')
    lease.recordUserSignal({ surface: 'user-view', source: 'keyboard' })

    let openTargetCalls = 0
    let extractCalls = 0
    const capability = {
      openTarget: async () => { openTargetCalls += 1; return { success: true, tabId: 'tab-1' } },
      extractStructured: async () => { extractCalls += 1; return { template: 'card_list' as const, items: [], sourceUrl: 'u' } },
      scrollViewportOnce: async () => ({ scrollY: 0, atBottom: false }),
    } as unknown as BrowserCapabilityService
    const runner = new BrowserContentTaskRunner(capability, persistence as never, lease)

    const handle = await runner.startTask({
      kind: 'visible_collect',
      // url path + inherited lease that is already taken over.
      payload: { url: 'https://example.com/feed', template: 'card_list', surface: 'user-view', leaseId: held.leaseId },
    })
    const done = await waitForStatus(persistence, handle.taskId, ['paused'])
    const result = done.result as { stopReason: string }
    assert.equal(result.stopReason, 'lease_lost')
    assert.equal(openTargetCalls, 0, 'must not open/navigate the page after the lease was lost')
    assert.equal(extractCalls, 0)
  })
})
