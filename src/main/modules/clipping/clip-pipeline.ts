/**
 * P1.3 — 共用 clip pipeline。
 *
 * 两条入口：
 *   - `web_clip_url` tool（model-facing，`general_research` 组）
 *   - `browser:clipCurrentTab` IPC（host-IPC-only，从 BrowserView 当前 tab 抽 HTML）
 *
 * 两条入口提供各自的 HTML（Channel A：已 sanitized 的当前 tab；Channel B：
 * Jina reader 或 raw fetch），然后共享：
 *   1. 抽取（ExtractionAdapter）
 *   2. preset 选择（preset-loader）
 *   3. preset 渲染（preset-renderer）
 *   4. YAML frontmatter 序列化（serializeFrontmatter）
 *   5. 落盘到 `<outputsRoot>/obsidian-web-clip/...`（resolveReadableWithinRoot 沙箱）
 *   6. 调 `present_file`（仅 web_clip_url 路径走；IPC 路径由 renderer 直接处理）
 *
 * 失败语义统一映射到 `ClipPipelineError`，caller 再翻译成 ToolDomainError 或
 * IPC return shape。该模块 pure（不引 electron），但用 fs / path 写盘。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  PathSandboxError,
  resolveReadableWithinRoot,
} from '../tools/skill-primitives/path-sandbox'

import type { ExtractionAdapter } from './extraction-adapter'
import type { ExtractionResult } from './extraction-adapter'
import { ReadabilityJsdomAdapter } from './readability-jsdom-adapter'
import {
  loadAllPresets,
  loadPresetFile,
  PresetLoadError,
  PresetSelectionError,
  selectPreset,
} from './preset-loader'
import {
  buildRenderContext,
  renderPreset,
  sanitizeNoteFileName,
} from './preset-renderer'
import type { ClipPreset } from './preset-types'

export type ClipErrorKind =
  | 'clip_fetch_failed'
  | 'clip_parse_failed'
  | 'clip_preset_render_failed'
  | 'clip_login_required'
  | 'clip_write_blocked'
  | 'clip_active_tab_unstable'

export interface ClipPipelineErrorDetail {
  reason?:
    | 'requires_interpreter'
    | 'preset_not_found'
    | 'no_default_preset'
    | 'template_evaluation_failed'
    | 'path_outside_outputs'
    | 'extraction_empty'
    | 'extraction_threw'
    | 'http_status'
    | 'login_wall'
  preset?: string | null
  status?: number
  message?: string
}

export class ClipPipelineError extends Error {
  constructor(
    public readonly kind: ClipErrorKind,
    public readonly recoverable: boolean,
    public readonly detail: ClipPipelineErrorDetail,
    message: string,
  ) {
    super(message)
    this.name = 'ClipPipelineError'
  }
}

export interface ClipPipelineInput {
  html: string
  /** Final URL after redirects; preserved into frontmatter. */
  url: string
  /** Optional inline override (e.g. when caller already extracted title). */
  inlineTitle?: string
  /** True when caller already stripped PII (current-tab path). */
  sanitized?: boolean
  /** Optional already-extracted markdown (Channel B Jina path). When present
   * extractor still runs on raw HTML — Jina markdown only serves as a
   * fallback/baseline when extractor confidence is low. */
  jinaMarkdown?: string
}

export interface ClipPipelineOptions {
  /** Where the embedded skill's preset directory lives. */
  presetDir: string
  /** Optional explicit preset file path (absolute). */
  presetFile?: string | null
  /** Preset name (file basename without extension) or "auto". */
  preset?: string | null
  /** Sub-directory under `<outputsRoot>/obsidian-web-clip/`. Overrides preset.path when set. */
  outputSubdir?: string | null
  /** Skip preset.path subdirectories — write directly into outputsRoot/obsidian-web-clip. */
  flattenPath?: boolean
  /** Allow rendering interpreter-required presets with literal placeholders. */
  forceRenderWithPlaceholders?: boolean
  /** outputsRoot for path sandbox; see §6.25-8. */
  outputsRoot: string
  /** Adapter injection for tests. */
  adapter?: ExtractionAdapter
}

export interface ClipPipelineResult {
  savedPath: string
  /** Relative to outputsRoot for caller's structured output. */
  savedPathRelative: string
  /** Suggested vault-relative path: same as preset.path-resolved subdir + filename. */
  suggestedVaultRelativePath: string
  preset: { id: string; name: string }
  frontmatter: Record<string, string | string[]>
  title: string
  url: string
  warnings: string[]
}

const CLIP_ROOT_SUBDIR = 'obsidian-web-clip'

/**
 * Shared core. Caller supplies HTML; pipeline does extract + render + write.
 */
export async function runClipPipeline(
  input: ClipPipelineInput,
  options: ClipPipelineOptions,
): Promise<ClipPipelineResult> {
  const hasHtml = input.html && input.html.trim().length > 0
  const hasJinaMarkdown = input.jinaMarkdown && input.jinaMarkdown.trim().length > 0
  if (!hasHtml && !hasJinaMarkdown) {
    throw new ClipPipelineError('clip_parse_failed', false, { reason: 'extraction_empty' }, 'Empty HTML body')
  }
  if (!options.outputsRoot || options.outputsRoot.trim().length === 0) {
    throw new ClipPipelineError(
      'clip_write_blocked',
      false,
      { reason: 'path_outside_outputs', message: 'outputsRoot is not configured' },
      'outputsRoot is required',
    )
  }

  const adapter = options.adapter || new ReadabilityJsdomAdapter()

  let extracted: ExtractionResult
  const cleanedJinaMarkdown = cleanJinaReaderMarkdown(
    input.jinaMarkdown || '',
    input.url,
    input.inlineTitle || extractJinaMarkdownTitle(input.jinaMarkdown || ''),
  )

  if (hasHtml) {
    try {
      extracted = await adapter.extract({ html: input.html, url: input.url, sanitized: input.sanitized })
    } catch (err) {
      throw new ClipPipelineError(
        'clip_parse_failed',
        false,
        { reason: 'extraction_threw', message: (err as Error).message },
        `Extraction failed: ${(err as Error).message}`,
      )
    }
  } else {
    extracted = buildJinaOnlyExtraction(input.jinaMarkdown || '', cleanedJinaMarkdown, input.inlineTitle || input.url, input.url)
  }

  if (!extracted.contentMarkdown && !input.jinaMarkdown) {
    throw new ClipPipelineError(
      'clip_parse_failed',
      false,
      { reason: 'extraction_empty' },
      'Extraction returned no markdown content',
    )
  }
  // Channel A (readability) sees the raw HTTP fetch — no JS — and our
  // unseal-template + data-runner-src promotion + reconciliation recovers
  // most lazy-loaded gallery images. Channel B (Jina r.jina.ai) renders
  // with a headless browser but its output often contains `blob:` /
  // `data:` image refs that are NOT accessible outside the source page
  // (RebelMouse galleries are the canonical offender). Sanitize both
  // before comparing so the picker only sees fetchable image refs.
  const sanitizedReadability = sanitizeUnfetchableImageRefs(extracted.contentMarkdown || '')
  const sanitizedJina = sanitizeUnfetchableImageRefs(cleanedJinaMarkdown)
  const contentMarkdown = pickRicherMarkdown(sanitizedReadability, sanitizedJina)
  const title = input.inlineTitle?.trim() || extracted.title

  let preset: ClipPreset
  try {
    if (options.presetFile) {
      preset = loadPresetFile(options.presetFile)
      if (preset.requiresInterpreter && !options.forceRenderWithPlaceholders) {
        throw new PresetSelectionError(
          'requires_interpreter',
          preset.fileId,
          `Preset ${preset.fileId} contains LLM placeholders; Phase 1 has no interpreter.`,
        )
      }
    } else {
      const all = loadAllPresets(options.presetDir)
      preset = selectPreset(all, {
        explicitName: options.preset || 'auto',
        pageUrl: input.url,
        allowInterpreterRequired: Boolean(options.forceRenderWithPlaceholders),
      })
    }
  } catch (err) {
    if (err instanceof PresetSelectionError) {
      throw new ClipPipelineError(
        'clip_preset_render_failed',
        false,
        { reason: err.reason, preset: err.presetId },
        err.message,
      )
    }
    if (err instanceof PresetLoadError) {
      throw new ClipPipelineError(
        'clip_preset_render_failed',
        false,
        { reason: 'template_evaluation_failed', message: err.message },
        err.message,
      )
    }
    throw err
  }

  const context = buildRenderContext({
    contentMarkdown,
    title,
    url: input.url,
    metadata: extracted.metadata,
    structuredData: extracted.structuredData,
    metaLookup: extracted.metaLookup,
  })

  let rendered
  try {
    rendered = renderPreset(preset, context, {
      flattenPath: Boolean(options.flattenPath),
      forcePlaceholderLiteral: Boolean(options.forceRenderWithPlaceholders),
    })
  } catch (err) {
    throw new ClipPipelineError(
      'clip_preset_render_failed',
      false,
      { reason: 'template_evaluation_failed', preset: preset.fileId, message: (err as Error).message },
      `Preset render failed: ${(err as Error).message}`,
    )
  }

  if (rendered.usedPlaceholderLiteral && options.forceRenderWithPlaceholders) {
    rendered.frontmatter.warning = 'rendered with placeholders (LLM interpreter pending Phase 2)'
  }

  const subdirSegments = options.outputSubdir
    ? options.outputSubdir
        .split(/[\\/]+/)
        .map((s) => sanitizeNoteFileName(s))
        .filter(Boolean)
    : rendered.subdirSegments

  const noteFileName = `${sanitizeNoteFileName(rendered.noteName)}.md`
  const relativePath = [CLIP_ROOT_SUBDIR, ...subdirSegments, noteFileName].join('/')

  let resolvedPath: string
  try {
    // Resolve absolute target through path-sandbox: outputsRoot must canonically
    // contain the resolved file. The dir is created lazily by mkdirSync below;
    // resolveReadableWithinRoot validates path-traversal / symlink-escape.
    resolvedPath = resolveReadableWithinRoot(options.outputsRoot, resolve(options.outputsRoot, relativePath))
  } catch (err) {
    if (err instanceof PathSandboxError) {
      throw new ClipPipelineError(
        'clip_write_blocked',
        false,
        { reason: 'path_outside_outputs', message: err.message },
        err.message,
      )
    }
    throw err
  }

  const targetDir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) || resolvedPath.substring(0, resolvedPath.lastIndexOf('\\'))
  mkdirSync(targetDir, { recursive: true })

  const fileContent = `${serializeFrontmatter(rendered.frontmatter)}\n\n${rendered.noteBody}\n`
  writeFileSync(resolvedPath, fileContent, 'utf8')

  const warnings = [...extracted.diagnostics.warnings]
  if (rendered.usedPlaceholderLiteral && !options.forceRenderWithPlaceholders) {
    warnings.push('preset_placeholder_silent_fallback_used')
  }
  if (extracted.diagnostics.confidence < 0.4) {
    warnings.push('low_extraction_confidence')
  }

  return {
    savedPath: resolvedPath,
    savedPathRelative: relativePath,
    suggestedVaultRelativePath: [...subdirSegments, noteFileName].join('/'),
    preset: { id: preset.fileId, name: preset.name },
    frontmatter: rendered.frontmatter,
    title,
    url: input.url,
    warnings,
  }
}

const IMG_MARKDOWN_COUNT_RE = /!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g
const IMG_MARKDOWN_ANY_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const UNFETCHABLE_SCHEME_RE = /^(?:blob|data|javascript|about|chrome|file|filesystem):/i
const LINKED_IMAGE_RE = /\[!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g
const HTTP_IMAGE_EXT_RE = /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i
const JINA_HEADER_RE = /^(?:Title|URL Source|Published Time|Markdown Content):\s*/i
const FOOTER_START_RE =
  /^(?:#{1,6}\s*)?(?:related posts|leave a reply|subscribe|sign in or register|welcome back|register now|notifications|topic|place|type|about|znetwork is funded solely|submit$|type above and press|all the latest from)/i
const BOILERPLATE_LABEL_RE =
  /^(?:close menu|donate|login|log in|register|register now|lost password\?|remember me|save my name|support our work|subscribe|cancel reply|home\s*»|submit|notifications)$/i
const SHARE_URL_RE = /(?:facebook\.com\/sharer|twitter\.com\/intent|reddit\.com\/submit|bsky\.app\/intent|mailto:|discord\.gg|rss-feeds)/i

function buildJinaOnlyExtraction(
  markdown: string,
  cleanedMarkdown: string,
  fallbackTitle: string,
  sourceUrl: string,
): ExtractionResult {
  const title = extractJinaMarkdownTitle(markdown) || fallbackTitle
  const words = cleanedMarkdown.trim().split(/\s+/).filter(Boolean).length
  return {
    title,
    contentMarkdown: cleanedMarkdown,
    metadata: {
      published: extractJinaPublishedTime(markdown) || undefined,
      site: siteFromUrl(sourceUrl) || undefined,
      wordCount: words,
    },
    structuredData: [],
    metaLookup: {},
    diagnostics: {
      extractionSource: 'jina',
      confidence: 0.7,
      warnings: ['raw_html_unavailable_jina_fallback'],
    },
  }
}

function extractJinaMarkdownTitle(markdown: string): string {
  const titleMatch = /^Title:\s*(.+)$/mi.exec(markdown)
  if (titleMatch?.[1]?.trim()) return titleMatch[1].trim()
  const headingMatch = /^#\s+(.+)$/m.exec(markdown)
  return headingMatch?.[1]?.trim() || ''
}

function extractJinaPublishedTime(markdown: string): string {
  const match = /^Published Time:\s*(.+)$/mi.exec(markdown)
  return match?.[1]?.trim() || ''
}

function siteFromUrl(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function cleanJinaReaderMarkdown(markdown: string, sourceUrl?: string, titleHint?: string): string {
  const raw = (markdown || '').replace(/\r\n/g, '\n')
  if (!raw.trim()) return ''

  const body = stripJinaReaderEnvelope(raw)
  const title = titleHint?.trim() || extractJinaMarkdownTitle(raw)
  const imageCleaned = normalizeJinaImageRefs(body, sourceUrl)
  let blocks = splitMarkdownBlocks(imageCleaned).filter((block) => !JINA_HEADER_RE.test(block.trim()))
  blocks = trimBlocksToArticleStart(blocks, title, sourceUrl)
  blocks = trimBlocksBeforeFooter(blocks)
  blocks = blocks.filter((block) => !isJinaBoilerplateBlock(block, sourceUrl))
  blocks = dedupeSimilarBlocks(blocks)

  return normalizeMarkdownSpacing(blocks.join('\n\n'))
}

function stripJinaReaderEnvelope(markdown: string): string {
  const marker = /^Markdown Content:\s*$/im.exec(markdown)
  if (marker) return markdown.slice((marker.index ?? 0) + marker[0].length).trim()
  return markdown
    .split('\n')
    .filter((line) => !JINA_HEADER_RE.test(line.trim()))
    .join('\n')
    .trim()
}

function splitMarkdownBlocks(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
}

function trimBlocksToArticleStart(blocks: string[], title: string, sourceUrl?: string): string[] {
  if (blocks.length === 0 || !title.trim()) return blocks
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => isTitleHeadingBlock(block, title))
  if (candidates.length === 0) return blocks

  let best = candidates[0]
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of candidates) {
    const score = scoreArticleStartCandidate(blocks, candidate.index, sourceUrl)
    if (score >= bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return blocks.slice(best.index)
}

function isTitleHeadingBlock(block: string, title: string): boolean {
  const match = /^(#{1,3})\s+(.+)$/m.exec(block.trim())
  if (!match?.[2]) return false
  const heading = normalizeTitleText(match[2])
  const expected = normalizeTitleText(title)
  if (!heading || !expected) return false
  return heading === expected || heading.includes(expected) || expected.includes(heading)
}

function scoreArticleStartCandidate(blocks: string[], index: number, sourceUrl?: string): number {
  let score = index * 0.01
  for (const block of blocks.slice(index + 1, index + 8)) {
    if (isJinaBoilerplateBlock(block, sourceUrl)) score -= 3
    if (isContentImageBlock(block, sourceUrl)) score += 2
    if (looksLikeArticleProse(block)) score += 3
    if (markdownLinkCount(block) >= 4) score -= 1
  }
  return score
}

function normalizeTitleText(value: string): string {
  return stripMarkdown(value)
    .replace(/\s+-\s+[a-z0-9 ._-]{2,40}$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function trimBlocksBeforeFooter(blocks: string[]): string[] {
  const index = blocks.findIndex((block) => FOOTER_START_RE.test(stripMarkdown(block).trim()))
  if (index < 0) return blocks
  return blocks.slice(0, index)
}

function dedupeSimilarBlocks(blocks: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const block of blocks) {
    if (IMG_MARKDOWN_ANY_RE.test(block)) {
      IMG_MARKDOWN_ANY_RE.lastIndex = 0
      out.push(block)
      continue
    }
    IMG_MARKDOWN_ANY_RE.lastIndex = 0
    const key = stripMarkdown(block)
      .replace(/\bhttps?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(block)
  }
  return out
}

function normalizeJinaImageRefs(markdown: string, sourceUrl?: string): string {
  return markdown
    .replace(LINKED_IMAGE_RE, (_whole, rawAlt: string, imageUrl: string, trailingText: string, targetUrl: string) => {
      if (shouldDropJinaImage(rawAlt, imageUrl, sourceUrl, trailingText)) return ''
      const bestUrl = isLikelyContentImageUrl(targetUrl, sourceUrl) ? targetUrl : imageUrl
      return `![${cleanJinaImageAlt(rawAlt)}](${bestUrl})`
    })
    .replace(IMG_MARKDOWN_ANY_RE, (whole, rawAlt: string, url: string) => {
      if (!/^https?:\/\//i.test(url)) return whole
      if (shouldDropJinaImage(rawAlt, url, sourceUrl, '')) return ''
      return `![${cleanJinaImageAlt(rawAlt)}](${url})`
    })
}

function shouldDropJinaImage(rawAlt: string, imageUrl: string, sourceUrl?: string, trailingText?: string): boolean {
  const alt = (rawAlt || '').trim()
  const visibleText = `${alt} ${trailingText || ''}`.trim()
  if (!isLikelyContentImageUrl(imageUrl, sourceUrl)) return true
  if (/cdn\.gtranslate\.net\/flags/i.test(imageUrl)) return true
  if (/\/(?:flags|logo|favicon|icon)\b/i.test(imageUrl)) return true
  if (/z_logo|\/logo\.(?:png|jpe?g|svg|webp)$/i.test(imageUrl)) return true
  if (/^image\s+\d+:\s*[a-z]{2}(?:-[a-z]{2})?$/i.test(alt)) return true
  if (/^image\s+\d+/i.test(alt) && /^[A-Z][a-z]+(?: \([^)]+\))?$/.test(visibleText)) return true
  return false
}

function isLikelyContentImageUrl(rawUrl: string, sourceUrl?: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (sourceUrl) {
      const source = new URL(sourceUrl)
      if (parsed.origin === source.origin && normalizeUrlPath(parsed.pathname) === normalizeUrlPath(source.pathname)) {
        return false
      }
    }
    return HTTP_IMAGE_EXT_RE.test(parsed.pathname) || /\/wp-content\/uploads\//i.test(parsed.pathname)
  } catch {
    return false
  }
}

function normalizeUrlPath(pathname: string): string {
  return pathname.replace(/\/+$/, '').toLowerCase()
}

function cleanJinaImageAlt(rawAlt: string): string {
  const alt = (rawAlt || '').trim().replace(/^image\s+\d+:\s*/i, '').trim()
  if (/^image\s+\d+$/i.test(alt)) return ''
  return alt
}

function isJinaBoilerplateBlock(block: string, sourceUrl?: string): boolean {
  const trimmed = block.trim()
  if (isContentImageBlock(trimmed, sourceUrl)) return false
  const text = stripMarkdown(trimmed).trim()
  if (!text) return true
  if (BOILERPLATE_LABEL_RE.test(text)) return true
  if (SHARE_URL_RE.test(trimmed) && markdownLinkCount(trimmed) >= 1) return true
  if (/cdn\.gtranslate\.net\/flags|English▼/i.test(trimmed)) return true
  if (imageMarkdownCount(trimmed) >= 4 && markdownLinkCount(trimmed) >= 4) return true
  if (/switch to (?:dark|light) design|search$/i.test(text) && markdownLinkCount(trimmed) >= 1) return true
  if (/^Home\s*»/i.test(text)) return true
  if (sourceUrl && isSourceOnlyLinkBlock(trimmed, sourceUrl)) return true

  const links = markdownLinkCount(trimmed)
  if (links >= 3) {
    const textWithoutLinks = stripMarkdownLinks(trimmed).replace(/\s+/g, ' ').trim()
    if (textWithoutLinks.length <= 90) return true
  }
  return false
}

function isSourceOnlyLinkBlock(block: string, sourceUrl: string): boolean {
  try {
    const source = new URL(sourceUrl)
    const links = Array.from(block.matchAll(/\]\((https?:\/\/[^)\s]+)/g)).map((match) => new URL(match[1]))
    if (links.length === 0) return false
    return links.every((link) => link.origin === source.origin && normalizeUrlPath(link.pathname) === normalizeUrlPath(source.pathname))
  } catch {
    return false
  }
}

function isContentImageBlock(block: string, sourceUrl?: string): boolean {
  const match = IMG_MARKDOWN_ANY_RE.exec(block)
  IMG_MARKDOWN_ANY_RE.lastIndex = 0
  if (!match?.[2]) return false
  return isLikelyContentImageUrl(match[2], sourceUrl)
}

function looksLikeArticleProse(block: string): boolean {
  if (markdownLinkCount(block) >= 4) return false
  const text = stripMarkdown(block).trim()
  if (text.length < 80) return false
  return /[.!?。！？]"?$/.test(text) || text.includes(',') || text.includes('，')
}

function markdownLinkCount(block: string): number {
  return (block.match(/\]\(/g) || []).length
}

function imageMarkdownCount(block: string): number {
  return (block.match(/!\[/g) || []).length
}

function stripMarkdownLinks(markdown: string): string {
  return markdown.replace(/!?\[[^\]]*\]\([^)]*\)/g, '').trim()
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
}

function normalizeMarkdownSpacing(markdown: string): string {
  return markdown
    .replace(/([A-Za-z0-9)])\[/g, '$1 [')
    .replace(/\]\(([^)]+)\)(?=[A-Za-z])/g, ']($1) ')
    .replace(/\)\s*(May|June|July|August|September|October|November|December|January|February|March|April)\b/g, '), $1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Replace `![alt](blob:...)` / `![alt](data:...)` / `![alt](javascript:...)`
 * — and any other non-network scheme — with a plain inline fallback so the
 * downstream picker doesn't reward Jina for "having images" when those
 * images are headless-browser internal blob URLs we can't actually fetch.
 *
 * Format: `[alt 文本]` when alt exists, otherwise drop the ref entirely.
 * This keeps prose readable without leaving broken `![]()` placeholders.
 */
export function sanitizeUnfetchableImageRefs(markdown: string): string {
  if (!markdown) return ''
  return markdown.replace(IMG_MARKDOWN_ANY_RE, (whole, alt: string, url: string) => {
    if (!UNFETCHABLE_SCHEME_RE.test(url)) return whole
    const trimmedAlt = (alt || '').trim()
    if (!trimmedAlt || /^image\s*\d*$/i.test(trimmedAlt)) return ''
    return `_${trimmedAlt}_`
  })
}

export function pickRicherMarkdown(
  readabilityMarkdown: string | undefined,
  jinaMarkdown: string | undefined,
): string {
  const readability = (readabilityMarkdown || '').trim()
  const jina = (jinaMarkdown || '').trim()
  if (!readability) return jina
  if (!jina) return readability

  const readImageCount = (readability.match(IMG_MARKDOWN_COUNT_RE) || []).length
  const jinaImageCount = (jina.match(IMG_MARKDOWN_COUNT_RE) || []).length

  // Hard preference: when readability has 5+ real (http(s)) image refs, our
  // local extraction + reconciliation has already done the gallery recovery
  // job — taking Jina would replace clean prose with its full-page dump
  // (nav menu, breadcrumbs, footer). Only allow Jina to win here if it has
  // a dramatically larger image count (≥ readability × 2).
  if (readImageCount >= 5 && jinaImageCount < readImageCount * 2) {
    return readability
  }

  // Standard signals.
  if (jinaImageCount >= readImageCount + 2) return jina
  if (readImageCount >= jinaImageCount + 2) return readability

  // Length tiebreaker, but only when neither side has a meaningful image
  // count. Jina is typically 3–6x the size of a readability article because
  // it includes site nav; we don't want to swap good readability prose for
  // that bulk just because Jina dumped more bytes.
  if (readImageCount === 0 && jinaImageCount === 0 && jina.length > readability.length * 2) {
    return jina
  }
  return readability
}

function serializeFrontmatter(frontmatter: Record<string, string | string[]>): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${JSON.stringify(String(item))}`)
    } else {
      const text = String(value).trim()
      if (!text) continue
      lines.push(`${key}: ${JSON.stringify(text)}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * Resolve embedded skill preset dir from a runtime info object. Falls back to
 * a heuristic path under app resources when not provided.
 *
 * Pure module — caller must supply the actual managed path (resolved from
 * `SkillsRuntimeManager` or test fixture). Default join is just a sentinel.
 */
export function resolveEmbeddedPresetDir(skillsManagedPath: string): string {
  if (!skillsManagedPath) return ''
  return join(skillsManagedPath, 'obsidian-web-clip', 'assets', 'presets')
}
