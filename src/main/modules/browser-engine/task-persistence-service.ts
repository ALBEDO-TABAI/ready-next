import { createHash, randomUUID } from 'crypto'

import { BrowserRepository } from '../repositories/browser-repository'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskKind,
  BrowserCapabilityTaskProgress,
  BrowserCapabilityTaskStatus,
  BrowserStartTaskRequest,
  BrowserTaskCheckpoint,
} from './capability-types'
import { taskEventBridge, toBridgeStatus } from './task-event-bridge'

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function monotonicIsoAfter(previous: string): string {
  const previousMs = Date.parse(previous)
  const now = Date.now()
  return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString()
}

function isTerminalStatus(status: BrowserCapabilityTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function targetIdentity(value: unknown, index: number): { id: string; url: string | null } | null {
  const record = asRecord(value)
  if (!record) return null
  const url = readString(record, ['url', 'canonicalUrl', 'openUrl', 'sourceUrl', 'link'])
  const id = readString(record, ['sourceId', 'id', 'targetId']) || url || `target-${index + 1}`
  return { id, url }
}

type BrowserTaskFailureClassification = NonNullable<BrowserTaskCheckpoint['failures']>[number]['classification']

function failureClassification(reason: string): BrowserTaskFailureClassification {
  if (/captcha|challenge|verification|验证码|验证|扫码|登录墙/i.test(reason)) return 'verification'
  if (/429|rate.?limit|retry-after|限流|频繁/i.test(reason)) return 'rate_limit'
  if (/timeout|network|fetch|connection|dns|socket|导航失败/i.test(reason)) return 'network'
  if (/not.?found|selector|target|目标|元素/i.test(reason)) return 'target_missing'
  if (/unavailable|deleted|不存在|无法浏览|下架/i.test(reason)) return 'unavailable'
  if (/permission|authorization|denied|forbidden|权限|授权/i.test(reason)) return 'authorization'
  return 'unknown'
}

function checkpointTargetSources(payload: Record<string, unknown>, partialResults: unknown): unknown[] {
  const plan = asRecord(payload.plan)
  const partial = asRecord(partialResults)
  if (Array.isArray(plan?.notes)) return plan.notes
  if (Array.isArray(payload.urls)) return payload.urls.map((url) => ({ url }))
  if (Array.isArray(partial?.targets)) return partial.targets
  if (Array.isArray(partialResults)) return partialResults
  return []
}

function checkpointOutputs(partialResults: unknown, result: unknown): unknown[] {
  const partial = asRecord(partialResults)
  const resultRecord = asRecord(result)
  if (Array.isArray(partial?.outputs)) return partial.outputs
  if (Array.isArray(resultRecord?.notes)) return resultRecord.notes
  if (Array.isArray(resultRecord?.results)) return resultRecord.results
  if (Array.isArray(partialResults)) return partialResults
  return []
}

function checkpointFailures(partialResults: unknown, result: unknown): unknown[] {
  const partial = asRecord(partialResults)
  const resultRecord = asRecord(result)
  if (Array.isArray(partial?.failed)) return partial.failed
  if (Array.isArray(resultRecord?.failed)) return resultRecord.failed
  return []
}

export function enrichBrowserTaskCheckpoint(
  checkpoint: Omit<BrowserTaskCheckpoint, 'targetList' | 'failures' | 'outputHashes' | 'binding' | 'nextStep'> & Partial<BrowserTaskCheckpoint>,
  payload: Record<string, unknown>,
  result?: unknown,
): BrowserTaskCheckpoint {
  const targets = checkpointTargetSources(payload, checkpoint.partialResults)
    .map(targetIdentity)
    .filter((target): target is { id: string; url: string | null } => target !== null)
  const outputs = checkpointOutputs(checkpoint.partialResults, result)
  const failures = checkpointFailures(checkpoint.partialResults, result)
  const terminal = ['completed', 'failed', 'cancelled'].includes(checkpoint.stage)
  const cursor = checkpoint.cursor === undefined ? null : checkpoint.cursor
  const tabId = readString(payload, ['tabId', 'agentTabId'])
  const epoch = Number(payload.documentEpoch)
  return {
    ...checkpoint,
    targetList: checkpoint.targetList || targets,
    failures: checkpoint.failures || failures.map((failure, index) => {
      const record = asRecord(failure)
      const reason = String(record?.reason || record?.error || record?.message || 'unknown')
      const identity = targetIdentity(failure, index)
      const classification = failureClassification(reason)
      return {
        targetId: identity?.id || `failure-${index + 1}`,
        classification,
        retryable: typeof record?.retryable === 'boolean'
          ? record.retryable
          : !['verification', 'unavailable', 'authorization'].includes(classification),
      }
    }),
    outputHashes: checkpoint.outputHashes || outputs.map((output, index) => ({
      targetId: targetIdentity(output, index)?.id || `output-${index + 1}`,
      sha256: sha256(output),
    })),
    binding: checkpoint.binding || {
      tabId,
      documentEpoch: Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : null,
    },
    nextStep: checkpoint.nextStep || {
      action: terminal ? 'none' : checkpoint.stage.includes('verification') ? 'verify' : 'resume',
      cursor,
    },
  }
}

function readString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function readNumber(record: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (!record) return null
  for (const key of keys) {
    const value = Number(record[key])
    if (Number.isFinite(value)) return value
  }
  return null
}

function buildTaskEventExtra(
  task: BrowserCapabilityTaskHandle | null,
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!task) return null
  const result = asRecord(task.result)
  const plan = asRecord(payload?.plan)
  const progress = task.progress
  const total = Math.max(0, Number(progress.total || 0))
  const completed = Math.max(0, Number(progress.completed || 0))
  const failed = Math.max(0, Number(progress.failed || 0))
  const explicitRemaining = readNumber(result, ['remaining'])
  const remaining = explicitRemaining ?? Math.max(0, total - completed - failed)
  const stopReason = readString(result, ['stopReason'])
  const autoContinue = result?.autoContinue === true
  const sourceTaskId = readString(result, ['sourceTaskId'])
    || readString(payload, ['sourceTaskId'])
    || readString(plan, ['sourceTaskId'])
  const outputRootDir = readString(result, ['outputRootDir'])
    || readString(payload, ['outputRootDir'])
    || readString(plan, ['outputRootDir'])
  const canResume = task.status !== 'completed'
    && task.status !== 'cancelled'
    && task.status !== 'running'
    && task.status !== 'queued'
    && Boolean(task.checkpoint || asRecord(task.result)?.resumeKind)

  return {
    taskId: task.taskId,
    browserTaskId: task.taskId,
    kind: task.kind,
    scopeId: readString(payload, ['scopeId', 'sessionId', 'publicSessionId']),
    sourceTaskId,
    summary: buildTaskEventSummary(task.status, total, completed, failed, remaining, stopReason),
    progress: {
      total,
      completed,
      failed,
      remaining,
      currentLabel: progress.currentLabel ?? null,
    },
    stopReason,
    autoContinue,
    outputRootDir,
    resumeFromCursor: readNumber(result, ['resumeFromCursor']),
    canResume,
    startedAt: task.startedAt ?? task.createdAt ?? null,
    finishedAt: task.finishedAt ?? null,
    updatedAt: task.updatedAt ?? null,
  }
}

function buildTaskEventSummary(
  status: BrowserCapabilityTaskStatus,
  total: number,
  completed: number,
  failed: number,
  remaining: number,
  stopReason: string | null,
): string {
  if (status === 'completed') return `后台采集完成：已保存 ${completed}/${total}${failed > 0 ? `，失败 ${failed}` : ''}`
  if (status === 'paused') {
    const reason = stopReason === 'max_duration' ? '单段运行保护暂停' : '已暂停'
    return `${reason}：已保存 ${completed}/${total}${remaining > 0 ? `，剩余 ${remaining}` : ''}`
  }
  if (status === 'waiting_human') return `后台采集等待处理：已保存 ${completed}/${total}${remaining > 0 ? `，剩余 ${remaining}` : ''}`
  if (status === 'failed') return `后台采集失败：已保存 ${completed}/${total}${failed > 0 ? `，失败 ${failed}` : ''}`
  return `后台任务状态更新：${status}`
}

export class BrowserTaskPersistenceService {
  constructor(private readonly repository = new BrowserRepository()) {}

  createTask(request: BrowserStartTaskRequest): BrowserCapabilityTaskHandle {
    const now = new Date().toISOString()
    const taskId = `browser-task-${randomUUID()}`
    this.repository.createTask({
      id: taskId,
      kind: request.kind,
      status: 'queued',
      payload_json: JSON.stringify(request.payload || {}),
      checkpoint_json: null,
      result_json: null,
      progress_total: 0,
      progress_completed: 0,
      progress_failed: 0,
      current_label: null,
      error: null,
      created_at: now,
      started_at: null,
      updated_at: now,
      finished_at: null,
    })
    return {
      taskId,
      kind: request.kind,
      status: 'queued',
      progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
      createdAt: now,
      updatedAt: now,
    }
  }

  getTask(taskId: string): BrowserCapabilityTaskHandle | null {
    const record = this.repository.getTask(taskId)
    if (!record) return null
    return {
      taskId: record.id,
      kind: record.kind as BrowserCapabilityTaskKind,
      status: record.status as BrowserCapabilityTaskStatus,
      progress: {
        total: Number(record.progress_total || 0),
        completed: Number(record.progress_completed || 0),
        failed: Number(record.progress_failed || 0),
        currentLabel: record.current_label,
      },
      checkpoint: parseJSON<BrowserTaskCheckpoint | null>(record.checkpoint_json, null),
      result: parseJSON<unknown>(record.result_json, null),
      error: record.error,
      createdAt: record.created_at,
      startedAt: record.started_at,
      finishedAt: record.finished_at,
      updatedAt: record.updated_at,
    }
  }

  getTaskPayload(taskId: string): Record<string, unknown> | null {
    const record = this.repository.getTask(taskId)
    if (!record) return null
    return parseJSON<Record<string, unknown>>(record.payload_json, {})
  }

  updateTaskPayload(taskId: string, payload: Record<string, unknown>): void {
    const current = this.getTask(taskId)
    if (!current) return
    const expectedUpdatedAt = String(current.updatedAt || current.createdAt || '')
    this.repository.updateTask(taskId, {
      payload_json: JSON.stringify(payload || {}),
      updated_at: monotonicIsoAfter(expectedUpdatedAt),
    }, expectedUpdatedAt ? { expectedUpdatedAt } : undefined)
  }

  updateProgress(taskId: string, progress: Partial<BrowserCapabilityTaskProgress>, extras?: {
    checkpoint?: BrowserTaskCheckpoint | null
    status?: BrowserCapabilityTaskStatus
    error?: string | null
    result?: unknown
    startedAt?: string | null
    finishedAt?: string | null
  }): BrowserCapabilityTaskHandle | null {
    const current = this.getTask(taskId)
    if (!current) return null
    const requestedStatus = extras?.status ?? current.status
    if (isTerminalStatus(current.status) && requestedStatus !== current.status) {
      return current
    }

    const nextProgress: BrowserCapabilityTaskProgress = {
      total: progress.total ?? current.progress.total,
      completed: progress.completed ?? current.progress.completed,
      failed: progress.failed ?? current.progress.failed,
      currentLabel: progress.currentLabel ?? current.progress.currentLabel ?? null,
    }
    const expectedUpdatedAt = String(current.updatedAt || current.createdAt || '')
    const updatedAt = monotonicIsoAfter(expectedUpdatedAt)
    const committed = this.repository.updateTask(taskId, {
      status: requestedStatus,
      checkpoint_json: extras?.checkpoint !== undefined
        ? JSON.stringify(extras.checkpoint === null
          ? null
          : enrichBrowserTaskCheckpoint(
              extras.checkpoint,
              this.getTaskPayload(taskId) || {},
              extras.result !== undefined ? extras.result : current.result,
            ))
        : undefined,
      result_json: extras?.result !== undefined ? JSON.stringify(extras.result) : undefined,
      progress_total: nextProgress.total,
      progress_completed: nextProgress.completed,
      progress_failed: nextProgress.failed,
      current_label: nextProgress.currentLabel ?? null,
      error: extras?.error ?? current.error ?? null,
      started_at: extras?.startedAt,
      finished_at: extras?.finishedAt,
      updated_at: updatedAt,
    }, expectedUpdatedAt ? { expectedUpdatedAt } : undefined)

    if (committed === false) return this.getTask(taskId)

    const updated = this.getTask(taskId)
    const bridgeStatus = extras?.status ? toBridgeStatus(extras.status) : null
    if (bridgeStatus) {
      taskEventBridge.publish({
        taskId,
        status: bridgeStatus,
        extra: buildTaskEventExtra(updated, this.getTaskPayload(taskId)),
      })
    }
    return updated
  }

  listPendingTasks(): BrowserCapabilityTaskHandle[] {
    return this.repository
      .listTasks(['queued', 'running', 'paused'])
      .map((record) => ({
        taskId: record.id,
        kind: record.kind as BrowserCapabilityTaskKind,
        status: record.status as BrowserCapabilityTaskStatus,
        progress: {
          total: Number(record.progress_total || 0),
          completed: Number(record.progress_completed || 0),
          failed: Number(record.progress_failed || 0),
          currentLabel: record.current_label,
        },
        checkpoint: parseJSON<BrowserTaskCheckpoint | null>(record.checkpoint_json, null),
        result: parseJSON<unknown>(record.result_json, null),
        error: record.error,
        createdAt: record.created_at,
        startedAt: record.started_at,
        finishedAt: record.finished_at,
        updatedAt: record.updated_at,
      }))
  }

  listTasks(): BrowserCapabilityTaskHandle[] {
    return this.repository
      .listTasks()
      .map((record) => ({
        taskId: record.id,
        kind: record.kind as BrowserCapabilityTaskKind,
        status: record.status as BrowserCapabilityTaskStatus,
        progress: {
          total: Number(record.progress_total || 0),
          completed: Number(record.progress_completed || 0),
          failed: Number(record.progress_failed || 0),
          currentLabel: record.current_label,
        },
        checkpoint: parseJSON<BrowserTaskCheckpoint | null>(record.checkpoint_json, null),
        result: parseJSON<unknown>(record.result_json, null),
        error: record.error,
        createdAt: record.created_at,
        startedAt: record.started_at,
        finishedAt: record.finished_at,
        updatedAt: record.updated_at,
      }))
  }
}
