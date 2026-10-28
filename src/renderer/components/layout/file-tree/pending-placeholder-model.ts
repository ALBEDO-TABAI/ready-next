import type { FileTreeAnalysisPlaceholderStatus } from '../fileTreeExternalDrop'

/**
 * Non-selectable background-task placeholder row. Web clip / content study
 * remove themselves when the real file appears; RSS analysis rows follow the
 * persisted job progress until success or failure.
 */
export type PendingPlaceholderKind = 'clip' | 'study' | 'analysis-copy' | 'analysis-visual' | 'download' | 'board-export'
export type PendingPlaceholderStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_for_clip'
  | 'skipped'
  | FileTreeAnalysisPlaceholderStatus

export function isAnalysisPlaceholderKind(kind?: PendingPlaceholderKind): boolean {
  return kind === 'analysis-copy' || kind === 'analysis-visual'
}

export function isActiveAnalysisStatus(status: PendingPlaceholderStatus): boolean {
  return status === 'queued' || status === 'running_script' || status === 'running_subagent'
}

export function clampProgress(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function pendingPlaceholderLabel(kind: PendingPlaceholderKind, status: PendingPlaceholderStatus): string {
  if (kind === 'board-export') {
    if (status === 'running') return '正在导出'
    if (status === 'completed' || status === 'success') return '已导出'
    if (status === 'skipped') return '已跳过'
    return '导出失败'
  }

  if (kind === 'download') {
    if (status === 'running') return '正在下载'
    if (status === 'completed' || status === 'success') return '已下载'
    if (status === 'skipped') return '已跳过'
    return '下载失败'
  }

  if (kind === 'study') {
    if (status === 'waiting_for_clip') return '等待剪藏'
    if (status === 'running') return '生成学习笔记'
    if (status === 'completed' || status === 'success') return '已生成笔记'
    if (status === 'skipped') return '已跳过'
    return '笔记失败'
  }

  if (kind === 'analysis-copy' || kind === 'analysis-visual') {
    const subject = kind === 'analysis-copy' ? '文案' : '视觉'
    if (status === 'queued') return `${subject}排队`
    if (status === 'paused') return `${subject}暂停`
    if (status === 'running_script') return kind === 'analysis-copy' ? '提取文案' : '分析画面'
    if (status === 'running_subagent') return '生成报告'
    if (status === 'success' || status === 'completed') return `${subject}完成`
    if (status === 'skipped') return '已跳过'
    return `${subject}失败`
  }

  if (status === 'running') return '正在剪藏'
  if (status === 'completed' || status === 'success') return '已剪藏'
  if (status === 'waiting_for_clip' || status === 'queued') return '等待中'
  if (status === 'skipped') return '已跳过'
  return '剪藏失败'
}

export interface PendingClipPlaceholder {
  taskId: string
  targetDir: string
  urlHost: string
  title: string
  status: PendingPlaceholderStatus
  copiedPath?: string
  errorMessage?: string
  message?: string | null
  progress?: number
  jobId?: string
  itemId?: string
  outputDir?: string
  reportPath?: string | null
  createdAt: number
  /** Discriminates clip-side placeholder vs study-side placeholder (when
   * the action was 'content-study') and RSS analysis placeholders. */
  kind?: PendingPlaceholderKind
}

interface FileTreeRSSAnalysisJob {
  id: string
  status: FileTreeAnalysisPlaceholderStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
}

export function mapAnalysisJobToPlaceholderPatch(job: FileTreeRSSAnalysisJob): Partial<PendingClipPlaceholder> {
  return {
    status: job.status,
    progress: Number(job.progress) || 0,
    message: job.message,
    errorMessage: job.error || undefined,
    outputDir: job.outputDir,
    reportPath: job.reportPath,
    copiedPath: job.reportPath || job.outputDir,
  }
}

export function isTrackedAnalysisPlaceholder(placeholder: PendingClipPlaceholder): boolean {
  return isAnalysisPlaceholderKind(placeholder.kind) && Boolean(placeholder.jobId)
}

export function analysisPlaceholderTerminalDelay(status: PendingPlaceholderStatus): number | null {
  if (status === 'success' || status === 'completed') return 2600
  if (status === 'failed' || status === 'skipped') return 6000
  return null
}

export function buildAnalysisJobKey(placeholders: PendingClipPlaceholder[]): string {
  return placeholders
    .filter((p) => isTrackedAnalysisPlaceholder(p) && isActiveAnalysisStatus(p.status))
    .map((p) => p.jobId)
    .filter((id): id is string => Boolean(id))
    .sort()
    .join('|')
}
