import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

export interface ExtractedWebContent {
  title: string
  url: string
  text: string
  savedPath: string
  extractedAt: string
  wordCount: number
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!titleMatch) return '未命名网页'
  const title = stripHtml(titleMatch[1]).replace(/\s+/g, ' ').trim()
  return title || '未命名网页'
}

function normalizeExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    }
    return await resp.text()
  } finally {
    clearTimeout(timer)
  }
}

export async function extractWebContentToFile(url: string, outputDir: string): Promise<ExtractedWebContent> {
  const html = await fetchHtml(url)
  const title = extractTitle(html)
  const text = stripHtml(html)
  const clippedText = normalizeExcerpt(text, 12_000)
  const extractedAt = new Date().toISOString()
  const savedPath = join(outputDir, '网页正文提取.txt')
  const wordCount = clippedText.length === 0 ? 0 : clippedText.split(/\s+/).length

  await mkdir(outputDir, { recursive: true })
  await writeFile(
    savedPath,
    [
      `标题: ${title}`,
      `链接: ${url}`,
      `提取时间: ${extractedAt}`,
      `字数(近似): ${wordCount}`,
      '',
      clippedText,
      '',
    ].join('\n'),
    'utf-8',
  )

  return {
    title,
    url,
    text: clippedText,
    savedPath,
    extractedAt,
    wordCount,
  }
}
