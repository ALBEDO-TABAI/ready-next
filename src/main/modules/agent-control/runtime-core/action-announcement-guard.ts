const ACTION_ANNOUNCEMENT_TAIL_PATTERN =
  /(?:让我|我来|我现在|我马上|接下来|现在去|I['’]ll now|let me)[\s\S]{0,120}[：:]\s*$/i
const ACTION_ANNOUNCEMENT_PROMISE_PATTERN =
  /(?:让我|我来|我现在|我马上|我会|接下来|现在|马上|这就)[\s\S]{0,120}(?:打开|搜索|搜集|采集|下载|保存|存档|落到|插入|写入|执行|处理|批量下载|open|search|collect|download|save|insert|write|run)/i

// Steered-turn re-promise: looser than the first-hit tail pattern (the
// forensic run4 promised again WITHOUT the trailing colon). A blocker
// explanation is NOT a re-promise — the steer explicitly allowed "说明阻塞".
const STEERED_REPROMISE_PATTERN =
  /(?:让我|我来|我现在|我马上|接下来|现在去|这就去|马上去|我会(?:先|去)|I['’]ll now|let me)/i
const BLOCKER_EXPLANATION_PATTERN =
  /(?:无法|不能|没有可|做不到|阻塞|失败|受限|被限制|需要你|需要用户|请提供|请先|缺少|登录|权限|cannot|unable|blocked|need you)/i

export type ActionAnnouncementGuardDecision =
  | { kind: 'none' }
  | { kind: 'steer'; actionSummary: string | null }
  | { kind: 'checkpoint'; actionSummary: string | null }

export interface ActionAnnouncementGuardInput {
  assistantText: string
  toolCallsInCurrentResponse: number
  hasUnfinishedTaskReference: boolean
  alreadySteered: boolean
}

export function evaluateActionAnnouncementGuard(
  input: ActionAnnouncementGuardInput,
): ActionAnnouncementGuardDecision {
  if (input.toolCallsInCurrentResponse !== 0) return { kind: 'none' }
  if (!input.hasUnfinishedTaskReference) return { kind: 'none' }
  const segment = lastAssistantTextSegment(input.assistantText)
  // After a steer the contract is "仍不行动则降级" (roadmap C1.2). A zero-tool
  // steered turn that RE-PROMISES action checkpoints — the forensic run4
  // ("好，我现在用浏览器打开…采集所有图片。") promised again without the
  // trailing colon and previously slipped through. A blocker explanation
  // ("我没有可调用工具，无法打开") is the steer's other legitimate exit and
  // closes as done.
  if (input.alreadySteered) {
    const repromised = (STEERED_REPROMISE_PATTERN.test(segment) || ACTION_ANNOUNCEMENT_PROMISE_PATTERN.test(segment))
      && !BLOCKER_EXPLANATION_PATTERN.test(segment)
    return repromised
      ? { kind: 'checkpoint', actionSummary: summarizeActionAnnouncement(segment) }
      : { kind: 'none' }
  }
  if (!ACTION_ANNOUNCEMENT_TAIL_PATTERN.test(segment) && !ACTION_ANNOUNCEMENT_PROMISE_PATTERN.test(segment)) {
    return { kind: 'none' }
  }
  return { kind: 'steer', actionSummary: summarizeActionAnnouncement(segment) }
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
