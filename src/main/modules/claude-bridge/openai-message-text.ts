export function extractOpenAIMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
          return typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}
