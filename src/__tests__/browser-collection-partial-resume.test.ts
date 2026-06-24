import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserContentTaskRunner } from '../main/modules/browser-engine/content-task-runner'
import type { BrowserCapabilityTaskHandle } from '../main/modules/browser-engine/capability-types'
import type { BrowserTaskPersistenceService } from '../main/modules/browser-engine/task-persistence-service'
import type { CollectorFacadeFactory } from '../main/modules/browser-engine/content-task-runner'
import type { NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-collection-partial-resume declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-collection-partial-resume transitive sqlite load')
})

function makeTask(overrides: Partial<BrowserCapabilityTaskHandle> = {}): BrowserCapabilityTaskHandle {
  return {
    taskId: overrides.taskId || 'browser-task-note-partial',
    kind: overrides.kind || 'note_collect',
    status: overrides.status || 'running',
    progress: overrides.progress || {
      total: 69,
      completed: 47,
      failed: 2,
      currentLabel: 'item 48',
    },
    checkpoint: overrides.checkpoint,
    result: overrides.result,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt || '2026-06-09T08:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-06-09T08:05:00.000Z',
  }
}

interface FakeStoredTask {
  taskId: string
  kind: string
  status: string
  progress: { total: number; completed: number; failed: number; currentLabel: string | null }
  checkpoint: BrowserCapabilityTaskHandle['checkpoint']
  result: unknown
  error: string | null
  payload: Record<string, unknown>
}

function fakeLease() {
  return {
    acquire: () => ({ leaseId: 'lease-partial-resume', surface: 'agent-view', acquiredAt: 0, expiresAt: 0 }),
    checkWrite: () => null,
    heartbeat: () => ({ leaseId: 'lease-partial-resume' }),
    release: () => {},
  }
}

function fakePersistenceWithTask(task: FakeStoredTask) {
  const store = new Map<string, FakeStoredTask>([[task.taskId, task]])
  return {
    getTask: (taskId: string) => {
      const current = store.get(taskId)
      return current ? { ...current } : null
    },
    getTaskPayload: (taskId: string) => store.get(taskId)?.payload ?? null,
    updateProgress: (taskId: string, progress: Partial<FakeStoredTask['progress']>, extras?: Record<string, unknown>) => {
      const current = store.get(taskId)
      if (!current) return null
      current.progress = { ...current.progress, ...progress }
      if (extras) {
        if ('status' in extras) current.status = String(extras.status)
        if ('checkpoint' in extras) current.checkpoint = extras.checkpoint as FakeStoredTask['checkpoint']
        if ('result' in extras) current.result = extras.result
        if ('error' in extras) current.error = extras.error as string | null
      }
      return { ...current }
    },
    listPendingTasks: () => [...store.values()].filter((item) => ['queued', 'running', 'paused'].includes(item.status)).map((item) => ({ ...item })),
  }
}

test('browser collection startup keeps saved note_collect cursor resumable', async () => {
  const task = makeTask({
    checkpoint: {
      taskId: 'browser-task-note-partial',
      stage: 'note_collect_round',
      cursor: '47',
      partialResults: {
        cursor: 47,
        collected: Array.from({ length: 47 }, (_, index) => ({ url: `https://example.com/${index}` })),
        failed: [],
        outputs: [],
        consecutiveFailures: 0,
        startedAt: 1780000000000,
      },
    },
  })
  const updates: Array<{ taskId: string; extras: Record<string, unknown> }> = []
  const persistence = {
    listPendingTasks: () => [task],
    getTaskPayload: () => ({
      scopeId: 'scope-browser-partial',
      agentTabId: 'stale-agent-tab',
      plan: {
        targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/demo',
        outputRootDir: '/tmp/ready-browser-partial',
        notes: [],
      },
    }),
    updateProgress: (taskId: string, _progress: unknown, extras?: Record<string, unknown>) => {
      updates.push({ taskId, extras: extras || {} })
      return task
    },
  } as unknown as BrowserTaskPersistenceService
  const runner = new BrowserContentTaskRunner({} as never, persistence)

  await runner.resumePendingTasks()

  assert.equal(updates.length, 1)
  assert.equal(updates[0].taskId, 'browser-task-note-partial')
  assert.equal(updates[0].extras.status, 'paused')
  assert.equal(updates[0].extras.finishedAt, null)
  // B3 — a cursor task now also carries the rerun marker (resumable floor); the
  // checkpoint is left untouched so the resume-time strict check still
  // cursor-continues it. The marker just guarantees canResumeTask is true.
  assert.equal((updates[0].extras.result as { resumeKind?: string })?.resumeKind, 'rerun_from_request')
  assert.equal('checkpoint' in updates[0].extras, false, 'checkpoint_json is preserved untouched (not overwritten)')
})

test('B3: startup pauses a cursor-less note_collect as a rerun (not a silent cancel)', async () => {
  const task = makeTask({
    taskId: 'browser-task-note-empty',
    checkpoint: null,
    progress: { total: 69, completed: 0, failed: 0, currentLabel: null },
  })
  const updates: Array<{ taskId: string; extras: Record<string, unknown> }> = []
  const persistence = {
    listPendingTasks: () => [task],
    getTaskPayload: () => ({ scopeId: 'scope-browser-empty', agentTabId: 'stale-agent-tab', plan: { notes: [] } }),
    updateProgress: (taskId: string, _progress: unknown, extras?: Record<string, unknown>) => {
      updates.push({ taskId, extras: extras || {} })
      return task
    },
  } as unknown as BrowserTaskPersistenceService
  const runner = new BrowserContentTaskRunner({} as never, persistence)

  await runner.resumePendingTasks()

  // B3 — no cursor → paused + rerun marker, NOT cancelled (the request survives).
  assert.equal(updates.length, 1)
  assert.equal(updates[0].extras.status, 'paused')
  assert.equal(updates[0].extras.finishedAt, null)
  assert.equal((updates[0].extras.result as { resumeKind?: string })?.resumeKind, 'rerun_from_request')
})

test('B3: a paused cursor-less task with the rerun marker is resumable (reruns from the original payload)', async () => {
  const scheduled: Array<{ taskId: string; kind: string }> = []
  const task: FakeStoredTask = {
    taskId: 'browser-task-rerun',
    kind: 'note_collect',
    status: 'paused',
    progress: { total: 5, completed: 0, failed: 0, currentLabel: null },
    checkpoint: null, // no cursor → only the rerun marker makes it resumable
    result: { resumeKind: 'rerun_from_request', restartReason: 'restart' },
    error: 'note_collect paused on restart; resumable as a rerun from the original request',
    payload: {
      scopeId: 'scope-rerun',
      agentTabId: 'tab-rerun',
      plan: {
        targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/rerun',
        notes: [{ url: 'https://www.xiaohongshu.com/note/r1', title: 'n1' }],
        outputRootDir: '/tmp/ready-rerun',
      },
    },
  }
  const persistence = fakePersistenceWithTask(task)
  const runner = new BrowserContentTaskRunner({} as never, persistence as unknown as BrowserTaskPersistenceService)
  // Observe that resume re-dispatches the task (rerun from payload) rather than refusing.
  ;(runner as unknown as { scheduleTask: (taskId: string, kind: string) => void }).scheduleTask = (taskId, kind) => {
    scheduled.push({ taskId, kind })
    persistence.updateProgress(taskId, {}, { status: 'running' })
  }

  const resumed = await runner.resumeTask('browser-task-rerun')

  assert.deepEqual(scheduled, [{ taskId: 'browser-task-rerun', kind: 'note_collect' }], 'rerun marker → re-dispatched from payload')
  assert.equal(resumed?.status, 'running')
})

test('B3: a task the startup layer would call "has checkpoint" but the resume layer rejects still reruns (no paused-but-stuck)', async () => {
  // Loose checkpoint (stage + cursor + partialResults) that the OLD startup rule
  // accepted as "has checkpoint" — but the runner's strict hasBrowserTaskCheckpoint
  // ALSO requires a valid plan, which this payload lacks → strict resume rejects.
  // The unified fix always writes the rerun marker on pause, so it stays resumable.
  const scheduled: Array<{ taskId: string; kind: string }> = []
  const task: FakeStoredTask = {
    taskId: 'browser-task-loose-ckpt',
    kind: 'note_collect',
    status: 'paused',
    progress: { total: 5, completed: 2, failed: 0, currentLabel: null },
    checkpoint: {
      taskId: 'browser-task-loose-ckpt',
      stage: 'note_collect_round',
      cursor: '2',
      partialResults: { cursor: 2, collected: [], failed: [], outputs: [], consecutiveFailures: 0, startedAt: 1 },
    },
    // marker present because B3 now writes it on EVERY restart pause
    result: { resumeKind: 'rerun_from_request', restartReason: 'restart' },
    error: 'note_collect paused on restart; resumable',
    payload: { scopeId: 'scope-loose', agentTabId: 'tab-loose', plan: { notes: 'not-a-valid-plan' } },
  }
  const persistence = fakePersistenceWithTask(task)
  const runner = new BrowserContentTaskRunner({} as never, persistence as unknown as BrowserTaskPersistenceService)
  ;(runner as unknown as { scheduleTask: (taskId: string, kind: string) => void }).scheduleTask = (taskId, kind) => {
    scheduled.push({ taskId, kind })
    persistence.updateProgress(taskId, {}, { status: 'running' })
  }

  const resumed = await runner.resumeTask('browser-task-loose-ckpt')

  assert.deepEqual(scheduled, [{ taskId: 'browser-task-loose-ckpt', kind: 'note_collect' }],
    'strict-reject + rerun marker → still re-dispatched (not paused-but-stuck)')
  assert.equal(resumed?.status, 'running')
})

test('browser_resume_task with a failed task and failure ledger retries only failed collection items', async () => {
  const urls = Array.from({ length: 5 }, (_, index) => `https://www.xiaohongshu.com/note/partial-${index}`)
  const failedUrl = urls[2]
  const navigated: string[] = []
  const task: FakeStoredTask = {
    taskId: 'browser-task-ledger-resume',
    kind: 'note_collect',
    status: 'failed',
    progress: { total: 5, completed: 4, failed: 1, currentLabel: null },
    payload: {
      agentTabId: 'tab-agent-resume',
      surface: 'agent-view',
      plan: {
        targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/partial',
        notes: urls.map((url, index) => ({ url, title: `笔记${index + 1}` })),
        outputRootDir: '/tmp/ready-browser-partial-resume',
        stopConditions: { maxConsecutiveFailures: 10 },
      },
    },
    checkpoint: {
      taskId: 'browser-task-ledger-resume',
      stage: 'note_collect_round',
      cursor: '5',
      partialResults: {
        cursor: 5,
        collected: urls.filter((url) => url !== failedUrl),
        failed: [{ url: failedUrl, reason: 'navigate:navigation_failed', attempts: 1, retryable: true }],
        failures: [{ url: failedUrl, reason: 'navigate:navigation_failed', attempts: 1, retryable: true }],
        retryCursor: [failedUrl],
        outputs: urls.map((url, index) => ({
          url,
          title: `笔记${index + 1}`,
          success: url !== failedUrl,
          savedDir: url === failedUrl ? '' : `/tmp/ready-browser-partial-resume/${index + 1}`,
          imageCount: url === failedUrl ? 0 : 1,
          reason: url === failedUrl ? 'navigate:navigation_failed' : undefined,
        })),
        consecutiveFailures: 0,
        startedAt: 1780000000000,
      },
    },
    result: {
      failed: [{ url: failedUrl, reason: 'navigate:navigation_failed', attempts: 1, retryable: true }],
    },
    error: null,
  }
  const persistence = fakePersistenceWithTask(task)
  const factory: CollectorFacadeFactory = () => {
    const facade: NoteCollectFacade = {
      run: async (tool, args = {}) => {
        if (tool === 'browser_navigate') {
          navigated.push(String(args.url || ''))
          return JSON.stringify({ ok: true })
        }
        if (tool === 'browser_read_page') return '详情页'
        if (tool === 'browser_collect_images') return JSON.stringify({ count: 1, images: [{ url: 'https://img.xhscdn.com/resume.jpg' }] })
        if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
        return JSON.stringify({ ok: true })
      },
    }
    return { facade, isControlFrozen: () => false }
  }
  const runner = new BrowserContentTaskRunner({} as never, persistence as never, fakeLease() as never, factory)

  await runner.resumeTask(task.taskId)
  const run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(task.taskId)
  if (run) await run

  assert.deepEqual(navigated, [failedUrl])
  assert.equal(task.status, 'completed')
  assert.equal(task.progress.completed, 5)
  assert.equal(task.progress.failed, 0)
})

test('B3: resuming a LOOSE checkpoint (fails strict check) reruns FRESH — old progress is not reused', async () => {
  const urls = Array.from({ length: 5 }, (_, index) => `https://www.xiaohongshu.com/note/loose-${index}`)
  const navigated: string[] = []
  const task: FakeStoredTask = {
    taskId: 'browser-task-loose-consume',
    kind: 'note_collect',
    status: 'paused',
    progress: { total: 5, completed: 4, failed: 1, currentLabel: null },
    payload: {
      agentTabId: 'tab-loose-consume',
      surface: 'agent-view',
      plan: {
        targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/loose',
        notes: urls.map((url, index) => ({ url, title: `笔记${index + 1}` })),
        outputRootDir: '/tmp/ready-browser-loose-consume',
        stopConditions: { maxConsecutiveFailures: 10 },
      },
    },
    // LOOSE checkpoint: stage + partialResults present, but cursor is EMPTY →
    // fails hasBrowserTaskCheckpoint (which requires a non-empty cursor). The OLD
    // ad-hoc consumption check (stage + partialResults only) would have wrongly
    // reused this as resume progress; the unified strict gate must ignore it.
    checkpoint: {
      taskId: 'browser-task-loose-consume',
      stage: 'note_collect_round',
      cursor: '',
      partialResults: {
        cursor: 4,
        collected: urls.slice(0, 4),
        failed: [{ url: urls[4], reason: 'navigate:navigation_failed', attempts: 1, retryable: true }],
        outputs: [],
        consecutiveFailures: 0,
        startedAt: 1780000000000,
      },
    },
    result: { resumeKind: 'rerun_from_request', restartReason: 'restart' },
    error: 'note_collect paused on restart; resumable',
  }
  const persistence = fakePersistenceWithTask(task)
  const factory: CollectorFacadeFactory = () => ({
    facade: {
      run: async (tool, args = {}) => {
        if (tool === 'browser_navigate') { navigated.push(String(args.url || '')); return JSON.stringify({ ok: true }) }
        if (tool === 'browser_read_page') return '详情页'
        if (tool === 'browser_collect_images') return JSON.stringify({ count: 1, images: [{ url: 'https://img.xhscdn.com/loose.jpg' }] })
        if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
        return JSON.stringify({ ok: true })
      },
    },
    isControlFrozen: () => false,
  })
  const runner = new BrowserContentTaskRunner({} as never, persistence as never, fakeLease() as never, factory)

  await runner.resumeTask(task.taskId)
  const run = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns.get(task.taskId)
  if (run) await run

  // FRESH rerun: every note is navigated (not just the previously-failed one),
  // proving the loose checkpoint's stale "collected" progress was NOT reused.
  assert.deepEqual(navigated, urls, 'loose checkpoint ignored → all notes re-collected from scratch')
})

test('browser_resume_task refuses failed note_collect without checkpoint proof', async () => {
  const task: FakeStoredTask = {
    taskId: 'browser-task-failed-empty',
    kind: 'note_collect',
    status: 'failed',
    progress: { total: 5, completed: 2, failed: 3, currentLabel: null },
    payload: {
      plan: {
        targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/partial',
        notes: [{ url: 'https://www.xiaohongshu.com/note/a', title: 'a' }],
        outputRootDir: '/tmp/ready-browser-failed-empty',
      },
    },
    checkpoint: null,
    result: null,
    error: 'previous failure',
  }
  const persistence = fakePersistenceWithTask(task)
  const runner = new BrowserContentTaskRunner({} as never, persistence as never, fakeLease() as never)

  await runner.resumeTask(task.taskId)

  const activeRuns = (runner as unknown as { activeRuns: Map<string, Promise<void>> }).activeRuns
  assert.equal(activeRuns.has(task.taskId), false)
  assert.equal(task.status, 'failed')
  assert.equal(task.progress.completed, 2)
  assert.equal(task.progress.failed, 3)
})
