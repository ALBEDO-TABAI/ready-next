export interface DocumentChunk {
  id: string
  index: number
  sectionTitle?: string
  sectionAliases?: string[]
  content: string
  charCount: number
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export type DocumentSectionKind = 'markdown' | 'part' | 'chapter' | 'section' | 'numbered'

export interface DocumentSectionIndexEntry {
  id: string
  line: number
  endLine: number
  level: number
  title: string
  displayTitle: string
  rawLine: string
  aliases: string[]
  parentTitles: string[]
  kind: DocumentSectionKind
  ordinal?: number
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

const DEFAULT_MAX_CHARS_PER_CHUNK = 2200
const DEFAULT_MAX_SELECTED_CHUNKS = 4
const DEFAULT_MAX_PROMPT_CHARS = 8000
const CHINESE_NUMERAL_PATTERN = '[一二两三四五六七八九十百千万0-9]+'

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

export function normalizeDocumentSectionKey(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[`*_~#>:：,.，。!?！？;；、()（）[\]{}'"“”‘’\s·\-—_]+/g, '')
    .trim()
}

function parseChineseSectionNumber(raw: string): number | null {
  const token = raw.trim()
  if (!token) return null
  if (/^\d+$/.test(token)) {
    const numeric = Number(token)
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null
  }

  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (token === '十') return 10
  if (token.includes('十')) {
    const [left, right] = token.split('十')
    const tens = left ? digits[left] : 1
    const units = right ? digits[right] : 0
    if (tens === undefined || units === undefined) return null
    const value = tens * 10 + units
    return value > 0 ? value : null
  }
  const direct = digits[token]
  return direct && direct > 0 ? direct : null
}

function toChineseSectionNumber(value: number): string {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (value > 0 && value < 10) return digits[value]
  if (value === 10) return '十'
  if (value > 10 && value < 20) return `十${digits[value - 10]}`
  if (value >= 20 && value < 100) {
    const tens = Math.floor(value / 10)
    const units = value % 10
    return `${digits[tens]}十${units ? digits[units] : ''}`
  }
  return String(value)
}

interface ParsedSectionHeading {
  level: number
  title: string
  kind: DocumentSectionKind
  ordinal?: number
}

function parsePartHeadingTitle(title: string): { title: string; ordinal?: number } | null {
  const partHeading = title.trim().match(new RegExp(`^第?(${CHINESE_NUMERAL_PATTERN})部$`))
  if (!partHeading) return null
  const ordinal = parseChineseSectionNumber(partHeading[1])
  const normalizedTitle = ordinal ? `第${toChineseSectionNumber(ordinal)}部` : title.trim()
  return { title: normalizedTitle, ordinal: ordinal || undefined }
}

function parseSectionHeading(line: string): ParsedSectionHeading | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const markdownHeading = trimmed.match(/^#{1,6}\s+(.+?)\s*$/)
  if (markdownHeading?.[1]) {
    const title = markdownHeading[1].trim()
    const part = parsePartHeadingTitle(title)
    if (part) {
      return {
        level: (trimmed.match(/^#{1,6}/)?.[0].length) || 1,
        title: part.title,
        kind: 'part',
        ordinal: part.ordinal,
      }
    }
    const ordinal = new RegExp(`^${CHINESE_NUMERAL_PATTERN}$`).test(title)
      ? parseChineseSectionNumber(title)
      : null
    return {
      level: (trimmed.match(/^#{1,6}/)?.[0].length) || 1,
      title,
      kind: ordinal ? 'chapter' : 'markdown',
      ordinal: ordinal || undefined,
    }
  }

  const partHeading = parsePartHeadingTitle(trimmed)
  if (partHeading) {
    return { level: 2, title: partHeading.title, kind: 'part', ordinal: partHeading.ordinal }
  }

  const ordinalHeading = trimmed.match(new RegExp(`^(第(${CHINESE_NUMERAL_PATTERN})(部分|章|节)|引言|摘要|结论|结语|前言)\\s*([：:]\\s*.+)?$`))
  if (ordinalHeading) {
    const suffix = ordinalHeading[4]
      ? ordinalHeading[4].replace(/^[：:]\s*/, '').trim()
      : ''
    const title = suffix ? `${ordinalHeading[1]} ${suffix}` : ordinalHeading[1]
    const unit = ordinalHeading[3] || ''
    const ordinal = ordinalHeading[2] ? parseChineseSectionNumber(ordinalHeading[2]) : null
    return {
      level: unit === '部分' ? 2 : 3,
      title: title.trim(),
      kind: unit === '部分' ? 'part' : unit === '章' || unit === '节' ? 'chapter' : 'section',
      ordinal: ordinal || undefined,
    }
  }

  const numberedHeading = trimmed.match(/^(?:\d+(?:\.\d+)*[.．]?|[一二三四五六七八九十]+[、.．])\s+(.+)$/)
  if (numberedHeading?.[1]) {
    return { level: 3, title: numberedHeading[1].trim(), kind: 'numbered' }
  }

  return null
}

function addAlias(target: string[], alias: string | null | undefined): void {
  const trimmed = String(alias || '').trim()
  if (!trimmed) return
  if (!target.includes(trimmed)) target.push(trimmed)
}

function buildSectionAliases(
  title: string,
  displayTitle: string,
  parentTitles: string[],
  ordinal?: number,
): string[] {
  const aliases: string[] = []
  addAlias(aliases, title)
  addAlias(aliases, displayTitle)
  if (ordinal) {
    const chinese = toChineseSectionNumber(ordinal)
    addAlias(aliases, `第${chinese}章`)
    addAlias(aliases, `第${ordinal}章`)
  }
  for (const parent of parentTitles) {
    addAlias(aliases, `${parent}${title}`)
    addAlias(aliases, `${parent} ${title}`)
    addAlias(aliases, `${parent}-${title}`)
    if (ordinal) {
      const chinese = toChineseSectionNumber(ordinal)
      addAlias(aliases, `${parent}${chinese}`)
      addAlias(aliases, `${parent} ${chinese}`)
      addAlias(aliases, `${parent}-${chinese}`)
      addAlias(aliases, `${parent}第${chinese}章`)
      addAlias(aliases, `${parent}第${ordinal}章`)
    }
  }
  return aliases
}

function displayTitleForSection(parsed: ParsedSectionHeading, parentTitles: string[]): string {
  const parent = parentTitles[parentTitles.length - 1]
  if (parent && parsed.ordinal && parsed.kind === 'chapter') {
    return `${parent}第${toChineseSectionNumber(parsed.ordinal)}章`
  }
  if (parent && parsed.kind === 'chapter') return `${parent} ${parsed.title}`
  return parsed.title
}

export function buildDocumentSectionIndex(content: string): DocumentSectionIndexEntry[] {
  const normalized = normalizeLineEnding(content)
  const lines = normalized.split('\n')
  const entries: DocumentSectionIndexEntry[] = []
  let currentPartTitle: string | null = null

  for (let line = 0; line < lines.length; line += 1) {
    const parsed = parseSectionHeading(lines[line])
    if (!parsed) continue

    const parentTitles = parsed.kind === 'chapter' && currentPartTitle
      ? [currentPartTitle]
      : []
    const displayTitle = displayTitleForSection(parsed, parentTitles)
    const entry: DocumentSectionIndexEntry = {
      id: `section-${entries.length + 1}`,
      line,
      endLine: lines.length,
      level: parsed.level,
      title: parsed.title,
      displayTitle,
      rawLine: lines[line],
      aliases: buildSectionAliases(parsed.title, displayTitle, parentTitles, parsed.ordinal),
      parentTitles,
      kind: parsed.kind,
      ordinal: parsed.ordinal,
    }

    entries.push(entry)
    if (parsed.kind === 'part') currentPartTitle = parsed.title
  }

  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index]
    const nextSameOrParent = entries
      .slice(index + 1)
      .find((candidate) => candidate.level <= current.level)
    current.endLine = nextSameOrParent?.line ?? lines.length
  }

  return entries
}

function findCombinedPartChapterAnchor(
  entries: DocumentSectionIndexEntry[],
  anchor: string,
): DocumentSectionIndexEntry | null {
  const normalized = normalizeDocumentSectionKey(anchor)
  const combined = normalized.match(new RegExp(`^(第?${CHINESE_NUMERAL_PATTERN}部)(?:第?(${CHINESE_NUMERAL_PATTERN})章|(${CHINESE_NUMERAL_PATTERN}))$`))
  if (!combined) return null
  const partKey = normalizeDocumentSectionKey(combined[1])
  const ordinalRaw = combined[2] || combined[3] || ''
  const ordinal = parseChineseSectionNumber(ordinalRaw)
  if (!ordinal) return null
  return entries.find((entry) =>
    entry.kind === 'chapter'
    && entry.ordinal === ordinal
    && entry.parentTitles.some((parent) => normalizeDocumentSectionKey(parent) === partKey)
  ) || null
}

export function resolveDocumentSectionAnchor(
  contentOrEntries: string | DocumentSectionIndexEntry[],
  anchor: string,
): DocumentSectionIndexEntry | null {
  const normalizedAnchor = normalizeDocumentSectionKey(anchor)
  if (!normalizedAnchor) return null

  const entries = Array.isArray(contentOrEntries)
    ? contentOrEntries
    : buildDocumentSectionIndex(contentOrEntries)
  if (entries.length === 0) return null

  for (const entry of entries) {
    if (entry.aliases.some((alias) => normalizeDocumentSectionKey(alias) === normalizedAnchor)) {
      return entry
    }
  }

  const combined = findCombinedPartChapterAnchor(entries, anchor)
  if (combined) return combined

  if (normalizedAnchor.length < 2) return null
  return entries.find((entry) =>
    entry.aliases.some((alias) => {
      const key = normalizeDocumentSectionKey(alias)
      return key.includes(normalizedAnchor) || normalizedAnchor.includes(key)
    })
  ) || null
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
    sectionAliases?: string[]
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
    sectionAliases: params.sectionAliases,
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
  const anchors = buildDocumentSectionIndex(normalized)
  const chunks: DocumentChunk[] = []

  if (anchors.length > 0) {
    for (let index = 0; index < anchors.length; index += 1) {
      const current = anchors[index]
      const nextAnchorLine = anchors[index + 1]?.line ?? lines.length
      const body = lines.slice(current.line + 1, nextAnchorLine).join('\n').trim()
      const paragraphs = splitParagraphs(body)
      if (paragraphs.length === 0) {
        pushChunk(chunks, {
          sectionTitle: current.displayTitle,
          sectionAliases: current.aliases,
          content: lines[current.line].trim(),
          startLine: current.line,
          endLine: nextAnchorLine - 1,
        })
        continue
      }
      const sectionChunks = chunkParagraphs(paragraphs, maxCharsPerChunk)
      sectionChunks.forEach((sectionChunk) => {
        pushChunk(chunks, {
          sectionTitle: current.displayTitle,
          sectionAliases: current.aliases,
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
  const sectionAliases = (chunk.sectionAliases || []).map((alias) => alias.toLowerCase())
  const content = chunk.content.toLowerCase()
  let score = 0
  for (const token of questionTokens) {
    if (sectionTitle.includes(token)) score += 6
    if (sectionAliases.some((alias) => alias.includes(token))) score += 6
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
