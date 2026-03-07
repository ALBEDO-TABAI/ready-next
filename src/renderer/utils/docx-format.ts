function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function convertList(innerHtml: string, ordered: boolean): string {
  const itemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi
  const lines: string[] = []
  let match: RegExpExecArray | null = itemRegex.exec(innerHtml)
  let index = 1
  while (match) {
    const text = stripTags(match[1] || '')
    if (text) {
      lines.push(ordered ? `${index}. ${text}` : `- ${text}`)
      index += 1
    }
    match = itemRegex.exec(innerHtml)
  }
  if (lines.length === 0) return ''
  return `${lines.join('\n')}\n\n`
}

export function convertDocxHtmlToMarkdownText(html: string, fallback = ''): string {
  if (!html || typeof html !== 'string') return fallback

  let text = html.replace(/\r\n/g, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')

  text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_whole, inner) => convertList(inner, false))
  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_whole, inner) => convertList(inner, true))

  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_whole, levelText, inner) => {
    const level = Number(levelText)
    const heading = stripTags(inner || '')
    if (!heading) return ''
    const prefix = '#'.repeat(Number.isFinite(level) ? Math.min(Math.max(level, 1), 6) : 2)
    return `${prefix} ${heading}\n\n`
  })

  text = text.replace(/<(p|div|section|article|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi, (_whole, _tag, inner) => {
    const paragraph = stripTags(inner || '')
    if (!paragraph) return '\n'
    return `${paragraph}\n\n`
  })

  text = decodeHtmlEntities(text)
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!text) return fallback
  return `${text}\n`
}
