import type React from 'react'
import {
  IconAlertTriangle as AlertTriangle,
  IconCheck as Check,
  IconListDetails as ListMinus,
  IconLoader2 as Loader2,
} from '@tabler/icons-react'
import { isAnalysisPlaceholderKind, clampProgress, pendingPlaceholderLabel, type PendingPlaceholderKind, type PendingPlaceholderStatus } from './pending-placeholder-model'

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
