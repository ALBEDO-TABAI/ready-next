export interface PromptHistoryMessage {
  role: string
  content: string
}

export interface PromptCompressionResult {
  text: string
  compressed: boolean
}

export interface PromptCompressionReport {
  historyCompressed: boolean
  toolTraceCompressed: boolean
  artifactSummaryUsed: boolean
}

export function compressHistoryForPrompt(
  messages: PromptHistoryMessage[],
  options?: { keepRecent?: number; maxChars?: number },
): PromptCompressionResult {
  if (messages.length === 0) {
    return { text: '', compressed: false }
  }

  const keepRecent = Math.max(1, options?.keepRecent ?? 2)
  const plainText = messages
    .map((item) => `${toSpeaker(item.role)}: ${String(item.content || '').trim()}`)
    .join('\n')
  const maxChars = Math.max(120, options?.maxChars ?? 600)
  if (plainText.length <= maxChars) {
    return { text: plainText, compressed: false }
  }

  const recentMessages = messages.slice(-keepRecent)
  const earlierMessages = messages.slice(0, -keepRecent)
  const summary = [
    `更早消息 ${earlierMessages.length} 条已压缩：`,
    ...earlierMessages.slice(-2).map((item, index) => `- 摘要 ${index + 1}: ${clipLine(item.content, 72)}`),
    '',
    `最近保留 ${recentMessages.length} 条原始消息：`,
    ...recentMessages.map((item) => `${toSpeaker(item.role)}: ${clipLine(item.content, 180)}`),
  ].join('\n')

  return {
    text: summary,
    compressed: true,
  }
}

export function buildCompressionReport(report: PromptCompressionReport): PromptCompressionReport {
  return {
    historyCompressed: Boolean(report.historyCompressed),
    toolTraceCompressed: Boolean(report.toolTraceCompressed),
    artifactSummaryUsed: Boolean(report.artifactSummaryUsed),
  }
}

function toSpeaker(role: string): string {
  return role === 'user' ? '用户' : role === 'assistant' ? '助手' : '系统'
}

function clipLine(value: string, maxChars: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, maxChars)}...`
}
