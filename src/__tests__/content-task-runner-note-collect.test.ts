import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BrowserContentTaskRunner, type CollectorFacadeFactory } from '../main/modules/browser-engine/content-task-runner'
import type { NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

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
    updateProgress(taskId: string, progress: Partial<FakeTask['progress']>, extras?: Record<string, unknown>) {
      const t = tasks.get(taskId)
      if (!t) return null
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
  return { svc, tasks }
}

function fakeLease(opts: { acquireFails?: boolean; writeDeniedAfter?: () => boolean } = {}) {
  const released: string[] = []
  const svc = {
    acquire() {
      if (opts.acquireFails) return { ok: false, errorCode: 'lease_held', message: 'held' }
      return { leaseId: 'lease-xyz', surface: 'agent-view', acquiredAt: 0, expiresAt: 0 }
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
  return { svc, released }
}

const imagesJson = JSON.stringify({ count: 1, images: [{ url: 'https://img.xhscdn.com/a.jpg' }] })

function okFacadeFactory(extra?: { isFrozen?: () => boolean }): CollectorFacadeFactory {
  return () => {
    const facade: NoteCollectFacade = {
      run: async (tool) => {
        if (tool === 'browser_collect_images') return imagesJson
        if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
        return JSON.stringify({ ok: true })
      },
    }
    return { facade, isControlFrozen: extra?.isFrozen ?? (() => false) }
  }
}

function planPayload(noteCount: number) {
  return {
    agentTabId: 'tab-agent-1',
    surface: 'agent-view',
    plan: {
      targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/abc',
      notes: Array.from({ length: noteCount }, (_, i) => ({ url: `https://www.xiaohongshu.com/note/${i}`, title: `笔记${i}` })),
      outputRootDir: '/out',
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
    assert.equal(task.status, 'completed')
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
  })
})
