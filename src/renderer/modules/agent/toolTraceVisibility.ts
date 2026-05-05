import type { ToolTraceEvent } from './types'

const INTERNAL_TRACE_PATTERNS = [
  /\bskill_[a-z0-9_]+\b/i,
  /^技能执行\s*[·:：-]/,
  /^技能上下文\b/,
  /Artifact not found/i,
  /Provide .*?(output|run|artifact)/i,
  /\boutputDir\b/i,
  /\brun_state\b/i,
  /"(returned|degraded|items|success|note)"\s*:/,
  /^\s*\{[\s\S]*(?:"returned"|"degraded"|"items"|"success"|"note")[\s\S]*\}\s*$/,
]

function isInternalToolTraceText(text: string): boolean {
  const raw = String(text || '').trim()
  if (!raw) return true
  return INTERNAL_TRACE_PATTERNS.some((pattern) => pattern.test(raw))
}

export function filterUserVisibleToolTraceEvents<T extends Pick<ToolTraceEvent, 'text'>>(events: T[]): T[] {
  return events.filter((event) => !isInternalToolTraceText(event.text))
}

export function sanitizeInternalAgentDisplayText(text: string | null | undefined, fallback: string): string {
  const raw = String(text || '').trim()
  if (!raw) return fallback
  return isInternalToolTraceText(raw) ? fallback : raw
}
