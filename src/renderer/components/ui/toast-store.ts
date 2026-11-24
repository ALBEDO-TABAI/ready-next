// Toast state (W1 §5): one quiet line in the bottom band — a newer toast takes the place of the one showing, so the
// line never grows over the paper or the native web page; it leaves on its own or with one of its actions. While the
// pointer or focus is on it, its time stands still; a toast with actions stays at least ACTION_TOAST_MS.
export interface ToastAction { label: string; onClick: () => void }
export interface Toast { id: number; message: string; tone?: 'normal' | 'bad'; actions?: ToastAction[] }
let toasts: Toast[] = []
const listeners = new Set<() => void>()
const emit = () => { toasts = [...toasts]; listeners.forEach(listener => listener()) }
let seq = 0

const DEFAULT_TOAST_MS = 4000
const ACTION_TOAST_MS = 6000
/** The running clock of each toast: its timer, when it started, and how long it still has. */
const clocks = new Map<number, { timer?: number; startedAt: number; remaining: number }>()

export function subscribeToasts(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getToasts() { return toasts }

export function dismissToast(id: number) {
  const clock = clocks.get(id)
  if (clock?.timer) window.clearTimeout(clock.timer)
  clocks.delete(id)
  toasts = toasts.filter(toast => toast.id !== id)
  emit()
}

function run(id: number, ms: number) {
  clocks.set(id, { timer: window.setTimeout(() => dismissToast(id), ms), startedAt: Date.now(), remaining: ms })
}

/** The pointer or focus is on the toast: hold its time. */
export function pauseToast(id: number) {
  const clock = clocks.get(id)
  if (!clock?.timer) return
  window.clearTimeout(clock.timer)
  clocks.set(id, { startedAt: clock.startedAt, remaining: Math.max(0, clock.remaining - (Date.now() - clock.startedAt)) })
}

/** The pointer and focus have left: the toast's time runs on, never less than a short read. */
export function resumeToast(id: number) {
  const clock = clocks.get(id)
  if (!clock || clock.timer) return
  run(id, Math.max(clock.remaining, 1500))
}

export function showToast(message: string, options: { tone?: Toast['tone']; actions?: ToastAction[]; durationMs?: number } = {}) {
  const id = ++seq
  for (const previous of toasts) { const clock = clocks.get(previous.id); if (clock?.timer) window.clearTimeout(clock.timer); clocks.delete(previous.id) }
  toasts = [{ id, message, tone: options.tone, actions: options.actions }]
  emit()
  const base = options.durationMs ?? DEFAULT_TOAST_MS
  run(id, options.actions?.length ? Math.max(base, ACTION_TOAST_MS) : base)
  return id
}
