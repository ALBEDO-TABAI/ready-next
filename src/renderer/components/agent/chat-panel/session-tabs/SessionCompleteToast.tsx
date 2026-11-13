import { useCallback, useEffect, useRef, useState } from 'react'

import { useAgent, type SessionSliceState } from '../../../../stores/useAgent'

type ToastKind = Extract<SessionSliceState, 'done' | 'error' | 'cancelled'>

interface SessionCompleteToastEntry {
  id: string
  sessionId: string
  sessionLabel: string
  kind: ToastKind
}

const DISMISS_MS = 6000
const MAX_VISIBLE_TOASTS = 3

function isToastTerminalState(state: SessionSliceState | undefined): state is ToastKind {
  return state === 'done' || state === 'error' || state === 'cancelled'
}

function kindLabel(kind: ToastKind): string {
  switch (kind) {
    case 'done':
      return '已完成'
    case 'error':
      return '出错'
    case 'cancelled':
      return '已取消'
  }
}

function kindAccent(kind: ToastKind): string {
  switch (kind) {
    case 'done':
      return 'var(--rn-ok)'
    case 'error':
      return 'var(--rn-bad)'
    case 'cancelled':
      return 'var(--rn-ink-3)'
  }
}

export default function SessionCompleteToast() {
  const sessionOrder = useAgent((state) => state.sessionOrder)
  const sessions = useAgent((state) => state.sessions)
  const activeSessionId = useAgent((state) => state.activeSessionId)
  const setActiveSessionId = useAgent((state) => state.setActiveSessionId)

  const [toasts, setToasts] = useState<SessionCompleteToastEntry[]>([])
  const hydratedRef = useRef(false)
  const previousStatesRef = useRef<Record<string, SessionSliceState>>({})
  const toastSeqRef = useRef(0)
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current[id]
    if (timer) {
      clearTimeout(timer)
      delete timersRef.current[id]
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback((entry: Omit<SessionCompleteToastEntry, 'id'>) => {
    toastSeqRef.current += 1
    const id = `${entry.sessionId}:${entry.kind}:${toastSeqRef.current}`
    const nextEntry: SessionCompleteToastEntry = { ...entry, id }
    const timer = setTimeout(() => {
      dismissToast(id)
    }, DISMISS_MS)
    timersRef.current[id] = timer
    setToasts((current) => {
      const next = [...current, nextEntry]
      const overflow = next.length - MAX_VISIBLE_TOASTS
      if (overflow <= 0) return next
      const removed = next.slice(0, overflow)
      for (const toast of removed) {
        const pendingTimer = timersRef.current[toast.id]
        if (pendingTimer) {
          clearTimeout(pendingTimer)
          delete timersRef.current[toast.id]
        }
      }
      return next.slice(overflow)
    })
  }, [dismissToast])

  useEffect(() => {
    const currentStates: Record<string, SessionSliceState> = {}
    for (const id of sessionOrder) {
      currentStates[id] = sessions[id]?.state ?? 'live'
    }

    if (!hydratedRef.current) {
      hydratedRef.current = true
      previousStatesRef.current = currentStates
      return
    }

    const previousStates = previousStatesRef.current
    sessionOrder.forEach((sessionId, index) => {
      if (sessionId === activeSessionId) return
      const previousState = previousStates[sessionId]
      const currentState = currentStates[sessionId]
      if (previousState !== 'live' || !isToastTerminalState(currentState)) return
      pushToast({
        sessionId,
        sessionLabel: `会话 ${index + 1}`,
        kind: currentState,
      })
    })
    previousStatesRef.current = currentStates
  }, [activeSessionId, pushToast, sessionOrder, sessions])

  useEffect(() => {
    return () => {
      for (const timer of Object.values(timersRef.current)) {
        clearTimeout(timer)
      }
      timersRef.current = {}
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div
      data-testid="session-complete-toast-stack"
      style={{
        position: 'absolute',
        right: 12,
        bottom: 88,
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 260,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => (
        // Each toast floats over the messages on the float material (W1 DL4).
        <button
          key={toast.id}
          type="button"
          className="rn-float"
          data-testid="session-complete-toast"
          data-session-toast-id={toast.sessionId}
          data-session-toast-kind={toast.kind}
          onClick={() => {
            setActiveSessionId(toast.sessionId)
            dismissToast(toast.id)
          }}
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            border: '1px solid transparent',
            borderRadius: 8,
            padding: '9px 11px',
            textAlign: 'left',
            cursor: 'pointer',
            color: 'var(--rn-ink)',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: kindAccent(toast.kind),
              flexShrink: 0,
            }}
          />
          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.25 }}>
              {toast.sessionLabel} {kindLabel(toast.kind)}
            </span>
            <span style={{ fontSize: 12, color: 'var(--rn-ink-2)', lineHeight: 1.25 }}>
              点击切回查看
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
