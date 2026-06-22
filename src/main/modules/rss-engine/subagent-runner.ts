import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { type AIModelConfig, getProviderDef, normalizeAIConfig, resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import { parseJsonOrEventStreamResponse } from '../openai-responses'
import { AppSettingsRepository } from '../repositories/app-settings-repository'

interface CompletionRequest {
  system: string
  user: string
  maxTokens: number
  timeoutMs?: number
}

interface CopySummaryInput {
  title: string
  link: string
  source?: string
  publishedAt?: string
  summary?: string
  extractedText: string
}

interface CopyDeliverables {
  correctedTranscript: string
  structuredTranscript: string
  report: string
}

export interface CopyDeliverableProgress {
  message: string
  completed: number
}

export interface CopyDeliverableOptions {
  onProgress?: (progress: CopyDeliverableProgress) => void
}

interface TranscriptSectionPlan {
  title: string
  anchor?: string
}

interface VisualSummaryInput {
  title: string
  link: string
  source?: string
  pipelineSummary: string
}

const REQUIRED_COPY_HEADINGS = [
  '## 一、TextContent Analysis 视角',
  '## 二、Viral-Abstract-Script 视角',
  '## 三、Brainstorming 视角',
]
const FALLBACK_COPY_SUMMARY_MARKERS = [
  'AI 深度分析未返回完整结果',
  '当前为保底报告',
]
let cachedVideoCopySkillContract: { analysis: string; structured: string } | null | undefined

function clipText(input: string, maxChars: number): string {
  const text = input.replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

function hasCompleteCopySummaryShape(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  return REQUIRED_COPY_HEADINGS.every((heading) => normalized.includes(heading))
}

export function isFallbackCopySummary(text: string): boolean {
  return FALLBACK_COPY_SUMMARY_MARKERS.some((marker) => text.includes(marker))
}

function splitTranscriptSnippets(text: string): string[] {
  return text
    .replace(/\r/g, '\n')
    .split(/(?<=[。！？!?])\s+|[.!?]\s+|\n+/u)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 6)
}

function pickSnippet(snippets: string[], index: number): string {
  if (snippets.length === 0) return '文字稿内容较短，需结合完整转录继续判断。'
  return snippets[Math.min(Math.max(index, 0), snippets.length - 1)]
}

function extractKeywordList(text: string): string {
  const matches = text.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z'-]{3,}/g) || []
  const keywords: string[] = []
  for (const match of matches) {
    const normalized = match.trim()
    if (!normalized || keywords.includes(normalized)) continue
    keywords.push(normalized)
    if (keywords.length >= 12) break
  }
  return keywords.length ? keywords.join('、') : '见完整文字稿'
}

function buildFallbackCopySummary(input: CopySummaryInput): string {
  const text = clipText(input.extractedText, 6_000)
  const snippets = splitTranscriptSnippets(text)
  const opening = pickSnippet(snippets, 0)
  const middle = pickSnippet(snippets, Math.floor(snippets.length / 2))
  const ending = pickSnippet(snippets, snippets.length - 1)
  const keywords = extractKeywordList(text)

  return [
    '## 一、TextContent Analysis 视角',
    `- 叙事结构分析（开场/发展/高潮/转折/结尾）：AI 深度分析未返回完整结果，当前报告基于文字稿自动保底整理。开场信息可参考“${opening}”；中段重点可参考“${middle}”；结尾收束可参考“${ending}”。`,
    '- 叙事声音分析（基调/节奏/金句）：以原始口播为准，整体节奏和表达强弱需要结合完整视频复核。',
    '- 修辞手法识别（比喻/反转/呼应/隐喻）：未做外延推断，仅保留文字稿中可见的表达线索。',
    `- 词库提取（关键词 8-15 个）：${keywords}。`,
    '',
    '## 二、Viral-Abstract-Script 视角',
    '- Viral-5D 诊断（Hook/Emotion/爆点/CTA/社交货币，分别 1-5 星并简评）：当前为保底报告，暂不虚构星级评分；建议人工复核开场吸引力、情绪推进、可传播句和行动号召。',
    '- 风格定位（2-4 个标签）：基于文字稿可先归为口播叙事、经验分享、观点表达，最终标签需结合画面与账号定位确认。',
    '- 爆款潜力评估（完播率/互动率/转发率）：缺少模型完整判断时不做确定结论；可优先检查开头 5 秒、情绪峰值和结尾互动设计。',
    '- 优化建议（1-3 条，必须可执行）：补强开场钩子；压缩重复铺垫；在结尾加入明确互动或转发理由。',
    '',
    '## 三、Brainstorming 视角',
    '- 核心价值拆解：以文字稿中的主要观点、经历或产品承诺为核心，避免扩展原文没有的信息。',
    '- 创意方向探索（2-3 个）：可围绕开场冲突、过程反差、结尾总结分别做短版切条；也可把高信息密度片段拆成对比式脚本。',
    '- 增量验证点（2-4 个可测试项）：测试不同开场句；测试结尾 CTA；测试标题关键词；测试字幕节奏和段落停顿。',
  ].join('\n')
}

function readFirstExisting(paths: string[]): string {
  for (const path of paths) {
    try {
      if (existsSync(path)) return readFileSync(path, 'utf-8')
    } catch {
      // silent-catch: optional SKILL.md candidates fall through to the bundled copy.
    }
  }
  return ''
}

function extractSkillSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading)
  if (start < 0) return ''
  const rest = markdown.slice(start)
  const nextMatch = rest.slice(heading.length).match(/\n---\n|\n### 阶段 \d+:/)
  const end = nextMatch?.index === undefined
    ? rest.length
    : heading.length + nextMatch.index
  return rest.slice(0, end).trim()
}

function loadVideoCopySkillContract(): { analysis: string; structured: string } | null {
  if (cachedVideoCopySkillContract !== undefined) return cachedVideoCopySkillContract
  const skillMarkdown = readFirstExisting([
    process.env.READY_VIDEO_COPY_ANALYZER_SKILL_MD || '',
    join(homedir(), 'Library', 'Application Support', 'ready', 'skill-runtime', 'skills', 'video-copy-analyzer', 'SKILL.md'),
    join(process.cwd(), 'assets', 'embedded-skills', 'video-copy-analyzer', 'SKILL.md'),
  ].filter(Boolean))
  if (!skillMarkdown) {
    cachedVideoCopySkillContract = null
    return cachedVideoCopySkillContract
  }
  cachedVideoCopySkillContract = {
    analysis: extractSkillSection(skillMarkdown, '### 阶段 4: 三维度综合分析'),
    structured: extractSkillSection(skillMarkdown, '### 阶段 5: 结构化文字稿'),
  }
  return cachedVideoCopySkillContract
}

function getMarkdownBodyLength(text: string): number {
  return text
    .replace(/^#+\s+.*$/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .length
}

export function hasReliableTranscriptPunctuation(text: string): boolean {
  const bodyLength = getMarkdownBodyLength(text)
  if (bodyLength < 40) return true

  const sentenceMarks = text.match(/[。！？!?]/g)?.length || 0
  if (sentenceMarks < 1) return false

  const minSentenceMarks = bodyLength >= 500
    ? Math.max(3, Math.floor(bodyLength / 260))
    : 1
  if (sentenceMarks < minSentenceMarks) return false

  const separators = sentenceMarks + (text.match(/[，,、；;：:]/g)?.length || 0)
  const minSeparators = bodyLength >= 500
    ? Math.max(minSentenceMarks, Math.floor(bodyLength / 140))
    : 1
  return separators >= minSeparators
}

export function hasLinePerSentenceParagraphSmell(text: string): boolean {
  const paragraphs = text
    .replace(/\r/g, '\n')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item && !/^#{1,6}\s+/.test(item))
  if (paragraphs.length < 5) return false

  const shortSentenceParagraphs = paragraphs.filter((paragraph) => {
    const bodyLength = getMarkdownBodyLength(paragraph)
    const sentenceMarks = paragraph.match(/[。！？!?]/g)?.length || 0
    return bodyLength <= 90 && sentenceMarks <= 1
  })
  return shortSentenceParagraphs.length / paragraphs.length >= 0.7
}

function hasCorrectedTranscriptShape(text: string, sourceText: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false

  const sourceLength = getMarkdownBodyLength(sourceText)
  const bodyLength = getMarkdownBodyLength(normalized)
  const minLength = sourceLength < 120
    ? Math.max(16, Math.floor(sourceLength * 0.6))
    : Math.floor(sourceLength * 0.8)
  return bodyLength >= minLength
}

function hasUsableCorrectedTranscriptShape(text: string, sourceText: string): boolean {
  return hasCorrectedTranscriptShape(text, sourceText) && hasReliableTranscriptPunctuation(text)
}

function formatCorrectedTranscript(title: string, text: string): string {
  const normalized = text.trim()
  if (normalized.includes('## 完整文稿')) return normalized
  return [
    `# ${title} 校正文稿`,
    '',
    '## 完整文稿',
    '',
    normalized,
  ].join('\n')
}

function extractMarkdownBody(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#+\s+/.test(line))
  return lines.join('\n').trim()
}

function getTranscriptPlainBody(text: string): string {
  return extractMarkdownBody(text) || text.trim()
}

function joinInlineParts(parts: string[]): string {
  let result = ''
  for (const raw of parts) {
    const part = raw.trim()
    if (!part) continue
    if (!result) {
      result = part
      continue
    }
    const needsSpace = /[A-Za-z0-9]$/.test(result) && /^[A-Za-z0-9]/.test(part)
    result += `${needsSpace ? ' ' : ''}${part}`
  }
  return result
}

function splitSentenceUnits(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const matches = normalized.match(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$/gu)
  return (matches || [normalized])
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatTranscriptParagraphs(text: string): string {
  const sentenceUnits: string[] = []
  for (const rawParagraph of text.replace(/\r/g, '\n').split(/\n{2,}/)) {
    const inline = joinInlineParts(
      rawParagraph
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
    sentenceUnits.push(...splitSentenceUnits(inline))
  }
  if (!sentenceUnits.length) return text.trim()

  const paragraphs: string[] = []
  let current: string[] = []
  let currentLength = 0
  const flush = () => {
    if (!current.length) return
    paragraphs.push(joinInlineParts(current))
    current = []
    currentLength = 0
  }

  for (const sentence of sentenceUnits) {
    if (current.length >= 3 && currentLength + sentence.length > 360) {
      flush()
    }
    current.push(sentence)
    currentLength += sentence.length
    if (current.length >= 5) {
      flush()
    }
  }
  flush()
  return paragraphs.join('\n\n').trim()
}

function requiresStructuredSectionPlan(correctedTranscript: string): boolean {
  const body = extractMarkdownBody(correctedTranscript) || correctedTranscript.trim()
  return getMarkdownBodyLength(body) >= 500 && splitSentenceUnits(body).length >= 6
}

function isGenericStructuredTitle(title: string): boolean {
  const normalized = title
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '')
    .replace(/\s+/g, '')
    .trim()
  return [
    '完整口播',
    '完整文稿',
    '完整文字稿',
    '全文整理',
    '全文',
    '口播全文',
    '结构化文字稿',
  ].includes(normalized)
}

function hasOnlyGenericStructuredHeading(text: string): boolean {
  const headings = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^##\s+/.test(line))
  return headings.length === 1 && isGenericStructuredTitle(headings[0])
}

function hasUsableStructuredPlan(plan: TranscriptSectionPlan[], correctedTranscript: string): boolean {
  if (!plan.length) return false
  if (
    requiresStructuredSectionPlan(correctedTranscript)
    && plan.length === 1
    && isGenericStructuredTitle(plan[0]?.title || '')
  ) {
    return false
  }
  return true
}

function splitTranscriptChunks(text: string, targetChars = 1_400): string[] {
  const normalized = text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (!normalized) return []

  const pieces = normalized
    .split(/(?<=[。！？!?])\s+|[.!?]\s+|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (piece.length > targetChars * 1.5) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      for (let start = 0; start < piece.length; start += targetChars) {
        const slice = piece.slice(start, start + targetChars).trim()
        if (slice) chunks.push(slice)
      }
      continue
    }

    const next = current ? `${current}\n${piece}` : piece
    if (next.length > targetChars && current) {
      chunks.push(current)
      current = piece
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function correctionChunkMaxTokens(chunk: string): number {
  return Math.min(3_200, Math.max(900, Math.ceil(getMarkdownBodyLength(chunk) * 1.4)))
}

function buildFallbackStructuredTranscript(title: string, correctedTranscript: string): string {
  const sourceBody = extractMarkdownBody(correctedTranscript) || correctedTranscript.trim()
  const body = formatTranscriptParagraphs(sourceBody)
  return [
    `# ${title} 结构化文字稿`,
    '',
    '## 一、完整口播',
    '',
    body || correctedTranscript.trim(),
  ].join('\n')
}

function hasStructuredTranscriptShape(text: string, correctedTranscript: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  const sectionCount = normalized.match(/^##\s+/gm)?.length || 0
  if (sectionCount < 1) return false
  if (requiresStructuredSectionPlan(correctedTranscript) && hasOnlyGenericStructuredHeading(normalized)) return false
  if (hasLinePerSentenceParagraphSmell(normalized)) return false
  if (!hasReliableTranscriptPunctuation(normalized)) return false

  const referenceLength = getMarkdownBodyLength(correctedTranscript)
  const structuredLength = getMarkdownBodyLength(normalized)
  const minLength = referenceLength < 120
    ? Math.max(30, Math.floor(referenceLength * 0.5))
    : Math.floor(referenceLength * 0.45)
  return structuredLength >= minLength
}

function parseStructuredTranscriptPlan(text: string): TranscriptSectionPlan[] {
  const raw = text.trim()
  if (!raw) return []
  const jsonMatch = raw.match(/\[[\s\S]*\]|\{[\s\S]*\}/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sections?: unknown }).sections)
        ? (parsed as { sections: unknown[] }).sections
        : []
    const result: TranscriptSectionPlan[] = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const title = typeof record.title === 'string'
        ? record.title.trim()
        : typeof record.heading === 'string'
          ? record.heading.trim()
          : ''
      const anchor = typeof record.anchor === 'string'
        ? record.anchor.trim()
        : typeof record.startText === 'string'
          ? record.startText.trim()
          : typeof record.start === 'string'
            ? record.start.trim()
            : ''
      if (!title) continue
      result.push(anchor ? { title, anchor } : { title })
    }
    return result.slice(0, 12)
  } catch {
    return []
  }
}

function normalizePlanTitle(title: string, index: number): string {
  const cleaned = title
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '')
    .trim()
  const fallback = index === 0 ? '开场' : index === 1 ? '发展' : '收束'
  const ordinal = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][index] || `${index + 1}`
  return `${ordinal}、${cleaned || fallback}`
}

function findAnchorIndex(body: string, anchor: string, minIndex: number): number {
  const trimmed = anchor.trim()
  if (!trimmed) return -1

  const direct = body.indexOf(trimmed, minIndex)
  if (direct >= minIndex) return direct

  const compactAnchor = trimmed.replace(/\s+/g, '')
  if (!compactAnchor) return -1
  let compactBody = ''
  const map: number[] = []
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (/\s/.test(char)) continue
    map.push(index)
    compactBody += char
  }
  const compactMinIndex = map.findIndex((originalIndex) => originalIndex >= minIndex)
  const hit = compactBody.indexOf(compactAnchor, Math.max(0, compactMinIndex))
  return hit >= 0 ? map[hit] ?? -1 : -1
}

function buildStructuredTranscriptFromPlan(
  title: string,
  correctedTranscript: string,
  plan: TranscriptSectionPlan[],
): string {
  const body = extractMarkdownBody(correctedTranscript) || correctedTranscript.trim()
  if (!body || !plan.length) return buildFallbackStructuredTranscript(title, correctedTranscript)
  if (
    requiresStructuredSectionPlan(correctedTranscript)
    && plan.length === 1
    && isGenericStructuredTitle(plan[0]?.title || '')
  ) {
    return ''
  }

  const boundaries: Array<{ title: string; index: number }> = [
    { title: plan[0]?.title || '完整口播', index: 0 },
  ]
  for (let index = 1; index < plan.length; index += 1) {
    const item = plan[index]
    const anchorIndex = findAnchorIndex(body, item.anchor || '', boundaries[boundaries.length - 1].index + 12)
    if (anchorIndex > boundaries[boundaries.length - 1].index) {
      boundaries.push({ title: item.title, index: anchorIndex })
    }
  }

  if (boundaries.length < 2 && plan.length > 1) {
    return ''
  }

  const parts = [`# ${title} 结构化文字稿`, '']
  for (let index = 0; index < boundaries.length; index += 1) {
    const current = boundaries[index]
    const next = boundaries[index + 1]
    const segment = body.slice(current.index, next?.index ?? body.length).trim()
    if (!segment) continue
    parts.push(`## ${normalizePlanTitle(current.title, index)}`, '', formatTranscriptParagraphs(segment), '')
  }
  return parts.join('\n').trim()
}

function readAIConfig(): AIModelConfig | null {
  try {
    const raw = settingsRepository.getSetting('ai_model_config')
    if (!raw) return null
    return normalizeAIConfig(JSON.parse(raw) as AIModelConfig)
  } catch {
    return null
  }
}

function extractOpenAIText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices
  const content = choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        return typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''
      })
      .filter(Boolean)
    return textParts.join('\n').trim()
  }
  return ''
}

function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const direct = (payload as { output_text?: unknown }).output_text
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const output = Array.isArray((payload as { output?: unknown[] }).output)
    ? (payload as { output: unknown[] }).output
    : []
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type !== 'message') continue
    const content = Array.isArray(record.content) ? record.content : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const block = part as Record<string, unknown>
      if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
        chunks.push(block.text)
      }
    }
  }
  return chunks.join('').trim()
}

function buildAnthropicLikeHeaders(config: AIModelConfig, baseUrl: string): Record<string, string> {
  const provider = getProviderDef(config.provider, baseUrl)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if ((provider?.id === 'anthropic' && !config.agentProtocol) || baseUrl.includes('api.kimi.com/coding')) {
    headers['x-api-key'] = config.apiKey
    return headers
  }
  const authHeader = provider?.authHeader || 'Authorization'
  const authPrefix = provider?.authPrefix ?? 'Bearer '
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) {
    Object.assign(headers, provider.extraHeaders)
  }
  return headers
}

function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const content = (payload as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n')
}

export class RSSSubagentRunner {
  getVisualAnalyzerEnv(): Record<string, string> | undefined {
    const config = readAIConfig()
    if (!config?.apiKey) return undefined
    const baseUrl = (config.baseUrl || '').trim()
    return {
      VIDEO_ANALYZER_API_KEY: config.apiKey,
      VIDEO_ANALYZER_BASE_URL: baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
      VIDEO_ANALYZER_MODEL: config.model || 'gemini-2.0-flash',
    }
  }

  async buildCopyDeliverables(input: CopySummaryInput, options: CopyDeliverableOptions = {}): Promise<CopyDeliverables> {
    options.onProgress?.({ message: '文字稿已生成，正在校正文稿。', completed: 2 })
    const correctedTranscript = await this.correctCopyTranscript(input)
    options.onProgress?.({ message: '校正文稿完成，正在生成三维度文案分析报告。', completed: 3 })
    const report = await this.summarizeCopy({
      ...input,
      extractedText: correctedTranscript,
    })
    if (isFallbackCopySummary(report)) {
      throw new Error('Video Copy Analyzer 未能生成符合技能合同的三维度文案分析报告。')
    }
    options.onProgress?.({ message: '文案分析报告完成，正在整理结构化文字稿。', completed: 4 })
    const structuredTranscript = await this.structureCopyTranscript({
      ...input,
      correctedTranscript,
      report,
    })
    options.onProgress?.({ message: '文案分析报告和结构化文字稿已生成。', completed: 5 })
    return { correctedTranscript, structuredTranscript, report }
  }

  private async correctCopyTranscript(input: CopySummaryInput): Promise<string> {
    const sourceBody = getTranscriptPlainBody(input.extractedText)
    const chunks = splitTranscriptChunks(sourceBody)
    if (!chunks.length) return formatCorrectedTranscript(input.title, sourceBody)

    const correctedChunks: string[] = []
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      const text = await this.complete({
        system: [
          '你是短视频文稿校正助手。',
          '只输出当前片段校正后的正文，不要加标题。',
          '保留原意和口语风格，不增加原文没有的信息。',
          '重点修正 ASR 同音字、错别字、断句和标点。',
        ].join(''),
        user: [
          `标题: ${input.title}`,
          `链接: ${input.link}`,
          input.source ? `来源账号: ${input.source}` : '',
          `片段: ${index + 1}/${chunks.length}`,
          '',
          '原始转录文本:',
          chunk,
          '',
          '请只输出这个片段校正后的完整正文。',
        ].filter(Boolean).join('\n'),
        maxTokens: correctionChunkMaxTokens(chunk),
        timeoutMs: 120_000,
      })
      let body = extractMarkdownBody(text) || text.trim()
      if (!hasUsableCorrectedTranscriptShape(body, chunk)) {
        const retryText = await this.complete({
          system: [
            '你是短视频文稿标点恢复助手。',
            '只输出当前片段校正后的正文，不要加标题。',
            '必须补全中文句号、逗号、问号、感叹号和自然断句。',
            '保留原意和口语风格，不增加原文没有的信息。',
          ].join(''),
          user: [
            `标题: ${input.title}`,
            `链接: ${input.link}`,
            input.source ? `来源账号: ${input.source}` : '',
            `片段: ${index + 1}/${chunks.length}`,
            '',
            '原始转录文本:',
            chunk,
            '',
            body ? '上一次校正文稿缺少可靠标点:' : '上一次请求没有返回可用校正文稿:',
            body || '(空)',
            '',
            '请重新输出这个片段的完整正文，必须有自然句子边界和中文标点。',
          ].filter(Boolean).join('\n'),
          maxTokens: correctionChunkMaxTokens(chunk),
          timeoutMs: body ? 180_000 : 240_000,
        })
        const retryBody = extractMarkdownBody(retryText) || retryText.trim()
        body = hasUsableCorrectedTranscriptShape(retryBody, chunk) ? retryBody : body
      }
      correctedChunks.push(hasUsableCorrectedTranscriptShape(body, chunk) ? body : chunk)
    }

    const corrected = correctedChunks.join('\n\n').trim()
    if (hasUsableCorrectedTranscriptShape(corrected, sourceBody)) {
      return formatCorrectedTranscript(input.title, corrected)
    }

    if (hasUsableCorrectedTranscriptShape(sourceBody, sourceBody)) {
      return formatCorrectedTranscript(input.title, sourceBody)
    }

    throw new Error('Video Copy Analyzer 校正文稿缺少可靠标点，无法生成结构化文字稿。')
  }

  private async structureCopyTranscript(input: CopySummaryInput & {
    correctedTranscript: string
    report: string
  }): Promise<string> {
    const system = [
      '你是短视频文稿结构化助手。',
      '只输出 JSON，不输出 Markdown 正文。',
      '你只负责给分段建议，正文会由代码从完整校正文稿中保留。',
      '必须遵循 Video Copy Analyzer SKILL.md 的结构化文字稿合同。',
    ].join('')
    const buildUserPrompt = (retryNote?: string) => [
        `标题: ${input.title}`,
        '',
        'Video Copy Analyzer SKILL.md 阶段 5 合同:',
        loadVideoCopySkillContract()?.structured || '必须按自然叙事段落切分，为每段添加简洁小标题，并保持 3-5 句一段。',
        '',
        '校正文稿:',
        clipText(input.correctedTranscript, 12_000),
        '',
        '分析报告:',
        clipText(input.report, 4_000),
        '',
        '请输出 JSON，格式为：',
        '{"sections":[{"title":"段落标题","anchor":"这一段在校正文稿里的起始原文短句"}]}',
        '',
        '要求：',
        '- 按内容理解和叙事功能合并相关段落，不要机械按换行拆，也不要每个自然段都拆标题；',
        '- sections 数量由内容决定，不要为了凑数拆分；',
        '- 不要使用“完整口播/全文整理”这类泛标题替代内容理解；',
        '- anchor 必须直接摘自校正文稿，用于定位段落开头；',
        '- 不要输出任何正文内容。',
        retryNote ? '' : '',
        retryNote || '',
      ].join('\n')

    const text = await this.complete({
      system,
      user: buildUserPrompt(),
      maxTokens: 900,
      timeoutMs: 120_000,
    })
    let plan = parseStructuredTranscriptPlan(text)
    let structured = hasUsableStructuredPlan(plan, input.correctedTranscript)
      ? buildStructuredTranscriptFromPlan(input.title, input.correctedTranscript, plan)
      : ''
    if (structured && hasStructuredTranscriptShape(structured, input.correctedTranscript)) {
      return structured
    }

    const retryText = await this.complete({
      system,
      user: buildUserPrompt([
        text
          ? '上一次分段计划不可用。请重新基于校正文稿和分析报告输出可定位的分段计划。'
          : '上一次没有返回分段计划。请重新基于校正文稿和分析报告输出可定位的分段计划。',
        requiresStructuredSectionPlan(input.correctedTranscript)
          ? '如果文稿只有单一核心段落，可以只返回一个有内容指向的小标题；如果包含多个叙事功能，请合并成少量章节。不要返回“完整口播/全文整理”。'
          : '如果内容确实很短，可以只返回一个章节。',
        text ? `上一次输出:\n${clipText(text, 1_200)}` : '',
      ].filter(Boolean).join('\n')),
      maxTokens: 1_200,
      timeoutMs: text ? 180_000 : 240_000,
    })
    plan = parseStructuredTranscriptPlan(retryText)
    structured = hasUsableStructuredPlan(plan, input.correctedTranscript)
      ? buildStructuredTranscriptFromPlan(input.title, input.correctedTranscript, plan)
      : ''
    if (structured && hasStructuredTranscriptShape(structured, input.correctedTranscript)) {
      return structured
    }

    if (!requiresStructuredSectionPlan(input.correctedTranscript)) {
      return buildFallbackStructuredTranscript(input.title, input.correctedTranscript)
    }

    throw new Error('Video Copy Analyzer 未能生成符合技能合同的结构化分段计划。')
  }

  async summarizeCopy(input: CopySummaryInput): Promise<string> {
    const skillContract = loadVideoCopySkillContract()
    const user = [
      `标题: ${input.title}`,
      `链接: ${input.link}`,
      input.source ? `来源账号: ${input.source}` : '',
      input.publishedAt ? `发布时间: ${input.publishedAt}` : '',
      input.summary ? `原始摘要: ${clipText(input.summary, 600)}` : '',
      '',
      '正文或转录文本:',
      clipText(getTranscriptPlainBody(input.extractedText), 8_000),
    ]
      .filter(Boolean)
      .join('\n')

    const system = [
      '你是视频文案分析助手，严格对齐 video-copy-analyzer 的三维分析框架。',
      '只输出 Markdown；保留事实，不虚构，不擅自重写原文内容。',
      '优先做结构化分析与优化建议，不做大段改写。',
      '必须遵循 Video Copy Analyzer SKILL.md 的三维度综合分析合同。',
    ].join('')
    const summaryPrompt = [
      `${user}`,
      '',
      'Video Copy Analyzer SKILL.md 阶段 4 合同:',
      skillContract?.analysis || '必须从 TextContent Analysis、Viral-Abstract-Script、Brainstorming 三个视角完成分析。',
      '',
      '请严格按以下标题输出（不可改名、不可缺失）：',
      '## 一、TextContent Analysis 视角',
      '- 叙事结构分析（开场/发展/高潮/转折/结尾）',
      '- 叙事声音分析（基调/节奏/金句）',
      '- 修辞手法识别（比喻/反转/呼应/隐喻）',
      '- 词库提取（关键词 8-15 个）',
      '',
      '## 二、Viral-Abstract-Script 视角',
      '- Viral-5D 诊断（Hook/Emotion/爆点/CTA/社交货币，分别 1-5 星并简评）',
      '- 风格定位（2-4 个标签）',
      '- 爆款潜力评估（完播率/互动率/转发率）',
      '- 优化建议（1-3 条，必须可执行）',
      '',
      '## 三、Brainstorming 视角',
      '- 核心价值拆解',
      '- 创意方向探索（2-3 个）',
      '- 增量验证点（2-4 个可测试项）',
      '',
      '要求：',
      '- 全文中文；',
      '- 保持原意，不做改写式重写；',
      '- 每段简洁，避免空泛套话。',
    ].join('\n')

    const text = await this.complete({
      system,
      user: summaryPrompt,
      maxTokens: 2_400,
      timeoutMs: 150_000,
    })
    if (hasCompleteCopySummaryShape(text)) return text

    const retryText = await this.complete({
      system,
      user: [
        summaryPrompt,
        '',
        text
          ? '上一次输出不完整。请重新输出一份完整报告，必须包含上述三个一级章节和每个章节下的所有条目。'
          : '上一次请求没有返回完整内容。请重新输出一份完整报告，必须包含上述三个一级章节和每个章节下的所有条目。',
      ].join('\n'),
      maxTokens: 3_200,
      timeoutMs: text ? 180_000 : 240_000,
    })
    if (hasCompleteCopySummaryShape(retryText)) return retryText

    return buildFallbackCopySummary(input)
  }

  async summarizeVisual(input: VisualSummaryInput): Promise<string> {
    const user = [
      `标题: ${input.title}`,
      `链接: ${input.link}`,
      input.source ? `来源账号: ${input.source}` : '',
      '',
      '视觉分析脚本输出：',
      clipText(input.pipelineSummary, 6_000),
    ]
      .filter(Boolean)
      .join('\n')

    const text = await this.complete({
      system:
        '你是短视频视觉分析助手。只输出 Markdown，聚焦镜头质量、叙事节奏、剪辑建议和优先改进项。',
      user:
        `${user}\n\n请输出：\n1) 综合判断\n2) 镜头质量分层(MUST KEEP/USABLE/DISCARD)\n3) 剪辑建议(按优先级)\n4) 可复用视觉模板\n5) 一段给创作者的执行清单`,
      maxTokens: 700,
    })
    if (text) return text

    return [
      '# 视觉分析总结',
      '',
      `- 标题：${input.title}`,
      `- 链接：${input.link}`,
      '',
      '## 结果',
      '- 自动总结失败，已保留脚本原始结果，请查看同目录分析文件。',
      '',
    ].join('\n')
  }

  private async complete(request: CompletionRequest): Promise<string> {
    const config = readAIConfig()
    if (!config?.apiKey || !config.baseUrl || !config.model) return ''

    const capabilities = resolveAIConfigCapabilities(config)
    const baseUrl = capabilities?.baseUrl || config.baseUrl.replace(/\/+$/, '')

    try {
      if (capabilities?.agentProtocol === 'anthropic') {
        const headers = buildAnthropicLikeHeaders(config, baseUrl)
        const resp = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            max_tokens: request.maxTokens,
            temperature: 0.2,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
          }),
          signal: AbortSignal.timeout(request.timeoutMs || 120_000),
        })
        if (!resp.ok) return ''
        const json = await resp.json()
        return extractAnthropicText(json)
      }

      const provider = capabilities?.provider || getProviderDef(config.provider, baseUrl)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      const authHeader = provider?.authHeader || 'Authorization'
      const authPrefix = provider?.authPrefix ?? 'Bearer '
      headers[authHeader] = `${authPrefix}${config.apiKey}`
      if (provider?.extraHeaders) {
        Object.assign(headers, provider.extraHeaders)
      }

      const wireApi = capabilities?.wireApi || config.wireApi || provider?.wireApi || (baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions')
      if (wireApi === 'responses') {
        const resp = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            instructions: request.system,
            reasoning: { effort: capabilities?.reasoningEffort || config.reasoningEffort || provider?.defaultReasoningEffort || 'high' },
            stream: false,
            input: [{ role: 'user', content: [{ type: 'input_text', text: request.user }] }],
            max_output_tokens: request.maxTokens,
          }),
          signal: AbortSignal.timeout(request.timeoutMs || 120_000),
        })
        if (!resp.ok) return ''
        const json = await parseJsonOrEventStreamResponse(resp)
        return extractResponsesText(json)
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          max_tokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
        signal: AbortSignal.timeout(request.timeoutMs || 120_000),
      })
      if (!resp.ok) return ''
      const json = await resp.json()
      return extractOpenAIText(json)
    } catch {
      return ''
    }
  }
}

export const rssSubagentRunner = new RSSSubagentRunner()
const settingsRepository = new AppSettingsRepository()
