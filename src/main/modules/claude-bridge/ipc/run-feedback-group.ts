/**
 * D5 后端切片（2026-07-03，梯队三无人值守部分）— per-run 用户反馈通道。
 *
 * 背靠 `run_feedback` 表（migration 036）+ `RunFeedbackRepository`（upsert
 * 语义由 `check-feedback-upsert-shape.cjs` 钉住）。本 group 只做主进程侧：
 * 校验在代码（评分范围/长度上限/空反馈拒绝），存取走注入的 repository。
 * renderer 评分控件属 D5 待做（可监控会话），完成前该能力在
 * `check-mandated-capability-is-live.cjs` 保持 dark-defect 登记。
 */
import type { IpcMain } from 'electron'
import type {
  RunFeedbackListOptions,
  RunFeedbackRecord,
  RunFeedbackUpsertInput,
} from '../../agent-control/task-projection/run-feedback-repository'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'
import { logAgentMetric } from '../../agent-control/metrics'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/** 结构化最小面：生产传真 RunFeedbackRepository，测试可传内存假体。 */
export interface RunFeedbackRepositoryLike {
  upsert(input: RunFeedbackUpsertInput, now?: number): RunFeedbackRecord
  list(options?: RunFeedbackListOptions): RunFeedbackRecord[]
}

export interface RunFeedbackGroupDeps {
  /** 返回 null 表示 SQLite 不可用（native gate 语义），通道以结构化错误响应。 */
  getRepository: () => RunFeedbackRepositoryLike | null
  /**
   * renderer 的任务卡只有 taskId；权威 runId 由 main 侧从 task projection
   * 解析（任务卡代表其当前 run，重试后反馈落最新 run）。返回 null =
   * 无该任务或任务无 run → 通道回 `run_not_found`。
   */
  resolveRunIdForTask?: (taskId: string) => string | null
  now?: () => number
}

export interface RunFeedbackSubmitPayload {
  /** runId 与 taskId 至少给一个；只给 taskId 时由 main 解析 runId。 */
  runId?: string
  taskId?: string | null
  /** 缺省为 `fb_<runId>`：每个 run 一个可修改的反馈槽（upsert 复交）。 */
  feedbackId?: string
  rating?: number | null
  signal?: string | null
  comment?: string | null
}

const CHANNELS = ['agent:runFeedback:submit', 'agent:runFeedback:list'] as const

const SIGNAL_MAX_CHARS = 120
const COMMENT_MAX_CHARS = 2000
const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 200

type NormalizedSubmit =
  | { ok: true; input: RunFeedbackUpsertInput }
  | { ok: false; error: string }

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeSubmitPayload(
  payload: unknown,
  resolveRunIdForTask?: (taskId: string) => string | null,
): NormalizedSubmit {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'invalid_payload' }
  }
  const raw = payload as Record<string, unknown>

  const taskId = asTrimmedString(raw.taskId)
  let runId = asTrimmedString(raw.runId)
  if (!runId && !taskId) return { ok: false, error: 'run_or_task_required' }
  if (!runId && taskId) {
    runId = resolveRunIdForTask ? asTrimmedString(resolveRunIdForTask(taskId)) : null
    if (!runId) return { ok: false, error: 'run_not_found' }
  }
  if (!runId) return { ok: false, error: 'run_or_task_required' }

  const feedbackId = asTrimmedString(raw.feedbackId) ?? `fb_${runId}`

  let rating: RunFeedbackUpsertInput['rating'] = null
  if (raw.rating !== undefined && raw.rating !== null) {
    if (typeof raw.rating !== 'number' || !Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5) {
      return { ok: false, error: 'rating_out_of_range' }
    }
    rating = raw.rating as 1 | 2 | 3 | 4 | 5
  }

  const signal = asTrimmedString(raw.signal)
  if (signal && signal.length > SIGNAL_MAX_CHARS) {
    return { ok: false, error: 'signal_too_long' }
  }
  const comment = asTrimmedString(raw.comment)
  if (comment && comment.length > COMMENT_MAX_CHARS) {
    return { ok: false, error: 'comment_too_long' }
  }

  if (rating === null && !signal && !comment) {
    return { ok: false, error: 'empty_feedback' }
  }

  return { ok: true, input: { feedbackId, runId, taskId, rating, signal, comment } }
}

function normalizeListOptions(payload: unknown): RunFeedbackListOptions {
  const options: RunFeedbackListOptions = {}
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const raw = payload as Record<string, unknown>
    const runId = asTrimmedString(raw.runId)
    const taskId = asTrimmedString(raw.taskId)
    if (runId) options.runId = runId
    if (taskId) options.taskId = taskId
    if (typeof raw.limit === 'number' && Number.isFinite(raw.limit)) {
      options.limit = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(raw.limit)))
    }
  }
  if (options.limit === undefined) options.limit = LIST_DEFAULT_LIMIT
  return options
}

export const runFeedbackGroup: IpcChannelGroup<RunFeedbackGroupDeps> = {
  namespace: 'agent:runFeedback',

  register(ipcMain: IpcMain, deps: RunFeedbackGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle(
      'agent:runFeedback:submit',
      async (_event, payload: unknown): Promise<IPCResponse<RunFeedbackRecord>> => {
        try {
          const repository = deps.getRepository()
          if (!repository) return { success: false, error: 'sqlite_unavailable' }
          const normalized = normalizeSubmitPayload(payload, deps.resolveRunIdForTask)
          if (!normalized.ok) return { success: false, error: normalized.error }
          const now = deps.now ? deps.now() : Date.now()
          const record = repository.upsert(normalized.input, now)
          // live-required 可观测账本（正向 gate 断言此事件存在于本文件）。
          logAgentMetric('run_feedback_submitted', {
            runId: record.runId,
            taskId: record.taskId,
            rating: record.rating,
            hasComment: Boolean(record.comment),
          })
          return { success: true, data: record }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    ipcMain.handle(
      'agent:runFeedback:list',
      async (_event, payload: unknown): Promise<IPCResponse<RunFeedbackRecord[]>> => {
        try {
          const repository = deps.getRepository()
          if (!repository) return { success: false, error: 'sqlite_unavailable' }
          return { success: true, data: repository.list(normalizeListOptions(payload)) }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    return {
      dispose() {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
        }
      },
    }
  },
}

export const _runFeedbackGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
