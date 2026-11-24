/**
 * B Phase 1 PR2 T1-8 — renders a capsule asking the user to clarify a
 * skill-driven question. Subscribes to the `skill:askUserQuestion` IPC push,
 * stores pending questions locally, and submits the user's answer via
 * `skillsAPI.submitAskUserAnswer`. The component is owned by the active chat
 * message stream so the question cannot be portaled into a stale or hidden
 * panel while the matching Agent turn is blocked.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Button, Textarea } from '../ui'
import { scrollBehavior } from '../../design/next/motion'

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
        scrollRoot.scrollTo({ top: scrollRoot.scrollHeight, behavior: scrollBehavior() })
      } else {
        scrollRoot.scrollTop = scrollRoot.scrollHeight
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrolls once per new question; the 500 ms reconcile poll replaces queue items with fresh objects, so depending on `current` would re-scroll the chat on every poll
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

  if (!current) {
    return <div ref={anchorRef} data-skill-ask-user-anchor="true" style={{ flex: '0 0 auto', width: '100%' }} />
  }

  // A question in the conversation (W1 B13): a quiet filled block on the assistant's glass, like the browser task
  // card above it; the answers are rows, the reply field and the one primary button are the shared primitives.
  const card = (
    <div
      data-skill-ask-user-card="true"
      className="rn-ui skill-ask-user"
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
      }}
      role="group"
      aria-live="polite"
      aria-label="Skill clarification"
    >
      <div className="skill-ask-user__eyebrow">
        技能追问
        {current.skillId ? `（${current.skillId}）` : ''}
      </div>
      <div
        data-skill-ask-user-scroll-body="true"
        className="skill-ask-user__body"
        style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
      >
        <div className="skill-ask-user__question">{current.question}</div>
        {current.options && current.options.length > 0 && (
          <div className="skill-ask-user__options">
            {current.options.map((option) => (
              <button
                key={option}
                type="button"
                className="skill-ask-user__option"
                disabled={submitting}
                aria-pressed={selectedOption === option}
                onClick={() => handleOptionSubmit(option)}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        <Textarea
          ref={inputRef}
          className="skill-ask-user__reply"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={current.placeholder || '也可直接输入回复'}
          rows={3}
          disabled={submitting}
        />
      </div>
      {error && <div className="skill-ask-user__error" role="alert">{error}</div>}
      <div className="skill-ask-user__actions">
        <Button variant="primary" size="sm" disabled={submitting} onClick={handleFreeSubmit}>
          提交回复
        </Button>
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
