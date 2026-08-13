import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskStatus,
} from './capability-types'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

export function buildBrowserTaskEventExtra(
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
    messageVisibilityEpoch: readNumber(payload, ['messageVisibilityEpoch']),
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
