/**
 * B Phase 1 PR2 T1-8 — renders a capsule asking the user to clarify a
 * skill-driven question. Subscribes to the `skill:askUserQuestion` IPC push,
 * stores pending questions locally, and submits the user's answer via
 * `skillsAPI.submitAskUserAnswer`. The component is owned by the active chat
 * message stream so the question cannot be portaled into a stale or hidden
 * panel while the matching Agent turn is blocked.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

interface AskUserEvent {
  executionId: string
  sessionId: string | null
  scopeId?: string | null
  agent?: string | null
  requestId?: string | null
  skillId: string | null
  question: string
  options: string[] | null
  placeholder: string | null
  askedAt: number
}

interface SkillsAPIShape {
  onAskUserQuestion: (handler: (event: AskUserEvent) => void) => () => void
  onAskUserCleared?: (handler: (event: { executionId: string }) => void) => () => void
  listPendingAskUser: () => Promise<AskUserEvent[]>
  submitAskUserAnswer: (payload: { executionId: string; answer: string }) => Promise<{
    success: boolean
    error?: string
  }>
}

function getSkillsAPI(): SkillsAPIShape | null {
  const api = (window as unknown as {
    electronAPI?: { skills?: SkillsAPIShape }
    skillsAPI?: SkillsAPIShape
  }).electronAPI?.skills
    || (window as unknown as { skillsAPI?: SkillsAPIShape }).skillsAPI
  return api || null
}

export function SkillAskUserPrompt(): ReactElement | null {
  const [queue, setQueue] = useState<AskUserEvent[]>([])
  const [draft, setDraft] = useState('')
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)

  // Subscribe to pushes + hydrate with anything already pending (e.g. after
  // a renderer reload while the main side had an open question).
  useEffect(() => {
    const skillsAPI = getSkillsAPI()
    if (!skillsAPI) return

    let cancelled = false
    const reconcilePending = (): void => {
      skillsAPI.listPendingAskUser()
      .then((list) => {
        if (cancelled) return
        setQueue(Array.isArray(list) ? list : [])
      })
      .catch(() => { /* ignore — main not ready yet */ })
    }
    reconcilePending()
    // The push is only a wake-up hint. Reconcile with the Main-owned pending
    // store as well so a renderer reload or a missed IPC event cannot strand
    // an already-blocked tool call until its timeout.
    const reconcileTimer = window.setInterval(reconcilePending, 500)

    const unsubscribe = skillsAPI.onAskUserQuestion((event) => {
      setQueue((prev) => {
        if (prev.some((item) => item.executionId === event.executionId)) return prev
        return [...prev, event]
      })
    })
    const unsubscribeCleared = skillsAPI.onAskUserCleared?.((event) => {
      setQueue((prev) => prev.filter((item) => item.executionId !== event.executionId))
    }) || (() => undefined)
    return () => {
      cancelled = true
      window.clearInterval(reconcileTimer)
      unsubscribe()
      unsubscribeCleared()
    }
  }, [])

  const current = queue[0] || null

  useEffect(() => {
    setDraft('')
    setSelectedOption(null)
    setError(null)
  }, [current?.executionId])

  useEffect(() => {
    const anchor = anchorRef.current
    if (!current || !anchor) return
    window.requestAnimationFrame(() => {
      const scrollRoot = anchor.closest('[data-liquid-scroll-root="chat-messages"]') as HTMLElement | null
        || anchor.parentElement
        || anchor
      if (typeof scrollRoot.scrollTo === 'function') {
        scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: 'smooth' })
      } else {
        scrollRoot.scrollTop = scrollRoot.scrollHeight
      }
    })
  }, [current?.executionId])

  const submit = useCallback(async (answer: string) => {
    if (!current) return
    const api = getSkillsAPI()
    if (!api) return
    const trimmed = answer.trim()
    if (!trimmed) {
      setError('请填写或选择一个选项')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await api.submitAskUserAnswer({ executionId: current.executionId, answer: trimmed })
      if (!result.success) {
        setError(result.error || '提交失败')
        return
      }
      setQueue((prev) => prev.filter((item) => item.executionId !== current.executionId))
    } catch (submitErr) {
      setError(submitErr instanceof Error ? submitErr.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }, [current])

  const handleFreeSubmit = useCallback(() => { void submit(draft) }, [draft, submit])
  const handleOptionSubmit = useCallback((option: string) => {
    setSelectedOption(option)
    void submit(option)
  }, [submit])

  const cardTone = useMemo(() => ({
    background: 'color-mix(in srgb, var(--surface-card-bg) 42%, transparent)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-body)',
  }), [])

  if (!current) {
    return <div ref={anchorRef} data-skill-ask-user-anchor="true" style={{ flex: '0 0 auto', width: '100%' }} />
  }

  const card = (
    <div
      data-skill-ask-user-card="true"
      style={{
        width: '100%',
        maxWidth: '100%',
        boxSizing: 'border-box',
        alignSelf: 'stretch',
        overflow: 'hidden',
        maxHeight: 'min(640px, calc(100vh - 220px))',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRadius: 8,
        padding: '12px',
        boxShadow: 'none',
        ...cardTone,
      }}
      role="group"
      aria-live="polite"
      aria-label="Skill clarification"
    >
      <div style={{ fontSize: 12, color: 'var(--text-gray)', marginBottom: 6, fontWeight: 600 }}>
        技能追问
        {current.skillId ? `（${current.skillId}）` : ''}
      </div>
      <div
        data-skill-ask-user-scroll-body="true"
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          paddingRight: 2,
        }}
      >
        <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {current.question}
        </div>
        {current.options && current.options.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {current.options.map((option) => {
              const isSelected = selectedOption === option
              return (
                <button
                  key={option}
                  type="button"
                  disabled={submitting}
                  aria-pressed={isSelected}
                  onClick={() => handleOptionSubmit(option)}
                  style={{
                    padding: '8px 12px',
                    minHeight: 38,
                    borderRadius: 8,
                    border: isSelected
                      ? '1px solid color-mix(in srgb, var(--accent, #3b82f6) 72%, var(--border-default))'
                      : '1px solid var(--border-default)',
                    background: isSelected
                      ? 'color-mix(in srgb, var(--accent, #3b82f6) 18%, var(--surface-card-bg))'
                      : 'color-mix(in srgb, var(--surface-card-bg) 34%, transparent)',
                    color: 'inherit',
                    fontSize: 13,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    width: '100%',
                    textAlign: 'left',
                    whiteSpace: 'normal',
                    overflowWrap: 'anywhere',
                    lineHeight: 1.45,
                    opacity: submitting && !isSelected ? 0.62 : 1,
                    boxShadow: isSelected ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent, #3b82f6) 24%, transparent)' : 'none',
                  }}
                >
                  {option}
                </button>
              )
            })}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={current.placeholder || '也可直接输入回复'}
          rows={3}
          disabled={submitting}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'none',
            padding: 8,
            borderRadius: 8,
            border: '1px solid var(--border-default)',
            background: 'color-mix(in srgb, var(--surface-card-bg) 28%, transparent)',
            color: 'inherit',
            fontSize: 13,
            lineHeight: 1.4,
            minHeight: 76,
          }}
        />
      </div>
      {error && (
        <div style={{ color: 'var(--text-error, #f87171)', fontSize: 12, marginTop: 6, flex: '0 0 auto' }}>{error}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, flex: '0 0 auto' }}>
        <button
          type="button"
          disabled={submitting}
          onClick={handleFreeSubmit}
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid transparent',
            background: submitting ? 'rgba(59,130,246,0.5)' : 'var(--accent, #3b82f6)',
            color: '#fff',
            fontSize: 13,
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}
        >
          提交回复
        </button>
      </div>
    </div>
  )

  return (
    <div ref={anchorRef} data-skill-ask-user-anchor="true" style={{ flex: '0 0 auto', width: '100%' }}>
      {card}
    </div>
  )
}

export default SkillAskUserPrompt
