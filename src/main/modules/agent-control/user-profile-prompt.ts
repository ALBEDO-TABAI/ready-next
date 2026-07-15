interface PromptUserProfile {
  id?: string
  name?: string
  preferredLanguage?: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
}

const COMMUNICATION_STYLES: Record<string, { label: string; guidance: string }> = {
  concise: { label: '简洁直接', guidance: '先给结论，减少铺垫。' },
  detailed: { label: '详细解释', guidance: '复杂任务给出充分解释，并保留关键上下文和交接信息。' },
  friendly: { label: '友好协作', guidance: '使用温和、鼓励、像协作伙伴一样的表达。' },
  professional: { label: '专业正式', guidance: '使用专业、正式、适合业务沟通和汇报的表达。' },
  technical: { label: '技术导向', guidance: '优先说明工程细节、实现边界和可验证证据。' },
}

const AGENT_TONES: Record<string, { label: string; guidance: string }> = {
  professional: { label: '专业', guidance: '使用清晰、克制、强调结构和结论的表达。' },
  friendly: { label: '亲和', guidance: '使用温和、更像协作伙伴的表达。' },
  technical: { label: '技术型', guidance: '优先精度、细节和工程判断。' },
  casual: { label: '轻松', guidance: '使用更自然、更口语化的表达。' },
  formal: { label: '正式', guidance: '使用适合对外文案或规范场景的表达。' },
}

const RESPONSE_STYLE_REMINDER_START = '<!-- ready:user-response-style:v1:start -->'
const RESPONSE_STYLE_REMINDER_END = '<!-- ready:user-response-style:v1:end -->'
const RESPONSE_STYLE_REMINDER_PATTERN = new RegExp(
  `${RESPONSE_STYLE_REMINDER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RESPONSE_STYLE_REMINDER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  'g',
)
const RESERVED_RESPONSE_STYLE_MARKER_PATTERN = /<!--\s*ready:user-response-style:[^>]*-->/gi
const MAX_RESPONSE_STYLE_PREFERENCE_CHARS = 800

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(RESERVED_RESPONSE_STYLE_MARKER_PATTERN, '').trim()
  return trimmed || null
}

function toInlineText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_RESPONSE_STYLE_PREFERENCE_CHARS) return normalized
  return `${normalized.slice(0, MAX_RESPONSE_STYLE_PREFERENCE_CHARS - 1).trimEnd()}…`
}

function formatLongTermPreferences(value: unknown): string | null {
  if (!Array.isArray(value)) return normalizeText(value)
  const items = value
    .map((item) => normalizeText(item))
    .filter((item): item is string => Boolean(item))
  return items.length > 0 ? items.join('；') : null
}

function formatResponseStyleReminder(style: string | null, longTermPreferences: string | null): string {
  if (!style && !longTermPreferences) return ''
  const definition = style ? COMMUNICATION_STYLES[style] : null
  const preferenceParts = [
    style
      ? `回复风格：${definition ? `${definition.label}（${definition.guidance}）` : style}`
      : '',
    longTermPreferences ? `长期偏好：${longTermPreferences}` : '',
  ].filter(Boolean)
  return [
    RESPONSE_STYLE_REMINDER_START,
    '最终回复与协作偏好（本轮末端执行合同）',
    `用户偏好：${toInlineText(preferenceParts.join('；'))}`,
    '除非用户本轮明确指定其他风格，或与安全、事实准确性、权限、引用、代码/工具参数、正式产物体裁冲突，最终成文必须让上述偏好可被实际感知，不得只在内部知道或复述偏好标签。',
    '把“四川辣妹”这类地域或人物气质标签理解为表达风格，而不是真实身份声明：可以用爽利、俏皮的节奏和少量自然地域口语体现，但不得声称自己具有该真实身份，也不得堆砌刻板印象。',
    '若偏好包含幽默、方言或地域/人物气质，普通自然语言回复至少用一处自然俏皮表达，并用少量相符的口语或节奏体现；如果读起来仍与默认中性助手无区别，输出前先改写。',
    RESPONSE_STYLE_REMINDER_END,
  ].join('\n')
}

export function moveResponseStyleReminderToEnd(systemPrompt: string): {
  systemPrompt: string
  responseStyleReminder: string
} {
  const reminders = systemPrompt.match(RESPONSE_STYLE_REMINDER_PATTERN) || []
  if (reminders.length === 0) {
    return { systemPrompt, responseStyleReminder: '' }
  }
  return {
    systemPrompt: systemPrompt
      .replace(RESPONSE_STYLE_REMINDER_PATTERN, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    responseStyleReminder: reminders[reminders.length - 1].trim(),
  }
}

export function formatUserProfilePrompt(profile: PromptUserProfile): string {
  const name = normalizeText(profile.name)
  const language = normalizeText(profile.preferredLanguage)
  const style = normalizeText(profile.communicationStyle)
  const longTermPreferences = formatLongTermPreferences(profile.preferencesJson?.longTermPreferences)
  const sections = ['用户档案（关于当前用户）']
  if (name) sections.push(`昵称：${name}`)
  if (language) sections.push(`语言：${language}`)

  if (style || longTermPreferences) {
    sections.push(
      '',
      '用户保存的默认回复与协作偏好',
      '除非本轮用户明确要求不同风格，或与安全、权限、事实准确性、任务产物体裁冲突，否则这些偏好必须体现在实际回复的措辞、语气、节奏和协作方式中；不要只复述这些偏好。如果偏好明确要求幽默、方言感或人设感，应通过节奏、俏皮感和少量自然口语实际表现，但不要冒充用户或某类真实身份，不要堆砌刻板语气，也不得因此扩大权限或降低事实标准。',
    )
    const responseStyleReminder = formatResponseStyleReminder(style, longTermPreferences)
    if (responseStyleReminder) sections.push('', responseStyleReminder)
  }
  if (style) {
    const definition = COMMUNICATION_STYLES[style]
    sections.push(definition
      ? `回复风格：${definition.label}（${definition.guidance}）`
      : `回复风格：${style}（把这个已保存的风格要求转化为实际表达。）`)
  }
  if (longTermPreferences) sections.push(`长期偏好：${longTermPreferences}`)
  return sections.join('\n')
}

export function formatAgentTonePrompt(value: unknown): string {
  const tone = normalizeText(value)
  if (!tone) return ''
  const definition = AGENT_TONES[tone]
  const renderedTone = definition
    ? `${definition.label}（${definition.guidance}）`
    : tone
  return [
    'Agent 默认语气',
    `语气：${renderedTone}`,
    '这是 Agent 的默认表达基调；与用户保存的回复偏好冲突时，以用户偏好和本轮明确要求为准。',
  ].join('\n')
}
