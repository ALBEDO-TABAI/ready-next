import { useSyncExternalStore } from 'react'
import { Button } from './Button'
import { dismissToast, getToasts, subscribeToasts } from './toast-store'

/** Mounted once for the whole app; showToast() lives in toast-store.ts. */
export function ToastHost() {
  const items = useSyncExternalStore(subscribeToasts, getToasts)
  return (
    <div className="rn-ui rn-toast-stack" role="status" aria-live="polite">
      {items.map(toast => (
        <div key={toast.id} className="rn-float rn-toast" data-tone={toast.tone ?? 'normal'} data-ready-native-overlay="toast">
          <span>{toast.message}</span>
          {toast.action && <Button size="sm" variant="ghost" onClick={() => { toast.action!.onClick(); dismissToast(toast.id) }}>{toast.action.label}</Button>}
        </div>
      ))}
    </div>
  )
}
