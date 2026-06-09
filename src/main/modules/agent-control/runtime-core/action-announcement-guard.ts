const ACTION_ANNOUNCEMENT_TAIL_PATTERN =
  /(?:让我|我现在|我马上|接下来|现在去|I['’]ll now|let me)[\s\S]{0,120}[：:]\s*$/i

export type ActionAnnouncementGuardDecision =
  | { kind: 'none' }
  | { kind: 'steer'; actionSummary: string | null }
  | { kind: 'checkpoint'; actionSummary: string | null }

export interface ActionAnnouncementGuardInput {
  assistantText: string
  toolCallsUsed: number
  hasUnfinishedTaskReference: boolean
  alreadySteered: boolean
}

export function evaluateActionAnnouncementGuard(
  input: ActionAnnouncementGuardInput,
): ActionAnnouncementGuardDecision {
  if (input.toolCallsUsed !== 0) return { kind: 'none' }
  if (!input.hasUnfinishedTaskReference) return { kind: 'none' }
  const segment = lastAssistantTextSegment(input.assistantText)
  if (!ACTION_ANNOUNCEMENT_TAIL_PATTERN.test(segment)) return { kind: 'none' }

  const actionSummary = summarizeActionAnnouncement(segment)
  return input.alreadySteered
    ? { kind: 'checkpoint', actionSummary }
    : { kind: 'steer', actionSummary }
}

export function buildActionAnnouncementSteerInput(reminderText: string): Array<{
  role: 'system' | 'user'
  content: string
}> {
  return [
    {
      role: 'system',
      content: reminderText,
    },
    {
      role: 'user',
      content: '请继续当前任务；如果无法实际执行，请说明真实阻塞。',
    },
  ]
}

export function buildActionAnnouncementCheckpointMessage(actionSummary: string | null): string {
  const action = actionSummary ? `“${actionSummary}”` : '这一步'
  return `我准备执行${action}但未能启动，已保存断点，回复'继续'可恢复。`
}

function lastAssistantTextSegment(text: string): string {
  const normalized = String(text || '').trim()
  if (!normalized) return ''
  const segments = normalized
    .split(/\n\s*\n/g)
    .map((segment) => segment.trim())
    .filter(Boolean)
  return segments[segments.length - 1] || normalized
}

function summarizeActionAnnouncement(segment: string): string | null {
  const trimmed = segment
    .replace(/[：:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!trimmed) return null
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed
}
