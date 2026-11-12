import type { SoftErrorInfo } from '../../modules/agent/types'
import { mapBackendErrorToFriendly } from '../../modules/agent/error-message-mapping'

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
  const friendly = softError.friendlyMessage
    ? {
        friendlyMessage: softError.friendlyMessage,
        technicalDetails: softError.technicalDetails || softError.message,
      }
    : mapBackendErrorToFriendly({
        error: softError.message,
        errorKind: softError.errorKind,
      })
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 my-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
      // A recoverable failure is a warning tint on the glass (--rn-warn), ink text (W1 DL6).
      style={{
        border: '1px solid color-mix(in srgb, var(--rn-warn) 30%, transparent)',
        background: 'color-mix(in srgb, var(--rn-warn) 10%, transparent)',
        color: 'var(--rn-ink)',
      }}
    >
      <span className="font-medium">任务暂时失败</span>
      <span className="flex-1 truncate opacity-80">
        {friendly.friendlyMessage}
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
