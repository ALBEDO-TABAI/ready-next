import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, readFile } from 'node:fs/promises'

import { BrowserContentTaskRunner, normalizeHighControlCollectionPlan, type CollectorFacadeFactory } from '../main/modules/browser-engine/content-task-runner'
import type { NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('content-task-runner-note-collect declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'content-task-runner-note-collect transitive sqlite load')
})

// --- In-memory fakes (no SQLite / no Electron) ----------------------------------

interface FakeTask {
  taskId: string
  kind: string
  status: string
  progress: { total: number; completed: number; failed: number; currentLabel: string | null }
  checkpoint: unknown
  result: unknown
  error: string | null
  payload: Record<string, unknown>
}

function fakePersistence() {
  const tasks = new Map<string, FakeTask>()
  const updates: Array<{
    taskId: string
    progress: Partial<FakeTask['progress']>
    extras: Record<string, unknown>
  }> = []
  let counter = 0
  const svc = {
    createTask(request: { kind: string; payload: Record<string, unknown> }) {
      const taskId = `task-${++counter}`
      const task: FakeTask = {
        taskId,
        kind: request.kind,
        status: 'queued',
        progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
        checkpoint: null,
        result: null,
        error: null,
        payload: request.payload,
      }
      tasks.set(taskId, task)
      return { taskId, kind: request.kind, status: 'queued', progress: task.progress }
    },
    getTask(taskId: string) {
      const t = tasks.get(taskId)
      return t ? { ...t } : null
    },
    getTaskPayload(taskId: string) {
      return tasks.get(taskId)?.payload ?? null
    },
    listPendingTasks() {
      return [...tasks.values()].filter((t) => ['queued', 'running', 'paused'].includes(t.status))
    },
    listTasks() {
      return [...tasks.values()]
    },
    updateProgress(taskId: string, progress: Partial<FakeTask['progress']>, extras?: Record<string, unknown>) {
      const t = tasks.get(taskId)
      if (!t) return null
      updates.push({ taskId, progress, extras: extras || {} })
      t.progress = { ...t.progress, ...progress }
      if (extras) {
        if ('status' in extras) t.status = extras.status as string
        if ('checkpoint' in extras) t.checkpoint = extras.checkpoint
        if ('result' in extras) t.result = extras.result
        if ('error' in extras) t.error = extras.error as string | null
      }
      return { ...t }
    },
  }
  return { svc, tasks, updates }
}

function fakeLease(opts: { acquireFails?: boolean; writeDeniedAfter?: () => boolean } = {}) {
  const released: string[] = []
  const acquired: Array<{ surface?: string; taskId?: string; runId?: string; tabId?: string }> = []
  const svc = {
    acquire(input?: { surface?: string; taskId?: string; runId?: string; tabId?: string }) {
      if (opts.acquireFails) return { ok: false, errorCode: 'lease_held', message: 'held' }
      acquired.push(input || {})
      return { leaseId: 'lease-xyz', surface: input?.surface || 'agent-view', acquiredAt: 0, expiresAt: 0 }
    },
    checkWrite() {
      return opts.writeDeniedAfter && opts.writeDeniedAfter() ? { ok: false, errorCode: 'lease_takeover', message: 'gone' } : null
    },
    heartbeat() {
      return { leaseId: 'lease-xyz' }
    },
    release(leaseId: string) {
      released.push(leaseId)
    },
  }
  return { svc, released, acquired }
}

const imagesJson = JSON.stringify({ count: 1, images: [{ url: 'https://img.xhscdn.com/a.jpg' }] })

function okFacadeFactory(extra?: { isFrozen?: () => boolean }): CollectorFacadeFactory {
  return () => {
    const facade: NoteCollectFacade = {
      run: async (tool) => {
        if (tool === 'browser_get_tabs') return [
          '[tab-agent-1] 详情页',
          '    https://www.xiaohongshu.com/note/0',
          '    https://www.xiaohongshu.com/note/1',
          '    https://www.xiaohongshu.com/note/2',
          '    https://www.xiaohongshu.com/note/3',
          '    https://www.xiaohongshu.com/note/4',
        ].join('\n')
        if (tool === 'browser_read_page') return '详情页：笔记0 笔记1 笔记2'
        if (tool === 'browser_collect_images') return imagesJson
        if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
        return JSON.stringify({ ok: true })
      },
    }
    return { facade, isControlFrozen: extra?.isFrozen ?? (() => false) }
  }
}

function layoutLockFacadeFactory(events: string[]): CollectorFacadeFactory {
  return () => {
    const base = okFacadeFactory()({ agentTabId: 'tab-agent-1', leaseId: 'lease-xyz', surface: 'agent-view' })
    events.push('lock')
    return {
      ...base,
      releaseLayoutLock: () => events.push('release'),
    }
  }
}

function planPayload(noteCount: number) {
  return {
    agentTabId: 'tab-agent-1',
    surface: 'agent-view',
    plan: {
      targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/abc',
      notes: Array.from({ length: noteCount }, (_, i) => ({ url: `https://www.xiaohongshu.com/note/${i}`, title: `笔记${i}` })),
      outputRootDir: join(tmpdir(), 'ready-note-collect-test'),
    },
  }
}

async function runToCompletion(runner: BrowserContentTaskRunner, payload: Record<string, unknown>): Promise<string> {
  const handle = await runner.startTask({ kind: 'note_collect', payload })
  // The run is scheduled (fire-and-forget); await the internal promise.
  const run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(handle.taskId)
  if (run) await run
  return handle.taskId
}

async function drainAutoContinuedTask(
  runner: BrowserContentTaskRunner,
  taskId: string,
  tasks: Map<string, FakeTask>,
): Promise<void> {
  const activeRuns = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const run = activeRuns.get(taskId)
    if (run) await run
    await new Promise((resolve) => setTimeout(resolve, 5))
    const task = tasks.get(taskId)
    const result = task?.result as { autoContinue?: boolean } | null
    if (!activeRuns.has(taskId) && result?.autoContinue !== true) return
  }
  throw new Error('auto-continued browser collection did not settle')
}

function slowOkFacadeFactory(): CollectorFacadeFactory {
  return () => {
    const facade: NoteCollectFacade = {
      run: async (tool) => {
        if (tool === 'browser_collect_images') {
          await new Promise((resolve) => setTimeout(resolve, 3))
          return imagesJson
        }
        if (tool === 'browser_get_tabs') return [
          '[tab-agent-1] 详情页',
          '    https://www.xiaohongshu.com/note/0',
          '    https://www.xiaohongshu.com/note/1',
          '    https://www.xiaohongshu.com/note/2',
        ].join('\n')
        if (tool === 'browser_read_page') return '详情页：笔记0 笔记1 笔记2'
        if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
        return JSON.stringify({ ok: true })
      },
    }
    return { facade, isControlFrozen: () => false }
  }
}

describe('note_collect background task (content-task-runner)', () => {
  it('acquires an agent-view lease, collects every note, completes, and releases the lease', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease, released } = fakeLease()
    const runner = new BrowserContentTaskRunner(
      {} as never,
      persistence as never,
      lease as never,
      okFacadeFactory(),
    )
    const taskId = await runToCompletion(runner, planPayload(3))
    const task = tasks.get(taskId)!
    assert.equal(task.status, 'completed')
    const result = task.result as { collected: string[]; stopReason: string }
    assert.equal(result.collected.length, 3)
    assert.equal(result.stopReason, 'completed')
    assert.deepEqual(released, ['lease-xyz'], 'lease released exactly once')
  })

  it('holds a layout lock for the agent tab while note collection is running', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const layoutLockEvents: string[] = []
    const runner = new BrowserContentTaskRunner(
      {} as never,
      persistence as never,
      lease as never,
      layoutLockFacadeFactory(layoutLockEvents),
    )
    const taskId = await runToCompletion(runner, planPayload(2))
    const task = tasks.get(taskId)!

    assert.equal(task.status, 'completed')
    assert.deepEqual(layoutLockEvents, ['lock', 'release'])
  })

  it('uses a user-view lease when card_loop inherits the visible profile tab', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease, acquired, released } = fakeLease()
    const runner = new BrowserContentTaskRunner(
      {} as never,
      persistence as never,
      lease as never,
      okFacadeFactory(),
    )
    const payload = {
      ...planPayload(2),
      agentTabId: 'tab-profile-1',
      surface: 'user-view',
      plan: {
        ...planPayload(2).plan,
        strategy: 'card_loop',
        sourceTaskId: 'visible-source-1',
      },
    }
    const taskId = await runToCompletion(runner, payload)
    const task = tasks.get(taskId)!

    assert.equal(task.status, 'completed')
    assert.equal(acquired[0]?.surface, 'user-view')
    assert.equal(acquired[0]?.tabId, 'tab-profile-1')
    assert.deepEqual(released, ['lease-xyz'])
  })

  it('does not add a hidden maxNotes=60 clamp to high-control plans', () => {
    const rawPlan = planPayload(75).plan
    const plan = normalizeHighControlCollectionPlan(rawPlan)

    assert.equal(plan.notes.length, 75)
    assert.equal(plan.stopConditions?.maxNotes, undefined)
    assert.equal(plan.stopConditions?.maxConsecutiveFailures, 3)
  })

  it('auto-continues max_duration segment pauses until the note collection completes', async () => {
    const { svc: persistence, tasks, updates } = fakePersistence()
    const { svc: lease } = fakeLease()
    const runner = new BrowserContentTaskRunner(
      {} as never,
      persistence as never,
      lease as never,
      slowOkFacadeFactory(),
    )
    const payload = {
      ...planPayload(3),
      scopeId: 'conv-auto-continue',
      plan: {
        ...planPayload(3).plan,
        stopConditions: { maxDurationMs: 1, maxConsecutiveFailures: 3 },
      },
    }

    const handle = await runner.startTask({ kind: 'note_collect', payload })
    await drainAutoContinuedTask(runner, handle.taskId, tasks)

    const task = tasks.get(handle.taskId)!
    const result = task.result as { collected: string[]; stopReason: string; autoContinue?: boolean }
    assert.equal(task.status, 'completed')
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.collected.length, 3)
    assert.equal(result.autoContinue, false)
    const segmentPauses = updates
      .map((update) => update.extras.result as { stopReason?: string; autoContinue?: boolean; resumeFromCursor?: number } | undefined)
      .filter((resultUpdate) => resultUpdate?.stopReason === 'max_duration')
    assert.ok(segmentPauses.length >= 1, 'at least one max_duration segment pause was persisted')
    assert.ok(segmentPauses.every((resultUpdate) => resultUpdate?.autoContinue === true), 'max_duration pauses are marked for auto continuation')
    assert.ok(segmentPauses.every((resultUpdate) => Number(resultUpdate?.resumeFromCursor || 0) > 0), 'auto continuation only starts after useful checkpoint progress')
  })

  it('allows more consecutive failures for high-control card_loop plans', () => {
    const rawPlan = {
      ...planPayload(75).plan,
      strategy: 'card_loop' as const,
    }
    const plan = normalizeHighControlCollectionPlan(rawPlan)

    assert.equal(plan.stopConditions?.maxConsecutiveFailures, 8)
  })

  it('fails cleanly when no collector facade factory is wired', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, null)
    const taskId = await runToCompletion(runner, planPayload(2))
    const task = tasks.get(taskId)!
    assert.equal(task.status, 'failed')
    assert.match(task.error || '', /facade factory/)
  })

  it('fails when the agent-view lease cannot be acquired', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease({ acquireFails: true })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory())
    const taskId = await runToCompletion(runner, planPayload(2))
    const task = tasks.get(taskId)!
    assert.equal(task.status, 'failed')
    assert.match(task.error || '', /lease/)
  })

  it('rejects an invalid plan / missing agent tab', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory())
    const taskId = await runToCompletion(runner, { agentTabId: '', plan: { notes: [] } })
    const task = tasks.get(taskId)!
    assert.equal(task.status, 'failed')
  })

  it('stops with stopReason cancelled when the user freezes agent control', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease, released } = fakeLease()
    const runner = new BrowserContentTaskRunner(
      {} as never,
      persistence as never,
      lease as never,
      okFacadeFactory({ isFrozen: () => true }), // frozen from the start
    )
    const taskId = await runToCompletion(runner, planPayload(5))
    const task = tasks.get(taskId)!
    // A user freeze is NOT a successful completion — the task ends 'cancelled'.
    assert.equal(task.status, 'cancelled')
    const result = task.result as { collected: string[]; stopReason: string }
    assert.equal(result.stopReason, 'cancelled')
    assert.equal(result.collected.length, 0, 'a freeze before the first note collects nothing')
    assert.deepEqual(released, ['lease-xyz'], 'lease still released on a frozen stop')
  })

  it('stops with stopReason lease_lost when the lease is taken over mid-run', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    let notesNavigated = 0
    const lease = {
      acquire: () => ({ leaseId: 'lease-xyz', surface: 'agent-view', acquiredAt: 0, expiresAt: 0 }),
      checkWrite: () => (notesNavigated >= 2 ? { ok: false, errorCode: 'lease_takeover', message: 'gone' } : null),
      heartbeat: () => ({ leaseId: 'lease-xyz' }),
      release: () => {},
    }
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool) => {
          if (tool === 'browser_navigate') notesNavigated += 1
          if (tool === 'browser_collect_images') return imagesJson
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)
    const taskId = await runToCompletion(runner, planPayload(10))
    const task = tasks.get(taskId)!
    const result = task.result as { stopReason: string }
    assert.equal(result.stopReason, 'lease_lost')
    assert.equal(task.status, 'paused', 'a lease takeover is a recoverable pause, not a successful completion')
  })

  it('marks an incomplete high-control collection as user-takeover paused — never completed', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const failingFactory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool) => {
          if (tool === 'browser_navigate') return JSON.stringify({ ok: false, errorCode: 'navigation_failed', message: 'x' })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, failingFactory)
    const taskId = await runToCompletion(runner, planPayload(10))
    const task = tasks.get(taskId)!
    const result = task.result as { stopReason: string; collected: string[]; failed: unknown[]; verdict?: string }
    // Red line (CLAUDE.md 采集判定): 0 collected must NEVER surface as completed.
    assert.notEqual(task.status, 'completed', 'an empty collection must never be reported as completed')
    // P1-R1 (f8682671, rescope doc §7): on a HIGH-CONTROL platform (this plan is
    // XHS) an empty/blocked collection is a recoverable user-takeover pause, not
    // a hard failure. Generic sites keep 'failed' — pinned by
    // collection-verdict-matrix.test.ts Q1 / "generic-site pollution stays hard failed".
    assert.equal(task.status, 'paused')
    assert.equal(result.verdict, 'needs_user_takeover')
    assert.equal(result.stopReason, 'too_many_failures')
    assert.equal(result.collected.length, 0)
    assert.equal(result.failed.length, 3, 'high-control collections clamp the consecutive failure budget')
  })

  it('card_loop clicks a card and returns without navigating directly to the detail URL', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool, args = {}) => {
          calls.push({ tool, args })
          if (tool === 'browser_get_tabs') return '[tab-agent-1] 详情页\n    https://www.xiaohongshu.com/note/0'
          if (tool === 'browser_read_page') return '详情页：笔记0 source 0'
          if (tool === 'browser_collect_images') return imagesJson
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)
    const payload = {
      ...planPayload(1),
      plan: {
        ...planPayload(1).plan,
        strategy: 'card_loop',
        notes: [{ url: 'https://www.xiaohongshu.com/note/0', title: '笔记0', sourceId: '0' }],
      },
    }
    const handle = await runner.startTask({ kind: 'card_loop', payload })
    const run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(handle.taskId)
    if (run) await run

    const task = tasks.get(handle.taskId)!
    assert.equal(task.status, 'completed')
    assert.ok(calls.some((call) => call.tool === 'browser_click_text'), 'card_loop must open via a visible card click')
    assert.ok(calls.some((call) => call.tool === 'browser_go_back'), 'card_loop must return to the list after collecting')
    const navigations = calls.filter((call) => call.tool === 'browser_navigate')
    assert.deepEqual(navigations.map((call) => call.args.url), ['https://www.xiaohongshu.com/user/profile/abc'])
    assert.ok(navigations.every((call) => !String(call.args.url || '').includes('/note/')), 'card_loop must not hard-jump detail URLs')
  })

  it('card_loop completes a 120-card local fixture without URL jumping and writes root artifacts', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const outputRootDir = await mkdtemp(join(tmpdir(), 'ready-card-loop-120-'))
    const clickedTitles: string[] = []
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    let currentTitle = ''
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool, args = {}) => {
          calls.push({ tool, args })
          if (tool === 'browser_click_text') {
            currentTitle = String(args?.text || '')
            clickedTitles.push(currentTitle)
            return JSON.stringify({ ok: true })
          }
          if (tool === 'browser_get_tabs') return `[tab-agent-1] 详情页\n    ${notes.find((note) => note.title === currentTitle)?.url || ''}`
          if (tool === 'browser_read_page') return `详情页：${currentTitle}`
          if (tool === 'browser_collect_images') return imagesJson
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)
    const notes = Array.from({ length: 120 }, (_, i) => ({
      url: `https://fixture.example.test/note/${i}`,
      title: `Fixture Note ${String(i + 1).padStart(3, '0')}`,
      sourceId: `fixture-${i}`,
      order: i + 1,
      kind: 'content',
    }))
    const handle = await runner.startTask({
      kind: 'card_loop',
      payload: {
        agentTabId: 'tab-agent-1',
        surface: 'agent-view',
        plan: {
          targetProfileUrl: 'https://fixture.example.test/profile/local',
          strategy: 'card_loop',
          notes,
          outputRootDir,
        },
      },
    })
    const run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(handle.taskId)
    if (run) await run

    const task = tasks.get(handle.taskId)!
    const result = task.result as { collected: string[]; failed: unknown[]; stopReason: string; collectionManifestPath?: string; collectionReportPath?: string }
    assert.equal(task.status, 'completed')
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.collected.length, 120)
    assert.equal(result.failed.length, 0)
    assert.equal(clickedTitles.length, 120)
    assert.equal(calls.filter((call) => call.tool === 'browser_click_text').length, 120)
    assert.equal(calls.filter((call) => call.tool === 'browser_go_back').length, 120)
    const navigations = calls.filter((call) => call.tool === 'browser_navigate')
    assert.deepEqual(navigations.map((call) => call.args.url), ['https://fixture.example.test/profile/local'])
    assert.ok(navigations.every((call) => !String(call.args.url || '').includes('/note/')), 'card_loop must not navigate to fixture detail URLs')
    assert.ok(result.collectionManifestPath, 'root collection manifest path is recorded')
    assert.ok(result.collectionReportPath, 'root collection report path is recorded')
    const manifest = JSON.parse(await readFile(result.collectionManifestPath!, 'utf8')) as { completed?: number; failed?: number; total?: number }
    const report = await readFile(result.collectionReportPath!, 'utf8')
    assert.equal(manifest.total, 120)
    assert.equal(manifest.completed, 120)
    assert.equal(manifest.failed, 0)
    assert.match(report, /成功：120/)
  })

  it('downloads video targets without collecting covers or failing the whole batch', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const calls: string[] = []
    let collectCalls = 0
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool) => {
          calls.push(tool)
          if (tool === 'browser_collect_images') {
            collectCalls += 1
            return collectCalls <= 2
              ? JSON.stringify({
                count: 0,
                images: [],
                videoCount: 1,
                videos: [{ url: 'https://sns-video.xhscdn.com/video.mp4', width: 716, height: 378 }],
              })
              : imagesJson
          }
          if (tool === 'browser_resolve_video') {
            return JSON.stringify({ ok: true, video: { parseStatus: 'not_needed', downloadUrl: 'https://sns-video.xhscdn.com/video.mp4' } })
          }
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1, results: [{ success: true, path: '/out/assets/video-1.mp4' }] })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)
    const payload = {
      ...planPayload(2),
      plan: {
        ...planPayload(2).plan,
        notes: [
          { url: 'https://www.xiaohongshu.com/video/0', title: '视频0', sourceId: 'v0', kind: 'video' },
          { url: 'https://www.xiaohongshu.com/note/1', title: '笔记1', sourceId: 'n1', kind: 'content' },
        ],
      },
    }

    const taskId = await runToCompletion(runner, payload)
    const task = tasks.get(taskId)!
    const result = task.result as { collected: string[]; failed: Array<{ reason: string }>; stopReason: string }

    assert.equal(task.status, 'completed')
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.collected.length, 2)
    assert.deepEqual(result.failed.map((item) => item.reason), [])
    assert.equal(calls.filter((tool) => tool === 'browser_resolve_video').length, 1)
    assert.equal(calls.filter((tool) => tool === 'browser_collect_images').length, 3)
  })

  it('treats discovered video-only details as downloadable without failing the whole batch', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    let collectCalls = 0
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool) => {
          if (tool === 'browser_collect_images') {
            collectCalls += 1
            return collectCalls <= 2
              ? JSON.stringify({
                count: 0,
                images: [],
                videoCount: 1,
                videos: [{ url: 'https://sns-video.xhscdn.com/video.mp4', width: 716, height: 378 }],
              })
              : imagesJson
          }
          if (tool === 'browser_resolve_video') {
            return JSON.stringify({ ok: true, video: { parseStatus: 'not_needed', downloadUrl: 'https://sns-video.xhscdn.com/video.mp4' } })
          }
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1, results: [{ success: true, path: '/out/assets/video-1.mp4' }] })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)

    const taskId = await runToCompletion(runner, planPayload(2))
    const task = tasks.get(taskId)!
    const result = task.result as { collected: string[]; failed: Array<{ reason: string }>; stopReason: string }

    assert.equal(task.status, 'completed')
    assert.equal(task.error, null)
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.collected.length, 2)
    assert.deepEqual(result.failed.map((item) => item.reason), [])
  })

  it('treats unavailable details as terminal skips without failing the whole batch', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    let pageReads = 0
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool) => {
          if (tool === 'browser_read_page') {
            pageReads += 1
            return pageReads === 1
              ? '小红书 - 你访问的页面不见了 当前笔记暂时无法浏览'
              : JSON.stringify({ ok: true })
          }
          if (tool === 'browser_collect_images') return imagesJson
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)

    const taskId = await runToCompletion(runner, planPayload(2))
    const task = tasks.get(taskId)!
    const result = task.result as { collected: string[]; failed: Array<{ reason: string }>; stopReason: string }

    assert.equal(task.status, 'completed')
    assert.equal(task.error, null)
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.collected.length, 1)
    assert.deepEqual(result.failed.map((item) => item.reason), ['unavailable'])
  })

  it('pauses for verification without marking the current note failed, then resumes from the same cursor', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    let verifyOnce = true
    const navigated: string[] = []
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool, args) => {
          if (tool === 'browser_navigate') navigated.push(String(args?.url))
          if (tool === 'browser_read_page' && verifyOnce) {
            verifyOnce = false
            return '请扫码登录后继续查看内容'
          }
          if (tool === 'browser_collect_images') return imagesJson
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)

    const handle = await runner.startTask({ kind: 'note_collect', payload: planPayload(2) })
    let run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(handle.taskId)
    if (run) await run

    const paused = tasks.get(handle.taskId)!
    assert.equal(paused.status, 'waiting_human')
    assert.equal(paused.progress.completed, 0)
    assert.equal(paused.progress.failed, 0)
    const pausedResult = paused.result as { status?: string; remaining?: number; resumeFromCursor?: number; stopReason?: string }
    assert.equal(pausedResult.status, 'paused_verification')
    assert.equal(pausedResult.stopReason, 'needs_verification')
    assert.equal(pausedResult.remaining, 2)
    assert.equal(pausedResult.resumeFromCursor, 0)
    assert.equal((paused.checkpoint as { cursor?: string; stage?: string })?.stage, 'note_collect_round')
    assert.equal((paused.checkpoint as { cursor?: string })?.cursor, '0')

    await runner.resumeTask(handle.taskId)
    run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(handle.taskId)
    if (run) await run

    const done = tasks.get(handle.taskId)!
    assert.equal(done.status, 'completed')
    const doneResult = done.result as { collected: string[]; remaining?: number }
    assert.equal(doneResult.collected.length, 2)
    assert.equal(doneResult.remaining, 0)
    assert.deepEqual(navigated, [
      'https://www.xiaohongshu.com/note/0',
      'https://www.xiaohongshu.com/note/0',
      'https://www.xiaohongshu.com/note/1',
    ])
  })

  it('does not let cancel overwrite a task paused for verification', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool) => {
          if (tool === 'browser_read_page') return '请扫码登录后继续查看内容'
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)
    const taskId = await runToCompletion(runner, planPayload(1))
    const before = tasks.get(taskId)!
    assert.equal(before.status, 'waiting_human')

    await runner.cancelTask(taskId)
    const after = tasks.get(taskId)!
    assert.equal(after.status, 'waiting_human')
    const result = after.result as { status?: string; stopReason?: string }
    assert.equal(result.status, 'paused_verification')
    assert.equal(result.stopReason, 'needs_verification')
  })
})

describe('note_collect → chat task projection (scope-bound)', () => {
  type Upsert = { taskId: string; scopeId: string; state: string; total: number; completed: number; summary: string }
  function fakeSink() {
    const upserts: Upsert[] = []
    return { sink: { upsert: (i: Upsert) => upserts.push(i) }, upserts }
  }
  const scopedPayload = (n: number) => ({ ...planPayload(n), scopeId: 'conv-abc' })

  it('projects running on start, on each note, and completed at the end — all bound to the scope', async () => {
    const { svc: persistence } = fakePersistence()
    const { svc: lease } = fakeLease()
    const { sink, upserts } = fakeSink()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory())
    runner.setTaskProjectionSink(sink as never)
    await runToCompletion(runner, scopedPayload(2))
    assert.ok(upserts.length >= 3, 'start + per-note + terminal projections')
    assert.ok(upserts.every((u) => u.scopeId === 'conv-abc'), 'every projection bound to the dispatching scope')
    assert.equal(upserts[0].state, 'running', 'first projection is running')
    assert.equal(upserts[upserts.length - 1].state, 'completed', 'final projection is completed')
    assert.equal(upserts[upserts.length - 1].total, 2)
  })

  it('does NOT project when no scopeId is supplied (non-chat dispatch)', async () => {
    const { svc: persistence } = fakePersistence()
    const { svc: lease } = fakeLease()
    const { sink, upserts } = fakeSink()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory())
    runner.setTaskProjectionSink(sink as never)
    await runToCompletion(runner, planPayload(2)) // no scopeId
    assert.equal(upserts.length, 0, 'no scopeId → no projection, no cross-talk')
  })

  it('projects cancelled (not completed) when the user freezes control', async () => {
    const { svc: persistence } = fakePersistence()
    const { svc: lease } = fakeLease()
    const { sink, upserts } = fakeSink()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory({ isFrozen: () => true }))
    runner.setTaskProjectionSink(sink as never)
    await runToCompletion(runner, scopedPayload(5))
    assert.equal(upserts[upserts.length - 1].state, 'cancelled', 'a freeze projects a cancelled card, not completed')
  })

  it('does not let a stale agent-view freeze cancel user-view card_loop collection', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease } = fakeLease()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory({ isFrozen: () => true }))
    const base = scopedPayload(1)
    const payload = {
      ...base,
      surface: 'user-view',
      plan: { ...(base.plan as Record<string, unknown>), strategy: 'card_loop' },
    }
    const handle = await runner.startTask({ kind: 'card_loop', payload })
    const run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(handle.taskId)
    if (run) await run
    assert.equal(tasks.get(handle.taskId)?.status, 'completed')
  })

  it('projects paused when verification is required', async () => {
    const { svc: persistence } = fakePersistence()
    const { svc: lease } = fakeLease()
    const { sink, upserts } = fakeSink()
    const factory: CollectorFacadeFactory = () => ({
      facade: {
        run: async (tool) => {
          if (tool === 'browser_read_page') return '请扫码登录后继续查看内容'
          return JSON.stringify({ ok: true })
        },
      },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, factory)
    runner.setTaskProjectionSink(sink as never)
    await runToCompletion(runner, scopedPayload(1))
    assert.equal(upserts[upserts.length - 1].state, 'paused')
    assert.match(upserts[upserts.length - 1].summary, /等待验证/)
  })

  it('reprojects linked terminal collection tasks on sink reattach without reviving standalone terminal tasks', async () => {
    const { svc: persistence } = fakePersistence()
    const { svc: lease } = fakeLease()
    const { sink, upserts } = fakeSink()
    const completed = persistence.createTask({ kind: 'note_collect', payload: scopedPayload(1) })
    persistence.updateProgress(completed.taskId, { total: 1, completed: 1, failed: 0 }, { status: 'completed' })
    const failed = persistence.createTask({ kind: 'note_collect', payload: scopedPayload(1) })
    persistence.updateProgress(failed.taskId, { total: 1, completed: 0, failed: 1 }, { status: 'failed' })
    const cancelled = persistence.createTask({ kind: 'visible_collect', payload: scopedPayload(1) })
    persistence.updateProgress(cancelled.taskId, { total: 1, completed: 0, failed: 0 }, { status: 'cancelled' })
    const running = persistence.createTask({ kind: 'note_collect', payload: scopedPayload(2) })
    persistence.updateProgress(running.taskId, { total: 2, completed: 1, failed: 0 }, { status: 'running' })
    const linkedFailed = persistence.createTask({
      kind: 'card_loop',
      payload: {
        ...scopedPayload(3),
        plan: {
          ...(scopedPayload(3).plan as Record<string, unknown>),
          strategy: 'card_loop',
          sourceTaskId: 'browser-task-visible-source',
        },
      },
    })
    persistence.updateProgress(linkedFailed.taskId, { total: 3, completed: 0, failed: 3 }, { status: 'failed' })

    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory())
    runner.setTaskProjectionSink(sink as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(upserts.map((item) => item.taskId), [running.taskId, linkedFailed.taskId])
    assert.equal(upserts[0].state, 'running')
    assert.equal(upserts[1].state, 'failed')
  })

  it('B3: pauses a stale cursor-less note_collect as rerunnable on restart, without auto-resuming (lease safety)', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease, released } = fakeLease()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory())
    // Seed a pending note_collect as if left over from a previous session whose
    // agent tab is now gone. resumePendingTasks must NOT auto-resume it (which
    // would re-acquire a lease against a dead tab and block new collections) —
    // B3 pauses it with a rerun marker so the user can explicitly rerun later in
    // a live session; the lease-safety property (no lease on startup) is kept.
    const handle = persistence.createTask({ kind: 'note_collect', payload: scopedPayload(3) })
    await runner.resumePendingTasks()
    const task = tasks.get(handle.taskId)!
    assert.equal(task.status, 'paused', 'stale note_collect pauses (rerunnable), not silently cancelled')
    assert.equal((task.result as { resumeKind?: string })?.resumeKind, 'rerun_from_request', 'carries the rerun marker')
    assert.equal(released.length, 0, 'no lease acquired/held on startup (not auto-resumed)')
  })

  it('projects failed (not stuck running) when the collection loop throws (Codex #A)', async () => {
    const { svc: persistence } = fakePersistence()
    const { svc: lease } = fakeLease()
    const { sink, upserts } = fakeSink()
    const throwingFactory = () => ({
      facade: { run: async () => { throw new Error('boom') } },
      isControlFrozen: () => false,
    })
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, throwingFactory as never)
    runner.setTaskProjectionSink(sink as never)
    await runToCompletion(runner, scopedPayload(3))
    assert.equal(upserts[upserts.length - 1].state, 'failed', 'an uncaught throw must settle the card to failed, not leave it running')
  })
})
