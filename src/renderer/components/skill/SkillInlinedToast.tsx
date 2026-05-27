/**
 * PR5 observability — a transient gray pill that confirms "the skill you
 * referenced was actually loaded this turn". Subscribes to the
 * `skill:referenceInlined` IPC push that fires when
 * `SkillContextOrchestrator.tryInlineReferenceSkillDoc` injects SKILL.md
 * directly as a system message (Phase 3/4 hot path — no tool_use round-trip).
 *
 * Without this indicator the user cannot distinguish "skill was loaded + model
 * wrote using its methodology" from "model ignored the skill and chatted
 * normally" — both produce output with zero tool_use events.
 *
 * Sits at the app root alongside `SkillAskUserPrompt` so the toast is
 * scope-agnostic and survives ChatPanel remounts.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

interface SkillReferenceInlinedEvent {
  sessionId: string | null
  skillId: string
  skillName: string
  source: 'direct_read' | 'tool_fallback'
  bytesInjected: number
  truncated: boolean
  at: number
}

interface SkillsAPIShape {
  onSkillReferenceInlined?: (handler: (event: SkillReferenceInlinedEvent) => void) => () => void
}

function getSkillsAPI(): SkillsAPIShape | null {
  const api = (window as unknown as {
    electronAPI?: { skills?: SkillsAPIShape }
    skillsAPI?: SkillsAPIShape
  }).electronAPI?.skills
    || (window as unknown as { skillsAPI?: SkillsAPIShape }).skillsAPI
  return api || null
}

const TOAST_VISIBLE_MS = 4_000

export function SkillInlinedToast(): ReactElement | null {
  const [current, setCurrent] = useState<SkillReferenceInlinedEvent | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const skillsAPI = getSkillsAPI()
    if (!skillsAPI?.onSkillReferenceInlined) return

    const unsubscribe = skillsAPI.onSkillReferenceInlined((event) => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      setCurrent(event)
      hideTimerRef.current = setTimeout(() => {
        setCurrent(null)
        hideTimerRef.current = null
      }, TOAST_VISIBLE_MS)
    })

    return () => {
      unsubscribe()
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [])

  if (!current) return null

  const kbInjected = (current.bytesInjected / 1024).toFixed(1)
  const truncatedHint = current.truncated ? ' · 已截断' : ''
  const sourceHint = current.source === 'tool_fallback' ? ' · 回退' : ''

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        padding: '6px 12px',
        borderRadius: 999,
        background: 'color-mix(in srgb, var(--bg-subtle, #f3f4f6) 95%, transparent)',
        color: 'var(--text-body, #374151)',
        fontSize: 12,
        lineHeight: 1.4,
        border: '1px solid var(--border-default, #e5e7eb)',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06)',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span style={{ color: 'var(--color-green, #059669)' }}>✓</span>
      <span>已加载技能：</span>
      <span style={{ fontWeight: 500 }}>{current.skillName}</span>
      <span style={{ color: 'var(--text-light, #9ca3af)' }}>
        {` (${kbInjected} KB${truncatedHint}${sourceHint})`}
      </span>
    </div>
  )
}

export default SkillInlinedToast
