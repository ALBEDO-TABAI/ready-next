import { useRef, useSyncExternalStore } from 'react'
import { Button } from './Button'
import { useLeaveAsGhost } from './leave'
import { dismissToast, getToasts, pauseToast, resumeToast, subscribeToasts, type Toast } from './toast-store'

/** The toast stack's layer (.rn-toast-stack), kept by a leaving toast's copy. */
const TOAST_Z = 6000

/** Mounted once for the whole app; showToast() lives in toast-store.ts. */
export function ToastHost() {
  const items = useSyncExternalStore(subscribeToasts, getToasts)
  return (
    <div className="rn-ui rn-toast-stack" role="status" aria-live="polite">
      {items.map(toast => <ToastLine key={toast.id} toast={toast} />)}
    </div>
  )
}

// A toast rises in (primitives.css); dismissed, or replaced by a newer one, it fades out where it was (motion language M2).
function ToastLine({ toast }: { toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null)
  useLeaveAsGhost(ref, { zIndex: TOAST_Z })
  // Its time stands still while the pointer is on it or focus is in it, and runs on only when both have left.
  const held = useRef({ pointer: false, focus: false })
  const hold = (key: 'pointer' | 'focus', on: boolean) => {
    held.current[key] = on
    if (held.current.pointer || held.current.focus) pauseToast(toast.id)
    else resumeToast(toast.id)
  }
  return (
    <div
      ref={ref}
      className="rn-float rn-toast"
      data-tone={toast.tone ?? 'normal'}
      data-ready-native-overlay="toast"
      onPointerEnter={() => hold('pointer', true)}
      onPointerLeave={() => hold('pointer', false)}
      onFocus={() => hold('focus', true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold('focus', false) }}
    >
      <span>{toast.message}</span>
      {toast.actions?.map(action => (
        <Button key={action.label} size="sm" variant="ghost" onClick={() => { dismissToast(toast.id); action.onClick() }}>{action.label}</Button>
      ))}
    </div>
  )
}
