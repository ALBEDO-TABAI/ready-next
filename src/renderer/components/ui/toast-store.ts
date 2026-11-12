// Toast state (W1 §5): one quiet line in the bottom band — a newer toast takes the place of the one showing, so the
// line never grows over the paper or the native web page; it leaves on its own or with one of its actions.
export interface ToastAction { label: string; onClick: () => void }
export interface Toast { id: number; message: string; tone?: 'normal' | 'bad'; actions?: ToastAction[] }
let toasts: Toast[] = []
const listeners = new Set<() => void>()
const emit = () => { toasts = [...toasts]; listeners.forEach(listener => listener()) }
let seq = 0

export function subscribeToasts(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getToasts() { return toasts }

export function dismissToast(id: number) { toasts = toasts.filter(toast => toast.id !== id); emit() }

export function showToast(message: string, options: { tone?: Toast['tone']; actions?: ToastAction[]; durationMs?: number } = {}) {
  const id = ++seq
  toasts = [{ id, message, tone: options.tone, actions: options.actions }]
  emit()
  window.setTimeout(() => dismissToast(id), options.durationMs ?? 4000)
  return id
}
