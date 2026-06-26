const OPTIONAL_CLARIFICATION_PATTERN =
  /(?:可以先按默认|也可以先按|如果没有(?:这些|具体|明确).{0,40}(?:继续|先做)|不补充也(?:可以|能)|不是必须)/i

const CLARIFICATION_WAIT_PATTERN =
  /(?:需要(?:你|用户|先)?(?:补充|确认|选择|提供|告诉)|请(?:你)?(?:补充|确认|选择|提供|告诉)|我需要(?:先)?确认|如果能补上|实际是(?:哪|什么|多少)|你的预期是|预期是(?:哪|什么|多少)|才能继续|先确认|补全(?:这些|信息|细节))/i

const CLARIFICATION_TOPIC_PATTERN =
  /(?:补充|确认|选择|提供|告诉|主推|面积|预算|目标|优先级|风格|用途|周期|门店|快闪|固定|实际|预期|哪种|哪个|多少|是否)/i

const CLARIFICATION_LIST_PATTERN =
  /(?:^[\s>]*(?:[-*]|\d+[.)、]|[①②③④⑤⑥⑦⑧⑨])\s+|[①②③④⑤⑥⑦⑧⑨]|(?:\n[\s>]*[-*]\s+){2,})/m

const CLARIFICATION_QUESTION_PATTERN = /[?？]|(?:哪种|哪个|哪些|是否|能否|多少|什么|几[个块])/i

const POST_COMPLETION_FOLLOWUP_PATTERN =
  /(?:方案|文档|文件|任务|产物).{0,16}(?:已完成|完成|已保存|已输出|已生成|已经写好|已写入).{0,40}(?:需要(?:我)?做什么|是否(?:需要|要)|要不要|调整|修改|继续|生成效果图)|(?:已完成|已保存|已输出|已生成).{0,16}(?:方案|文档|文件|任务|产物).{0,40}(?:需要(?:我)?做什么|是否(?:需要|要)|要不要|调整|修改|继续|生成效果图)/i

export type SkillClarificationGuardDecision =
  | { kind: 'none' }
  | { kind: 'steer'; questionSummary: string | null }
  | { kind: 'checkpoint'; questionSummary: string | null }

export interface SkillClarificationGuardInput {
  assistantText: string
  toolCallsInCurrentResponse: number
  hasSkillAskUserTool: boolean
  hasUnfinishedTaskReference: boolean
  alreadySteered: boolean
}

export function evaluateSkillClarificationGuard(
  input: SkillClarificationGuardInput,
): SkillClarificationGuardDecision {
  if (input.toolCallsInCurrentResponse !== 0) return { kind: 'none' }
  if (!input.hasSkillAskUserTool) return { kind: 'none' }
  const text = normalizeGuardText(input.assistantText)
  if (!text || OPTIONAL_CLARIFICATION_PATTERN.test(text)) return { kind: 'none' }
  if (POST_COMPLETION_FOLLOWUP_PATTERN.test(text)) return { kind: 'none' }

  const waitsForUser = CLARIFICATION_WAIT_PATTERN.test(text)
  const asksQuestions = CLARIFICATION_QUESTION_PATTERN.test(text)
  const listsFields = CLARIFICATION_LIST_PATTERN.test(text)
  const mentionsClarificationTopic = CLARIFICATION_TOPIC_PATTERN.test(text)
  const looksLikeClarificationRequest = waitsForUser
    || (
      mentionsClarificationTopic
      && asksQuestions
      && (input.hasUnfinishedTaskReference || listsFields || text.length > 120)
    )

  if (!looksLikeClarificationRequest) return { kind: 'none' }
  return input.alreadySteered
    ? { kind: 'checkpoint', questionSummary: summarizeClarification(text) }
    : { kind: 'steer', questionSummary: summarizeClarification(text) }
}

export function buildSkillClarificationSteerInput(reminderText: string): Array<{
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
      content: '请继续当前技能任务；如果确实需要我补充信息，单个问题调用 skill_ask_user，多个问题调用 ask_user_questions 打开一次性提交的分页反问卡。',
    },
  ]
}

export function buildSkillClarificationSteerReminder(questionSummary: string | null): string {
  const summary = questionSummary ? `上一轮要追问的是：${questionSummary}\n` : ''
  return [
    `${summary}上一轮在技能流程中向用户索取补充、确认或选择信息，但没有调用 skill_ask_user。`,
    '请继续当前技能任务：如果确实需要用户补充才能推进，单个问题调用 skill_ask_user；多个问题调用 ask_user_questions，让用户在分页卡片里一次性提交；不要把问题清单写成普通回复。',
    '如果不需要等待用户，或任务已经完成后只是询问是否调整，直接用普通总结回复。',
  ].join('\n')
}

export function buildSkillClarificationCheckpointMessage(questionSummary: string | null): string {
  const question = questionSummary ? `“${questionSummary}”` : '补充信息'
  return `我需要你补充${question}但未能打开反问卡，已保存断点，回复'继续'可恢复。`
}

function normalizeGuardText(text: string): string {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarizeClarification(text: string): string | null {
  const compact = text
    .replace(/[#>*_`-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!compact) return null
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact
}
