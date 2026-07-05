import type React from 'react'
import {
  IconAlertTriangle as AlertTriangle,
  IconCheck as Check,
  IconListDetails as ListMinus,
  IconLoader2 as Loader2,
} from '@tabler/icons-react'
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

export function PendingClipRow({
  taskId,
  status,
  urlHost,
  title,
  errorMessage,
  message,
  progress,
  depth,
  kind = 'clip',
  onDismiss,
}: {
  taskId: string
  status: PendingPlaceholderStatus
  urlHost: string
  title: string
  errorMessage?: string
  message?: string | null
  progress?: number
  depth: number
  kind?: PendingPlaceholderKind
  onDismiss?: (taskId: string) => void
}) {
  const isFailure = status === 'failed' || status === 'skipped'
  const isComplete = status === 'completed' || status === 'success'
  const canDismiss = isFailure || isComplete
  const isActive =
    status === 'running'
    || status === 'waiting_for_clip'
    || status === 'queued'
    || status === 'running_script'
    || status === 'running_subagent'
  const isAnalysis = isAnalysisPlaceholderKind(kind)
  const progressValue = clampProgress(progress)
  const baseStyle: React.CSSProperties = {
    padding: '6px 8px',
    paddingLeft: `${8 + depth * 22}px`,
    opacity: isFailure ? 0.85 : isComplete ? 0.78 : 0.72,
    pointerEvents: canDismiss ? 'auto' : 'none',
    userSelect: 'none',
    cursor: canDismiss ? 'pointer' : 'default',
    background: isFailure ? 'color-mix(in srgb, var(--color-rose-light, #fee2e2) 36%, transparent)' : 'transparent',
    boxShadow:
      isComplete
        ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-green, #10b981) 38%, transparent)'
        : isFailure
          ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-rose, #f43f5e) 32%, transparent)'
          : 'inset 0 0 0 1px rgba(148, 163, 184, 0.22)',
  }
  const label = pendingPlaceholderLabel(kind, status)
  const dismiss = () => {
    if (canDismiss) onDismiss?.(taskId)
  }
  return (
    <div
      aria-disabled={!canDismiss}
      aria-live={status === 'failed' ? 'polite' : undefined}
      className="rounded-[8px] text-[13px]"
      role={canDismiss ? 'button' : undefined}
      style={baseStyle}
      tabIndex={canDismiss ? 0 : undefined}
      title={canDismiss ? '点击清除提示' : undefined}
      onClick={(event) => {
        event.stopPropagation()
        dismiss()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }}
    >
      <div className="flex items-center gap-[6px]">
        <span
          aria-hidden
          className="flex items-center justify-center"
          style={{ width: 16, height: 16 }}
        >
          {isActive ? (
            <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} strokeWidth={2} />
          ) : isComplete ? (
            <Check style={{ width: 14, height: 14, color: 'var(--color-green, #10b981)' }} strokeWidth={2.5} />
          ) : status === 'paused' ? (
            <ListMinus style={{ width: 14, height: 14, color: 'var(--color-orange, #f59e0b)' }} strokeWidth={2.4} />
          ) : (
            <AlertTriangle style={{ width: 14, height: 14, color: 'var(--color-rose, #f43f5e)' }} strokeWidth={2.4} />
          )}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              color: 'var(--text-muted)',
              fontStyle: 'italic',
            }}
          >
            <span style={{ flexShrink: 0, fontStyle: 'normal', fontVariant: 'all-small-caps', letterSpacing: '0.04em' }}>
              {label}
            </span>
            {isAnalysis && progressValue !== null && (
              <span style={{ flexShrink: 0, fontSize: 11, fontStyle: 'normal', color: 'var(--text-light)' }}>
                {progressValue}%
              </span>
            )}
            <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title || urlHost}
            </span>
          </div>

          {isAnalysis && progressValue !== null && (
            <div
              aria-hidden
              style={{
                marginTop: 4,
                height: 3,
                borderRadius: 999,
                overflow: 'hidden',
                background: 'rgba(148, 163, 184, 0.18)',
              }}
            >
              <div
                style={{
                  width: `${progressValue}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: isFailure
                    ? 'var(--color-rose, #f43f5e)'
                    : isComplete
                      ? 'var(--color-green, #10b981)'
                      : 'var(--color-ready-orange, #ff4b2b)',
                  transition: 'width 240ms ease',
                }}
              />
            </div>
          )}

          {message && !isFailure && (
            <div
              title={message}
              style={{
                marginTop: 2,
                fontSize: 11,
                color: 'var(--text-light)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {message}
            </div>
          )}
        </div>

        {(status === 'failed' || status === 'skipped') && errorMessage && (
          <span
            title={errorMessage}
            style={{
              fontSize: 11,
              color: 'var(--color-rose, #f43f5e)',
              maxWidth: 140,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  )
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
