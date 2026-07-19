export const BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES = [
  'queued',
  'running',
  'paused',
  'waiting_human',
] as const

export type BrowserSupervisionVisibleTaskStatus = typeof BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES[number]

const BROWSER_SUPERVISION_VISIBLE_TASK_STATUS_SET = new Set<string>(BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES)

export function isBrowserSupervisionVisibleTaskStatus(
  status: string | null | undefined,
): status is BrowserSupervisionVisibleTaskStatus {
  return typeof status === 'string' && BROWSER_SUPERVISION_VISIBLE_TASK_STATUS_SET.has(status)
}

export const BROWSER_SURFACE_PRESENTING_TASK_STATUSES = [
  'queued',
  'running',
  'waiting_human',
] as const

export type BrowserSurfacePresentingTaskStatus = typeof BROWSER_SURFACE_PRESENTING_TASK_STATUSES[number]

const BROWSER_SURFACE_PRESENTING_TASK_STATUS_SET = new Set<string>(BROWSER_SURFACE_PRESENTING_TASK_STATUSES)

export function isBrowserSurfacePresentingTaskStatus(
  status: string | null | undefined,
): status is BrowserSurfacePresentingTaskStatus {
  return typeof status === 'string' && BROWSER_SURFACE_PRESENTING_TASK_STATUS_SET.has(status)
}

export function browserTaskStatusLabel(status: string): string {
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'queued') return '等待中'
  if (status === 'paused') return '暂停'
  if (status === 'waiting_human') return '等待确认'
  return '运行中'
}

export function isBrowserTaskTerminalStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
