import type { AIModelConfig } from '../../../shared/ai-providers'
import { readDocumentEditableText, writeDocumentEditableText } from '../document-engine/document-editable-text'

export interface DocumentChatSessionLike {
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
  abortController: AbortController | null
  systemPrompt: string
  generation: number
  activeRunId: string | null
  preferTextToolBridge: boolean
  lastDocumentContextInput?: string | null
}

export interface SectionRewritePlan {
  sectionTitle: string
  content: string
}

interface SectionAnchor {
  line: number
  level: number
  title: string
  key: string
}

interface FormattingMetrics {
  headingCount: number
  bulletCount: number
  paragraphCount: number
}

export function parseSectionRewritePlan(raw: string): SectionRewritePlan | null {
  if (!raw) return null
  const candidates: string[] = []
  const fencedRegex = /```(?:json|ready-section-rewrite)?\s*([\s\S]*?)```/gi
  let fencedMatch: RegExpExecArray | null = fencedRegex.exec(raw)
  while (fencedMatch) {
    if (fencedMatch[1]?.trim()) candidates.push(fencedMatch[1].trim())
    fencedMatch = fencedRegex.exec(raw)
  }

  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1))
  }
  candidates.push(raw.trim())

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const sectionTitle = typeof parsed.sectionTitle === 'string' ? parsed.sectionTitle.trim() : ''
      const content = typeof parsed.content === 'string' ? parsed.content.trim() : ''
      if (sectionTitle && content) {
        return { sectionTitle, content }
      }
    } catch {
      // Try next candidate.
    }
  }
  return null
}

export function stripCodeFence(raw: string): string {
  return raw
    .replace(/```[\w-]*\n?/g, '')
    .replace(/```/g, '')
    .trim()
}

export async function applyFormatSectionByPath(
  path: string,
  sectionTitle: string | null,
): Promise<{ success: boolean; changed: boolean; message: string }> {
  const readResult = await readDocumentEditableText(path)
  if (!readResult.success) {
    return {
      success: false,
      changed: false,
      message: `读取失败：${readResult.error || path}`,
    }
  }

  if (!sectionTitle) {
    const basic = formatWholeDocumentPreservingMeaning(readResult.content, { aggressive: false })
    const aggressive = formatWholeDocumentPreservingMeaning(readResult.content, { aggressive: true })

    let whole = basic
    const basicScore = basic.metrics.headingCount * 3 + basic.metrics.bulletCount * 2 + basic.metrics.paragraphCount
    const aggressiveScore =
      aggressive.metrics.headingCount * 3 + aggressive.metrics.bulletCount * 2 + aggressive.metrics.paragraphCount

    if (aggressive.changed && (!basic.changed || aggressiveScore > basicScore + 8)) {
      whole = aggressive
    }

    if (!whole.changed) {
      return {
        success: true,
        changed: false,
        message: '整篇文档排版已是目标状态',
      }
    }

    const integrity = validateFormattingIntegrity(readResult.content, whole.content)
    if (!integrity.safe) {
      return {
        success: false,
        changed: false,
        message:
          `排版安全校验未通过（lengthDelta=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%），已取消写入`,
      }
    }

    const writeWholeResult = await writeDocumentEditableText(path, whole.content)
    if (!writeWholeResult.success) {
      return {
        success: false,
        changed: false,
        message: `保存失败：${writeWholeResult.error || path}`,
      }
    }

    const verifyResult = await readDocumentEditableText(path)
    if (!verifyResult.success) {
      return {
        success: false,
        changed: false,
        message: `保存后校验失败：${verifyResult.error || path}`,
      }
    }
    const verifyIntegrity = validateFormattingIntegrity(whole.content, verifyResult.content)
    if (!verifyIntegrity.safe) {
      return {
        success: false,
        changed: false,
        message: '保存后校验失败：写入结果与预期不一致，已中止后续动作',
      }
    }

    return {
      success: true,
      changed: true,
      message: [
        '已优化整篇文档格式并保存',
        `结构指标: heading=${whole.metrics.headingCount}, bullet=${whole.metrics.bulletCount}, paragraph=${whole.metrics.paragraphCount}`,
        `保真校验: Δlen=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%, prefix=${integrity.prefix}, suffix=${integrity.suffix}`,
      ].join('；'),
    }
  }

  const formatted = formatSectionInDocument(readResult.content, sectionTitle)
  if (!formatted.found) {
    return {
      success: false,
      changed: false,
      message: `未找到章节“${sectionTitle}”`,
    }
  }

  if (formatted.content === readResult.content.replace(/\r\n/g, '\n')) {
    return {
      success: true,
      changed: false,
      message: `章节“${formatted.matchedTitle || sectionTitle}”排版已是目标状态`,
    }
  }

  const integrity = validateFormattingIntegrity(readResult.content, formatted.content)
  if (!integrity.safe) {
    return {
      success: false,
      changed: false,
      message:
        `章节排版安全校验未通过（lengthDelta=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%），已取消写入`,
    }
  }

  const writeResult = await writeDocumentEditableText(path, formatted.content)
  if (!writeResult.success) {
    return {
      success: false,
      changed: false,
      message: `保存失败：${writeResult.error || path}`,
    }
  }

  return {
    success: true,
    changed: true,
    message: `已优化章节格式（${formatted.matchedTitle || sectionTitle}）并保存；保真校验Δlen=${(integrity.lengthDeltaRatio * 100).toFixed(2)}%`,
  }
}

export async function applyRewriteSectionByPath(
  path: string,
  sectionTitle: string,
  nextContent: string,
): Promise<{ success: boolean; changed: boolean; message: string }> {
  const readResult = await readDocumentEditableText(path)
  if (!readResult.success) {
    return {
      success: false,
      changed: false,
      message: `读取失败：${readResult.error || path}`,
    }
  }

  const rewritten = rewriteSectionInDocument(readResult.content, sectionTitle, nextContent)
  if (!rewritten.found) {
    return {
      success: false,
      changed: false,
      message: `未找到章节“${sectionTitle}”`,
    }
  }

  if (rewritten.content === readResult.content.replace(/\r\n/g, '\n')) {
    return {
      success: true,
      changed: false,
      message: `章节“${rewritten.matchedTitle || sectionTitle}”内容未发生变化`,
    }
  }

  const writeResult = await writeDocumentEditableText(path, rewritten.content)
  if (!writeResult.success) {
    return {
      success: false,
      changed: false,
      message: `保存失败：${writeResult.error || path}`,
    }
  }

  return {
    success: true,
    changed: true,
    message: `已重写章节（${rewritten.matchedTitle || sectionTitle}）并保存`,
  }
}

export async function buildSectionRewriteDraft(params: {
  session: DocumentChatSessionLike
  config: AIModelConfig
  baseUrl: string
  provider: unknown
  signal: AbortSignal
  isKimi: boolean
  isKimiCoding: boolean
  useAnthropicProtocol: boolean
  callKimiCodingSimple: (
    session: DocumentChatSessionLike,
    config: AIModelConfig,
    baseUrl: string,
    signal: AbortSignal,
  ) => Promise<string>
  callAnthropicSimple: (
    session: DocumentChatSessionLike,
    config: AIModelConfig,
    baseUrl: string,
    signal: AbortSignal,
  ) => Promise<string>
  callOpenAISimple: (
    session: DocumentChatSessionLike,
    config: AIModelConfig,
    baseUrl: string,
    provider: unknown,
    signal: AbortSignal,
    isKimi?: boolean,
    enableKimiWebSearch?: boolean,
  ) => Promise<string>
}): Promise<string> {
  const planningPrompt = [
    '系统任务：你正在执行 Ready 的文档章节编辑流程。',
    '请基于当前对话中最后一条用户请求和文档上下文，只返回一个 JSON 对象，不能有任何额外文本：',
    '{"sectionTitle":"要修改的章节标题","content":"该章节的新内容（不含标题行）"}',
    '要求：',
    '1) sectionTitle 要精确指向用户要求修改的章节（例如“第一部分”）。',
    '2) content 只给章节正文，不要解释。',
    '3) 若无法判断标题，sectionTitle 填写“第一部分”。',
  ].join('\n')

  const planningSession: DocumentChatSessionLike = {
    ...params.session,
    messages: [...params.session.messages, { role: 'user', content: planningPrompt }],
    abortController: null,
  }

  if (params.isKimiCoding) {
    return params.callKimiCodingSimple(planningSession, params.config, params.baseUrl, params.signal)
  }
  if (params.useAnthropicProtocol) {
    return params.callAnthropicSimple(planningSession, params.config, params.baseUrl, params.signal)
  }
  return params.callOpenAISimple(
    planningSession,
    params.config,
    params.baseUrl,
    params.provider,
    params.signal,
    params.isKimi,
    false,
  )
}

function normalizeSectionKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~#>:：,.，。!?！？;；、()[\]{}'"“”‘’\s-]+/g, '')
    .trim()
}

function inferPlainSectionAnchor(
  lines: string[],
  index: number,
  options?: { aggressive?: boolean },
): { level: number; title: string } | null {
  const line = lines[index]?.trim() || ''
  if (!line) return null
  if (line.length < 4 || line.length > 40) return null

  let nextIndex = index + 1
  while (nextIndex < lines.length && !lines[nextIndex].trim()) {
    nextIndex += 1
  }
  const nextLine = nextIndex < lines.length ? lines[nextIndex].trim() : ''

  if (
    !/[。！？；，,:：]/.test(line) &&
    !/[0-9]/.test(line) &&
    /[\u4e00-\u9fa5]{4,}/.test(line) &&
    /^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[.、]))\s+/.test(nextLine)
  ) {
    return { level: 2, title: line }
  }

  if (!options?.aggressive) return null

  const hasText = /[\u4e00-\u9fa5A-Za-z]/.test(line)
  if (!hasText) return null

  const looksQuestionHeading = /[？?！!]$/.test(line) && line.length <= 22
  const shortTitleLike =
    line.length <= 24 &&
    !/[。；，,:：]/.test(line) &&
    !/^(因此|但是|然而|因为|如果|我们|他们|你们|这是|这个)/.test(line)

  const dashLeadTitle = /^[-—–]{1,2}\s*/.test(line) && line.length <= 30
  const latinOnlyTitle = /^[A-Za-z][A-Za-z0-9 _-]{1,30}$/.test(line)

  if (!(looksQuestionHeading || shortTitleLike || dashLeadTitle || latinOnlyTitle)) {
    return null
  }

  return {
    level: looksQuestionHeading ? 2 : 3,
    title: line,
  }
}

function parseSectionAnchor(rawLine: string): { level: number; title: string } | null {
  const line = rawLine.trim()
  if (!line) return null

  const markdownHeading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
  if (markdownHeading) {
    return {
      level: markdownHeading[1].length,
      title: markdownHeading[2].trim(),
    }
  }

  const numericHeading = line.match(
    /^((?:\d{1,2}\.\d{1,2}(?:\.\d{1,2})*)|(?:\d{1,2}[.、]))\s+(.+)$/,
  )
  if (numericHeading && line.length <= 100) {
    const numericCore = numericHeading[1].replace(/[、.]$/, '')
    const depth = numericCore.split('.').filter(Boolean).length
    return {
      level: Math.min(6, depth + 1),
      title: `${numericCore} ${numericHeading[2].trim()}`.trim(),
    }
  }

  const chineseOrdinalHeading = line.match(
    /^(?:([一二三四五六七八九十百千]+)[、.．]\s*(.+)|[（(]([一二三四五六七八九十百千]+)[）)]\s*(.+))$/,
  )
  if (chineseOrdinalHeading && line.length <= 100) {
    const ordinal = chineseOrdinalHeading[1] || chineseOrdinalHeading[3] || ''
    const body = chineseOrdinalHeading[2] || chineseOrdinalHeading[4] || ''
    return {
      level: 2,
      title: `${ordinal} ${body.trim()}`.trim(),
    }
  }

  const plainHeading = line.match(
    /^(第[一二三四五六七八九十百千万0-9]+(?:部分|章|节)|引言|序言|前言|摘要|结语|结论|附录)\s*([：:]\s*.+)?$/,
  )
  if (!plainHeading) return null
  if (line.length > 80) return null
  const suffix = plainHeading[2] ? plainHeading[2].replace(/^[：:]\s*/, '').trim() : ''
  const title = suffix ? `${plainHeading[1]} ${suffix}` : plainHeading[1]
  return {
    level: 2,
    title: title.trim(),
  }
}

function collectSectionAnchors(lines: string[], options?: { aggressive?: boolean }): SectionAnchor[] {
  const anchors: SectionAnchor[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseSectionAnchor(lines[i]) || inferPlainSectionAnchor(lines, i, options)
    if (!parsed) continue
    anchors.push({
      line: i,
      level: parsed.level,
      title: parsed.title,
      key: normalizeSectionKey(parsed.title),
    })
  }
  return anchors
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

function extractSectionOrdinal(sectionTitle: string): number | null {
  const match = sectionTitle.match(/第([一二三四五六七八九十两0-9]+)(?:部分|章|节)?/i)
  if (!match?.[1]) return null
  return parseChineseSectionNumber(match[1])
}

function pickOrdinalAnchor(sectionAnchors: SectionAnchor[], ordinal: number): SectionAnchor | null {
  if (ordinal < 1) return null
  if (sectionAnchors.length === 0) return null
  const minLevel = Math.min(...sectionAnchors.map((item) => item.level))
  const topLevelAnchors = sectionAnchors.filter((item) => item.level === minLevel)
  if (topLevelAnchors.length === 0) return null
  return topLevelAnchors[ordinal - 1] || null
}

function findSectionAnchor(sectionAnchors: SectionAnchor[], sectionTitle: string): SectionAnchor | null {
  const targetKey = normalizeSectionKey(sectionTitle)
  if (!targetKey) return null
  const exact = sectionAnchors.find((item) => item.key === targetKey)
  if (exact) return exact
  const fuzzy =
    sectionAnchors.find((item) => item.key.includes(targetKey) || targetKey.includes(item.key)) || null
  if (fuzzy) return fuzzy
  const ordinal = extractSectionOrdinal(sectionTitle)
  if (ordinal) {
    const byOrdinal = pickOrdinalAnchor(sectionAnchors, ordinal)
    if (byOrdinal) return byOrdinal
  }
  return null
}

function getSectionEndLine(sectionAnchors: SectionAnchor[], current: SectionAnchor, totalLines: number): number {
  let sectionEndLine = totalLines
  for (const anchor of sectionAnchors) {
    if (anchor.line <= current.line) continue
    if (anchor.level <= current.level) {
      sectionEndLine = anchor.line
      break
    }
  }
  return sectionEndLine
}

function formatParagraphIntoReadableChunks(
  paragraph: string,
  options?: { aggressive?: boolean },
): string {
  const cleaned = paragraph.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (cleaned.length < 130 || !/[。！？；!?;]/.test(cleaned)) {
    if (options?.aggressive) {
      const ordinalBulletSplit = cleaned
        .split(/(?=其[一二三四五六七八九十][，、]|第[一二三四五六七八九十百0-9]+[，、])/g)
        .map((item) => item.trim())
        .filter(Boolean)
      if (ordinalBulletSplit.length >= 3) {
        return ordinalBulletSplit.map((item) => `- ${item}`).join('\n')
      }
    }
    return cleaned
  }

  const chunks = cleaned
    .split(/(?<=[。！？；!?;])\s*/g)
    .map((item) => item.trim())
    .filter(Boolean)
  if (chunks.length <= 1) return cleaned

  if (options?.aggressive && chunks.length >= 4) {
    const ordinalBulletSplit = cleaned
      .split(/(?=其[一二三四五六七八九十][，、]|第[一二三四五六七八九十百0-9]+[，、])/g)
      .map((item) => item.trim())
      .filter(Boolean)
    if (ordinalBulletSplit.length >= 3) {
      return ordinalBulletSplit.map((item) => `- ${item}`).join('\n')
    }
  }

  const grouped: string[] = []
  let bucket: string[] = []
  for (const sentence of chunks) {
    bucket.push(sentence)
    const joinLimit = options?.aggressive ? 70 : 100
    const sentenceLimit = options?.aggressive ? 1 : 2
    if (bucket.length >= sentenceLimit || bucket.join('').length >= joinLimit) {
      grouped.push(bucket.join(''))
      bucket = []
    }
  }
  if (bucket.length > 0) grouped.push(bucket.join(''))
  return grouped.join('\n\n')
}

function formatSectionBodyPreservingMeaning(
  sourceBody: string,
  options?: { aggressive?: boolean },
): string {
  const normalized = sourceBody.replace(/\r\n/g, '\n')
  const collapsed = normalized
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!collapsed) return ''
  const paragraphs = collapsed
    .split(/\n{2,}/)
    .map((item) => item.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
  return paragraphs.map((item) => formatParagraphIntoReadableChunks(item, options)).join('\n\n').trim()
}

function formatSectionInDocument(
  source: string,
  sectionTitle: string,
): { content: string; found: boolean; matchedTitle?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const sectionAnchors = collectSectionAnchors(lines)
  const target = findSectionAnchor(sectionAnchors, sectionTitle)
  if (!target) return { content: normalizedSource, found: false }

  const sectionEndLine = getSectionEndLine(sectionAnchors, target, lines.length)
  const originalBody = lines.slice(target.line + 1, sectionEndLine).join('\n')
  const formattedBody = formatSectionBodyPreservingMeaning(originalBody)
  const headingMeta = parseSectionAnchor(lines[target.line]) || inferPlainSectionAnchor(lines, target.line)
  const headingLine = lines[target.line].trim()
  const normalizedHeading = /^#{1,6}\s+/.test(headingLine)
    ? headingLine
    : headingMeta
      ? `${'#'.repeat(Math.min(Math.max(headingMeta.level, 1), 4))} ${headingLine}`
      : lines[target.line]
  const nextLines = [
    ...lines.slice(0, target.line),
    normalizedHeading,
    formattedBody,
    ...lines.slice(sectionEndLine),
  ]
  return {
    content: nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    found: true,
    matchedTitle: target.title,
  }
}

function computeFormattingMetrics(content: string): FormattingMetrics {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const headingCount = lines.filter((line) => /^#{1,6}\s+/.test(line.trim())).length
  const bulletCount = lines.filter((line) => /^[-*]\s+/.test(line.trim())).length
  const paragraphCount = normalized
    .trim()
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean).length
  return {
    headingCount,
    bulletCount,
    paragraphCount,
  }
}

function normalizeForIntegrityCheck(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, '')
    .trim()
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i += 1
  return i
}

function commonSuffixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

function validateFormattingIntegrity(before: string, after: string): {
  safe: boolean
  lengthDeltaRatio: number
  prefix: number
  suffix: number
} {
  const source = normalizeForIntegrityCheck(before)
  const next = normalizeForIntegrityCheck(after)
  if (!source || !next) {
    return {
      safe: false,
      lengthDeltaRatio: 1,
      prefix: 0,
      suffix: 0,
    }
  }
  const lengthDeltaRatio = Math.abs(next.length - source.length) / Math.max(1, source.length)
  const prefix = commonPrefixLength(source, next)
  const suffix = commonSuffixLength(source, next)
  const safe = lengthDeltaRatio <= 0.08 && prefix >= 20 && suffix >= 20
  return { safe, lengthDeltaRatio, prefix, suffix }
}

function formatWholeDocumentPreservingMeaning(
  source: string,
  options?: { aggressive?: boolean },
): { content: string; changed: boolean; metrics: FormattingMetrics } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const nextLines: string[] = []
  const buffer: string[] = []

  const flushBuffer = () => {
    if (buffer.length === 0) return
    const formatted = formatSectionBodyPreservingMeaning(buffer.join('\n'), options)
    if (!formatted) {
      nextLines.push('')
      buffer.length = 0
      return
    }
    nextLines.push(...formatted.split('\n'))
    buffer.length = 0
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    const parsedHeading = parseSectionAnchor(line) || inferPlainSectionAnchor(lines, i, options)
    if (parsedHeading) {
      flushBuffer()
      const normalizedHeading = /^#{1,6}\s+/.test(trimmed)
        ? trimmed
        : `${'#'.repeat(Math.min(Math.max(parsedHeading.level, 1), 4))} ${trimmed}`
      if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
        nextLines.push('')
      }
      nextLines.push(normalizedHeading)
      nextLines.push('')
      continue
    }
    if (!trimmed) {
      flushBuffer()
      if (nextLines.length === 0 || nextLines[nextLines.length - 1] !== '') {
        nextLines.push('')
      }
      continue
    }
    buffer.push(line)
  }

  flushBuffer()

  const nextContent = nextLines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
  const metrics = computeFormattingMetrics(nextContent)
  return {
    content: nextContent,
    changed: nextContent !== normalizedSource,
    metrics,
  }
}

function rewriteSectionInDocument(
  source: string,
  sectionTitle: string,
  nextSectionBody: string,
): { content: string; found: boolean; matchedTitle?: string } {
  const normalizedSource = source.replace(/\r\n/g, '\n')
  const lines = normalizedSource.split('\n')
  const sectionAnchors = collectSectionAnchors(lines)
  const target = findSectionAnchor(sectionAnchors, sectionTitle)
  if (!target) return { content: normalizedSource, found: false }

  const sectionEndLine = getSectionEndLine(sectionAnchors, target, lines.length)
  const replacementBody = nextSectionBody.replace(/\r\n/g, '\n').trim()
  const replacementLines = [lines[target.line], replacementBody]
  const nextLines = [
    ...lines.slice(0, target.line),
    ...replacementLines,
    ...lines.slice(sectionEndLine),
  ]
  return {
    content: nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    found: true,
    matchedTitle: target.title,
  }
}
