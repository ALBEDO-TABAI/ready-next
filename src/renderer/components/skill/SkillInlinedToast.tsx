/**
 * PR5 observability — a transient note that confirms "the skill you
 * referenced was actually loaded this turn". Subscribes to the
 * `skill:referenceInlined` IPC push that fires when
 * `SkillContextOrchestrator.tryInlineReferenceSkillDoc` injects SKILL.md
 * directly as a system message (Phase 3/4 hot path — no tool_use round-trip).
 *
 * Without this indicator the user cannot distinguish "skill was loaded + model
 * wrote using its methodology" from "model ignored the skill and chatted
 * normally" — both produce output with zero tool_use events.
 *
 * Sits at the app root alongside `SkillAskUserPrompt` so the note is
 * scope-agnostic and survives ChatPanel remounts. It is one line of the shared
 * toast in the bottom band (W1 §5, DL11a), not a private pill of its own.
 */

import { useEffect, type ReactElement } from 'react'
import { showToast } from '../ui'

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

function skillInlinedMessage(event: SkillReferenceInlinedEvent): string {
  const kbInjected = (event.bytesInjected / 1024).toFixed(1)
  const truncatedHint = event.truncated ? ' · 已截断' : ''
  const sourceHint = event.source === 'tool_fallback' ? ' · 回退' : ''
  return `已加载技能：${event.skillName}（${kbInjected} KB${truncatedHint}${sourceHint}）`
}

export function SkillInlinedToast(): ReactElement | null {
  useEffect(() => {
    const skillsAPI = getSkillsAPI()
    if (!skillsAPI?.onSkillReferenceInlined) return
    return skillsAPI.onSkillReferenceInlined((event) => {
      showToast(skillInlinedMessage(event), { durationMs: TOAST_VISIBLE_MS })
    })
  }, [])
  return null
}

export default SkillInlinedToast
