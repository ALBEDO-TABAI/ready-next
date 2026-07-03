/**
 * D5 后端切片 — run-feedback IPC group 行为测试。
 *
 * 通过假 IpcMain + 内存 repository 直接调用注册的 handler，断言：
 * 校验语义（评分范围/长度上限/空反馈/缺 runId）、默认反馈槽 fb_<runId>
 * 的 upsert 复交、list 过滤与 limit 收敛、SQLite 不可用的结构化错误、
 * dispose 的对称卸载。真实 SQLite 侧的 repository/migration 行为由
 * migration-036-feedback.test.ts（native gate）覆盖，此处不重复。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain } from 'electron'

import {
  runFeedbackGroup,
  _runFeedbackGroupChannelsForTest,
  type RunFeedbackRepositoryLike,
} from '../main/modules/claude-bridge/ipc/run-feedback-group'
import type {
  RunFeedbackListOptions,
  RunFeedbackRecord,
  RunFeedbackUpsertInput,
} from '../main/modules/agent-control/task-projection/run-feedback-repository'

type Handler = (event: unknown, payload: unknown) => Promise<{ success: boolean; data?: unknown; error?: string }>

function makeFakeIpcMain() {
  const handlers = new Map<string, Handler>()
  const removed: string[] = []
  const ipcMain = {
    handle(channel: string, fn: Handler) {
      handlers.set(channel, fn)
    },
    removeHandler(channel: string) {
      removed.push(channel)
      handlers.delete(channel)
    },
  }
  return { ipcMain: ipcMain as unknown as IpcMain, handlers, removed }
}

class InMemoryRunFeedbackRepository implements RunFeedbackRepositoryLike {
  readonly rows = new Map<string, RunFeedbackRecord>()

  upsert(input: RunFeedbackUpsertInput, now: number = Date.now()): RunFeedbackRecord {
    const existing = this.rows.get(input.feedbackId)
    const record: RunFeedbackRecord = {
      feedbackId: input.feedbackId,
      runId: input.runId,
      taskId: input.taskId ?? null,
      rating: input.rating ?? null,
      signal: input.signal ?? null,
      comment: input.comment ?? null,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    }
    this.rows.set(input.feedbackId, record)
    return record
  }

  list(options: RunFeedbackListOptions = {}): RunFeedbackRecord[] {
    let all = [...this.rows.values()]
    if (options.runId !== undefined) all = all.filter((row) => row.runId === options.runId)
    if (options.taskId !== undefined) all = all.filter((row) => row.taskId === options.taskId)
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    return options.limit && options.limit > 0 ? all.slice(0, options.limit) : all
  }
}

function setup(overrides: {
  repository?: RunFeedbackRepositoryLike | null
  now?: () => number
  resolveRunIdForTask?: (taskId: string) => string | null
} = {}) {
  const fake = makeFakeIpcMain()
  const repository = overrides.repository === undefined
    ? new InMemoryRunFeedbackRepository()
    : overrides.repository
  const dispose = runFeedbackGroup.register(fake.ipcMain, {
    getRepository: () => repository,
    resolveRunIdForTask: overrides.resolveRunIdForTask,
    now: overrides.now,
  })
  const submit = fake.handlers.get('agent:runFeedback:submit')!
  const list = fake.handlers.get('agent:runFeedback:list')!
  return { ...fake, repository, dispose, submit, list }
}

test('submit stores feedback in the default fb_<runId> slot and re-submission revises it', async () => {
  const { submit, repository } = setup({ now: () => 1000 })

  const first = await submit(null, { runId: 'run-1', rating: 2, comment: '太慢了' })
  assert.equal(first.success, true)
  const record = first.data as RunFeedbackRecord
  assert.equal(record.feedbackId, 'fb_run-1')
  assert.equal(record.rating, 2)
  assert.equal(record.comment, '太慢了')

  const second = await submit(null, { runId: 'run-1', rating: 5 })
  assert.equal(second.success, true)
  const revised = second.data as RunFeedbackRecord
  assert.equal(revised.feedbackId, 'fb_run-1')
  assert.equal(revised.rating, 5)
  assert.equal(
    (repository as InMemoryRunFeedbackRepository).rows.size,
    1,
    'same run revises the same slot instead of appending',
  )
})

test('submit accepts an explicit feedbackId and optional taskId', async () => {
  const { submit } = setup()
  const result = await submit(null, {
    runId: 'run-2',
    feedbackId: 'fb-custom',
    taskId: 'task-9',
    signal: 'wrong_direction',
  })
  assert.equal(result.success, true)
  const record = result.data as RunFeedbackRecord
  assert.equal(record.feedbackId, 'fb-custom')
  assert.equal(record.taskId, 'task-9')
  assert.equal(record.signal, 'wrong_direction')
})

test('submit rejects invalid payloads with structured errors and writes nothing', async () => {
  const { submit, repository } = setup()
  const cases: Array<[unknown, string]> = [
    [null, 'invalid_payload'],
    [{ rating: 3 }, 'run_or_task_required'],
    [{ runId: '  ' }, 'run_or_task_required'],
    [{ taskId: 'task-unknown', rating: 3 }, 'run_not_found'],
    [{ runId: 'run-3', rating: 0 }, 'rating_out_of_range'],
    [{ runId: 'run-3', rating: 6 }, 'rating_out_of_range'],
    [{ runId: 'run-3', rating: 3.5 }, 'rating_out_of_range'],
    [{ runId: 'run-3', signal: 'x'.repeat(121) }, 'signal_too_long'],
    [{ runId: 'run-3', comment: 'x'.repeat(2001) }, 'comment_too_long'],
    [{ runId: 'run-3' }, 'empty_feedback'],
  ]
  for (const [payload, expected] of cases) {
    const result = await submit(null, payload)
    assert.equal(result.success, false, `${JSON.stringify(payload)} must be rejected`)
    assert.equal(result.error, expected)
  }
  assert.equal((repository as InMemoryRunFeedbackRepository).rows.size, 0)
})

test('submit with taskId resolves the authoritative runId from the projection', async () => {
  const { submit } = setup({
    resolveRunIdForTask: (taskId) => (taskId === 'task-7' ? 'run-77' : null),
  })
  const result = await submit(null, { taskId: 'task-7', rating: 4 })
  assert.equal(result.success, true)
  const record = result.data as RunFeedbackRecord
  assert.equal(record.runId, 'run-77')
  assert.equal(record.feedbackId, 'fb_run-77')
  assert.equal(record.taskId, 'task-7')
})

test('channels answer sqlite_unavailable when the repository is absent', async () => {
  const { submit, list } = setup({ repository: null })
  const submitResult = await submit(null, { runId: 'run-4', rating: 4 })
  assert.deepEqual(submitResult, { success: false, error: 'sqlite_unavailable' })
  const listResult = await list(null, {})
  assert.deepEqual(listResult, { success: false, error: 'sqlite_unavailable' })
})

test('list forwards filters, clamps limit into [1,200], and defaults to 50', async () => {
  const captured: RunFeedbackListOptions[] = []
  const spyRepository: RunFeedbackRepositoryLike = {
    upsert() {
      throw new Error('unused')
    },
    list(options) {
      captured.push(options ?? {})
      return []
    },
  }
  const { list } = setup({ repository: spyRepository })

  await list(null, { runId: 'run-5', taskId: 'task-1', limit: 999 })
  await list(null, { limit: 0.4 })
  await list(null, undefined)

  assert.deepEqual(captured[0], { runId: 'run-5', taskId: 'task-1', limit: 200 })
  assert.deepEqual(captured[1], { limit: 1 })
  assert.deepEqual(captured[2], { limit: 50 })
})

test('dispose removes exactly the two runFeedback handlers and is safe to call twice', () => {
  const { dispose, handlers, removed } = setup()
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [..._runFeedbackGroupChannelsForTest].sort(),
  )
  dispose.dispose()
  dispose.dispose()
  for (const channel of _runFeedbackGroupChannelsForTest) {
    assert.ok(removed.includes(channel), `${channel} must be removed on dispose`)
    assert.ok(!handlers.has(channel))
  }
})
