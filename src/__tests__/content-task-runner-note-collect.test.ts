import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    assert.equal(task.status, 'cancelled', 'a lease takeover is not a successful completion')
  })

  it('marks an incomplete collection as failed instead of completed', async () => {
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
    const result = task.result as { stopReason: string; collected: string[]; failed: unknown[] }
    assert.equal(task.status, 'failed')
    assert.equal(result.stopReason, 'too_many_failures')
    assert.equal(result.collected.length, 0)
    assert.equal(result.failed.length, 3, 'high-control collections clamp the consecutive failure budget')
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

  it('cancels stale note_collect on restart instead of resuming (lease safety)', async () => {
    const { svc: persistence, tasks } = fakePersistence()
    const { svc: lease, released } = fakeLease()
    const runner = new BrowserContentTaskRunner({} as never, persistence as never, lease as never, okFacadeFactory())
    // Seed a pending note_collect as if left over from a previous session whose
    // agent tab is now gone. resumePendingTasks must NOT resume it (which would
    // re-acquire a lease against a dead tab and block new collections).
    const handle = persistence.createTask({ kind: 'note_collect', payload: scopedPayload(3) })
    await runner.resumePendingTasks()
    const task = tasks.get(handle.taskId)!
    assert.equal(task.status, 'cancelled', 'stale note_collect is cancelled, not resumed')
    assert.equal(released.length, 0, 'no lease acquired/held for the stale task')
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
