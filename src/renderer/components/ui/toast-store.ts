// Toast state (W1 §5): one quiet line above the bottom band; it leaves on its own or with its action.
export interface Toast { id: number; message: string; tone?: 'normal' | 'bad'; action?: { label: string; onClick: () => void } }
let toasts: Toast[] = []
const listeners = new Set<() => void>()
const emit = () => { toasts = [...toasts]; listeners.forEach(listener => listener()) }
let seq = 0

export function subscribeToasts(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getToasts() { return toasts }

export function dismissToast(id: number) { toasts = toasts.filter(toast => toast.id !== id); emit() }

export function showToast(message: string, options: { tone?: Toast['tone']; action?: Toast['action']; durationMs?: number } = {}) {
  const id = ++seq
  toasts.push({ id, message, tone: options.tone, action: options.action })
  emit()
  window.setTimeout(() => dismissToast(id), options.durationMs ?? 4000)
  return id
}
