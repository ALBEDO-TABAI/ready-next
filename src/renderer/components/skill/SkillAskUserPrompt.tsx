/**
 * B Phase 1 PR2 T1-8 — renders a capsule asking the user to clarify a
 * skill-driven question. Subscribes to the `skill:askUserQuestion` IPC push,
 * stores pending questions locally, and submits the user's answer via
 * `skillsAPI.submitAskUserAnswer`. The capsule is bottom-anchored and
 * dismisses itself on submit — it doesn't read from the scopeRun store, so
 * the lifecycle is independent of a specific agent session run.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

interface AskUserEvent {
  executionId: string
  sessionId: string | null
  skillId: string | null
  question: string
  options: string[] | null
  placeholder: string | null
  askedAt: number
}

interface SkillsAPIShape {
  onAskUserQuestion: (handler: (event: AskUserEvent) => void) => () => void
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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Subscribe to pushes + hydrate with anything already pending (e.g. after
  // a renderer reload while the main side had an open question).
  useEffect(() => {
    const skillsAPI = getSkillsAPI()
    if (!skillsAPI) return

    let cancelled = false
    // fire-and-forget: bootstrap-time fetch of pending ask-user questions; if the main side isn't ready, the live onAskUserQuestion subscription below will deliver them as they arrive.
    skillsAPI
      .listPendingAskUser()
      .then((list) => {
        if (cancelled) return
        setQueue((prev) => {
          if (prev.length > 0) return prev
          return Array.isArray(list) ? list : []
        })
      })
      .catch(() => { /* ignore — main not ready yet */ })

    const unsubscribe = skillsAPI.onAskUserQuestion((event) => {
      setQueue((prev) => {
        if (prev.some((item) => item.executionId === event.executionId)) return prev
        return [...prev, event]
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const current = queue[0] || null

  useEffect(() => {
    setDraft('')
    setError(null)
    if (current && inputRef.current) {
      // Auto-focus on new question so keyboard users can answer without a click.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
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

  const capsuleTone = useMemo(() => ({
    background: 'var(--surface-panel, #1f2023)',
    border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
    color: 'var(--text-primary, #f4f4f5)',
  }), [])

  if (!current) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 32,
        bottom: 112,
        zIndex: 1500,
        width: 'min(560px, calc(100vw - 32px))',
        borderRadius: 12,
        padding: 16,
        boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
        ...capsuleTone,
      }}
      role="dialog"
      aria-live="polite"
      aria-label="Skill clarification"
    >
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>
        技能追问
        {current.skillId ? `（${current.skillId}）` : ''}
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-wrap' }}>
        {current.question}
      </div>
      {current.options && current.options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {current.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={submitting}
              onClick={() => { void submit(option) }}
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.04)',
                color: 'inherit',
                fontSize: 13,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {option}
            </button>
          ))}
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
          resize: 'vertical',
          padding: 8,
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(0,0,0,0.2)',
          color: 'inherit',
          fontSize: 13,
          lineHeight: 1.4,
        }}
      />
      {error && (
        <div style={{ color: 'var(--text-error, #f87171)', fontSize: 12, marginTop: 6 }}>{error}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          disabled={submitting}
          onClick={handleFreeSubmit}
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.15)',
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
}

export default SkillAskUserPrompt
