import type React from 'react'
import {
  TriangleAlert as AlertTriangle,
  Check,
  ListMinus,
  LoaderCircle as Loader2,
} from 'lucide-react'
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
    background: isFailure ? 'color-mix(in srgb, var(--rn-bad) 10%, transparent)' : 'transparent',
    boxShadow:
      isComplete
        ? 'inset 0 0 0 .5px color-mix(in srgb, var(--rn-ok) 38%, transparent)'
        : isFailure
          ? 'inset 0 0 0 .5px color-mix(in srgb, var(--rn-bad) 32%, transparent)'
          : 'inset 0 0 0 .5px var(--rn-hair-2)',
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
            <Check style={{ width: 14, height: 14, color: 'var(--rn-ok)' }} strokeWidth={2.5} />
          ) : status === 'paused' ? (
            <ListMinus style={{ width: 14, height: 14, color: 'var(--rn-warn)' }} strokeWidth={2.4} />
          ) : (
            <AlertTriangle style={{ width: 14, height: 14, color: 'var(--rn-bad)' }} strokeWidth={2.4} />
          )}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              color: 'var(--rn-ink-2)',
              fontStyle: 'italic',
            }}
          >
            <span style={{ flexShrink: 0, fontStyle: 'normal', fontVariant: 'all-small-caps', letterSpacing: '0.04em' }}>
              {label}
            </span>
            {isAnalysis && progressValue !== null && (
              <span style={{ flexShrink: 0, fontSize: 11, fontStyle: 'normal', color: 'var(--rn-ink-3)' }}>
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
                background: 'var(--rn-fill-2)',
              }}
            >
              <div
                style={{
                  width: `${progressValue}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: isFailure
                    ? 'var(--rn-bad)'
                    : isComplete
                      ? 'var(--rn-ok)'
                      : 'var(--rn-ink-3)',
                  transition: 'width var(--rn-d-2) var(--rn-ease-out)',
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
                color: 'var(--rn-ink-3)',
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
              color: 'var(--rn-bad)',
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
