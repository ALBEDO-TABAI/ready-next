import type { SoftErrorInfo } from '../../modules/agent/types'

/**
 * Phase 3 — soft-failure capsule.
 *
 * Rendered between ChatMessages and the input area (same layer as the tool
 * trace capsule). Shows when scopeRunState.softError is populated — i.e. the
 * main process classified a runtime error as recoverable. Users dismiss the
 * capsule to clear the slot; terminal errors replace the whole flow with a
 * system message instead.
 */
interface Props {
  softError: SoftErrorInfo
  onDismiss: () => void
}

export function SoftFailureCapsule({ softError, onDismiss }: Props) {
  const title = softError.toolName
    ? `工具 ${softError.toolName} 暂时失败`
    : '任务暂时失败'
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 my-2 flex items-center gap-2 rounded-lg border border-amber-200/60 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <span className="font-medium">{title}</span>
      <span className="flex-1 truncate opacity-80">{softError.message}</span>
      <span className="rounded bg-amber-200/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-900/80 dark:bg-amber-500/20 dark:text-amber-200/80">
        {softError.errorKind}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded px-1 opacity-60 transition hover:opacity-100"
        aria-label="Dismiss soft failure"
      >
        ×
      </button>
    </div>
  )
}
