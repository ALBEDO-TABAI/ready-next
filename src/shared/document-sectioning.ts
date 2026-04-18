export interface DocumentChunk {
  id: string
  index: number
  sectionTitle?: string
  content: string
  charCount: number
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export interface FocusedDocumentContext {
  chunks: DocumentChunk[]
  selectedChunks: DocumentChunk[]
  promptText: string
  warnings: string[]
  usedSectionAnchors: boolean
}

interface BuildFocusedDocumentContextParams {
  question: string
  content: string
  maxCharsPerChunk?: number
  maxSelectedChunks?: number
  maxPromptChars?: number
}

interface SectionAnchor {
  line: number
  title: string
}

const DEFAULT_MAX_CHARS_PER_CHUNK = 2200
const DEFAULT_MAX_SELECTED_CHUNKS = 4
const DEFAULT_MAX_PROMPT_CHARS = 8000

const STOPWORDS = new Set([
  '当前',
  '文档',
  '然后',
  '一个',
  '一下',
  '这份',
  '这个',
  '根据',
  '围绕',
  '阅读',
  '先阅读',
  '信息卡',
  '卡片',
  'widget',
  'show',
  'read',
  'then',
  'create',
  'card',
])

function normalizeLineEnding(value: string): string {
  return String(value || '').replace(/\r\n/g, '\n')
}

function parseSectionHeading(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const markdownHeading = trimmed.match(/^#{1,6}\s+(.+?)\s*$/)
  if (markdownHeading?.[1]) return markdownHeading[1].trim()

  const ordinalHeading = trimmed.match(/^(第[一二三四五六七八九十百千万0-9]+(?:部分|章|节)|引言|摘要|结论|结语|前言)\s*([：:]\s*.+)?$/)
  if (ordinalHeading) {
    return ordinalHeading[2]
      ? `${ordinalHeading[1]} ${ordinalHeading[2].replace(/^[：:]\s*/, '').trim()}`.trim()
      : ordinalHeading[1]
  }

  const numberedHeading = trimmed.match(/^(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+[、.．])\s+(.+)$/)
  if (numberedHeading?.[1]) return numberedHeading[1].trim()

  return null
}

function collectSectionAnchors(lines: string[]): SectionAnchor[] {
  const anchors: SectionAnchor[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const title = parseSectionHeading(lines[index])
    if (!title) continue
    anchors.push({ line: index, title })
  }
  return anchors
}

function splitParagraphs(text: string): string[] {
  return normalizeLineEnding(text)
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function pushChunk(
  chunks: DocumentChunk[],
  params: {
    sectionTitle?: string
    content: string
    startLine?: number
    endLine?: number
  },
): void {
  const content = params.content.trim()
  if (!content) return
  chunks.push({
    id: `${chunks.length + 1}`,
    index: chunks.length,
    sectionTitle: params.sectionTitle,
    content,
    charCount: content.length,
    startLine: params.startLine,
    endLine: params.endLine,
  })
}

function splitOversizedParagraph(paragraph: string, maxCharsPerChunk: number): string[] {
  if (paragraph.length <= maxCharsPerChunk) return [paragraph]
  const sentences = paragraph
    .split(/(?<=[。！？!?；;])\s*/g)
    .map((item) => item.trim())
    .filter(Boolean)
  if (sentences.length <= 1) {
    const slices: string[] = []
    for (let offset = 0; offset < paragraph.length; offset += maxCharsPerChunk) {
      slices.push(paragraph.slice(offset, offset + maxCharsPerChunk))
    }
    return slices
  }
  const results: string[] = []
  let buffer = ''
  for (const sentence of sentences) {
    const next = buffer ? `${buffer} ${sentence}` : sentence
    if (next.length <= maxCharsPerChunk) {
      buffer = next
      continue
    }
    if (buffer) results.push(buffer)
    if (sentence.length <= maxCharsPerChunk) {
      buffer = sentence
      continue
    }
    results.push(...splitOversizedParagraph(sentence, maxCharsPerChunk))
    buffer = ''
  }
  if (buffer) results.push(buffer)
  return results
}

function chunkParagraphs(
  paragraphs: string[],
  maxCharsPerChunk: number,
): string[] {
  const chunks: string[] = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    const pieces = splitOversizedParagraph(paragraph, maxCharsPerChunk)
    for (const piece of pieces) {
      const next = buffer ? `${buffer}\n\n${piece}` : piece
      if (next.length <= maxCharsPerChunk) {
        buffer = next
        continue
      }
      if (buffer) chunks.push(buffer)
      buffer = piece
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

export function buildDocumentChunks(
  content: string,
  options?: { maxCharsPerChunk?: number },
): { chunks: DocumentChunk[]; usedSectionAnchors: boolean } {
  const normalized = normalizeLineEnding(content)
  const maxCharsPerChunk = Math.max(240, options?.maxCharsPerChunk || DEFAULT_MAX_CHARS_PER_CHUNK)
  const lines = normalized.split('\n')
  const anchors = collectSectionAnchors(lines)
  const chunks: DocumentChunk[] = []

  if (anchors.length > 0) {
    for (let index = 0; index < anchors.length; index += 1) {
      const current = anchors[index]
      const nextAnchorLine = anchors[index + 1]?.line ?? lines.length
      const body = lines.slice(current.line + 1, nextAnchorLine).join('\n').trim()
      const paragraphs = splitParagraphs(body)
      if (paragraphs.length === 0) {
        pushChunk(chunks, {
          sectionTitle: current.title,
          content: lines[current.line].trim(),
          startLine: current.line,
          endLine: nextAnchorLine - 1,
        })
        continue
      }
      const sectionChunks = chunkParagraphs(paragraphs, maxCharsPerChunk)
      sectionChunks.forEach((sectionChunk) => {
        pushChunk(chunks, {
          sectionTitle: current.title,
          content: sectionChunk,
          startLine: current.line,
          endLine: nextAnchorLine - 1,
        })
      })
    }
    attachOffsetsToChunks(chunks, normalized)
    return { chunks, usedSectionAnchors: true }
  }

  const fallbackParagraphs = splitParagraphs(normalized)
  fallbackParagraphs.forEach((paragraph) => {
    splitOversizedParagraph(paragraph, maxCharsPerChunk).forEach((piece) => {
      pushChunk(chunks, { content: piece })
    })
  })
  attachOffsetsToChunks(chunks, normalized)
  return { chunks, usedSectionAnchors: false }
}

function attachOffsetsToChunks(chunks: DocumentChunk[], normalized: string): void {
  let cursor = 0
  for (const chunk of chunks) {
    const probe = chunk.content.slice(0, Math.min(60, chunk.content.length))
    const found = normalized.indexOf(probe, cursor)
    if (found >= 0) {
      chunk.startOffset = found
      chunk.endOffset = found + chunk.content.length
      cursor = Math.max(cursor, found + probe.length)
    }
  }
}

function tokenizeQuestion(question: string): string[] {
  const lowered = String(question || '').toLowerCase()
  const tokens = new Set<string>()
  for (const match of lowered.matchAll(/[\u4e00-\u9fa5]+|[a-z0-9]{3,}/g)) {
    const token = match[0].trim()
    if (!token) continue
    if (/^[\u4e00-\u9fa5]+$/.test(token)) {
      const maxLength = Math.min(4, token.length)
      for (let size = 2; size <= maxLength; size += 1) {
        for (let index = 0; index <= token.length - size; index += 1) {
          const part = token.slice(index, index + size)
          if (!part || STOPWORDS.has(part)) continue
          tokens.add(part)
        }
      }
      continue
    }
    if (STOPWORDS.has(token)) continue
    tokens.add(token)
  }
  return Array.from(tokens)
}

function scoreChunk(questionTokens: string[], chunk: DocumentChunk): number {
  if (questionTokens.length === 0) return 0
  const sectionTitle = String(chunk.sectionTitle || '').toLowerCase()
  const content = chunk.content.toLowerCase()
  let score = 0
  for (const token of questionTokens) {
    if (sectionTitle.includes(token)) score += 6
    if (content.includes(token)) score += 3
  }
  return score
}

export function selectRelevantDocumentChunks(
  question: string,
  chunks: DocumentChunk[],
  options?: { maxSelectedChunks?: number },
): DocumentChunk[] {
  const maxSelectedChunks = Math.max(1, options?.maxSelectedChunks || DEFAULT_MAX_SELECTED_CHUNKS)
  const questionTokens = tokenizeQuestion(question)
  const scored = chunks.map((chunk) => ({
    chunk,
    score: scoreChunk(questionTokens, chunk),
  }))

  const matched = scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.index - right.chunk.index)
    .slice(0, maxSelectedChunks)
    .map((item) => item.chunk)

  if (matched.length > 0) return matched
  return chunks.slice(0, Math.min(maxSelectedChunks, chunks.length))
}

export function selectWidgetCenteredChunks(
  content: string,
  chunks: DocumentChunk[],
  widgetTitle: string,
  occurrence: number | undefined,
  opts: { windowChunks?: number } = {},
): DocumentChunk[] | null {
  if (chunks.length === 0) return null
  const trimmedTitle = String(widgetTitle || '').trim()
  if (!trimmedTitle) return null

  const normalized = normalizeLineEnding(content)
  const widgetRegex = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g
  const matches: Array<{ start: number; title: string }> = []
  for (const match of normalized.matchAll(widgetRegex)) {
    try {
      const body = match[1] || ''
      const parsed = JSON.parse(body) as Record<string, unknown>
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      if (!title) continue
      matches.push({ start: match.index ?? 0, title })
    } catch {
      continue
    }
  }

  const filtered = matches.filter((item) => item.title === trimmedTitle)
  if (filtered.length === 0) return null
  const occurrenceIndex = typeof occurrence === 'number' && occurrence > 0
    ? Math.min(occurrence - 1, filtered.length - 1)
    : 0
  const target = filtered[occurrenceIndex]
  if (!target) return null

  const window = Math.max(0, opts.windowChunks ?? 2)
  const chunkIndex = chunks.findIndex((chunk) => {
    if (typeof chunk.startOffset !== 'number' || typeof chunk.endOffset !== 'number') return false
    return chunk.startOffset <= target.start && target.start <= chunk.endOffset
  })
  if (chunkIndex < 0) {
    let fallback = -1
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (typeof chunk.startOffset !== 'number') continue
      if (chunk.startOffset <= target.start) fallback = index
    }
    if (fallback < 0) return null
    const start = Math.max(0, fallback - window)
    const end = Math.min(chunks.length, fallback + window + 1)
    return chunks.slice(start, end)
  }

  const start = Math.max(0, chunkIndex - window)
  const end = Math.min(chunks.length, chunkIndex + window + 1)
  return chunks.slice(start, end)
}

export function buildFocusedDocumentContext(params: BuildFocusedDocumentContextParams): FocusedDocumentContext {
  const maxPromptChars = Math.max(400, params.maxPromptChars || DEFAULT_MAX_PROMPT_CHARS)
  const { chunks, usedSectionAnchors } = buildDocumentChunks(params.content, {
    maxCharsPerChunk: params.maxCharsPerChunk,
  })
  const selectedChunks = selectRelevantDocumentChunks(params.question, chunks, {
    maxSelectedChunks: params.maxSelectedChunks,
  })
  const warnings: string[] = []
  if (chunks.length > selectedChunks.length) {
    warnings.push(`文档已分为 ${chunks.length} 个片段，本次只使用其中 ${selectedChunks.length} 个相关片段。`)
  }
  if (!usedSectionAnchors) {
    warnings.push('文档未识别出稳定章节，已按段落窗口切分。')
  }

  const promptSections: string[] = []
  for (const [index, chunk] of selectedChunks.entries()) {
    const heading = chunk.sectionTitle
      ? `### 相关片段 ${index + 1}｜${chunk.sectionTitle}`
      : `### 相关片段 ${index + 1}`
    const next = [heading, chunk.content].join('\n')
    const currentLength = promptSections.join('\n\n').length
    if (currentLength + next.length > maxPromptChars && promptSections.length > 0) break
    promptSections.push(next)
  }

  return {
    chunks,
    selectedChunks: promptSections.length > 0
      ? selectedChunks.slice(0, promptSections.length)
      : selectedChunks,
    promptText: promptSections.join('\n\n'),
    warnings,
    usedSectionAnchors,
  }
}
