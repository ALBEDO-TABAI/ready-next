/**
 * P1.7 — Preset 模板引擎。
 *
 * 支持表达式：
 *   {{variable}}                         — 直接变量
 *   {{meta:name:keywords}}               — meta lookup
 *   {{schema:@VideoObject:embedUrl}}     — JSON-LD lookup
 *   {{var|filter1|filter2:"arg"}}        — pipeline filter
 *
 * Phase 1 ships 5 filters：split / first / last / replace / date。
 * Phase 2 把官方 ~50 个 filter 全套迁过来（计划 P2.2）。
 *
 * LLM 占位 {{"..."}} / {{prompt:"..."}} 的处理：
 *   - 默认 `forcePlaceholderLiteral = false` ⇒ 走老的启发式 fallback（按字段名命中
 *     title/author/tag/description 等热路径）— **仅供 force_render_with_placeholders=true
 *     时使用**。preset-loader 已经把 requiresInterpreter preset 拦在外面了，所以
 *     正常路径不会进入 fallback。
 *   - `forcePlaceholderLiteral = true` ⇒ 渲染为 `[placeholder: "<原始指令>"]`，并设
 *     `result.usedPlaceholderLiteral = true`，pipeline 据此往 frontmatter 加 warning。
 */

import type { ClipPreset, PresetProperty } from './preset-types'

export interface RenderVariables {
  content: string
  title: string
  noteName: string
  url: string
  time: string
  author: string
  published: string
  description: string
  site: string
  image: string
  tags: string[]
}

export interface RenderContext {
  variables: RenderVariables
  structuredData: Record<string, unknown>[]
  metaLookup: Record<string, string>
}

export interface RenderOutput {
  frontmatter: Record<string, string | string[]>
  noteBody: string
  noteName: string
  subdirSegments: string[]
  usedPlaceholderLiteral: boolean
}

export function buildRenderContext(input: {
  contentMarkdown: string
  title: string
  url: string
  metadata: {
    author?: string
    published?: string
    description?: string
    image?: string
    site?: string
  }
  structuredData: Record<string, unknown>[]
  metaLookup: Record<string, string>
  tags?: string[]
}): RenderContext {
  const tags = input.tags
    ? input.tags
    : parseKeywords(input.metaLookup['name:keywords'] || input.metaLookup['property:article:tag'] || '')
  return {
    variables: {
      content: input.contentMarkdown,
      title: input.title,
      noteName: input.title,
      url: input.url,
      time: new Date().toISOString(),
      author: input.metadata.author || '',
      published: input.metadata.published || '',
      description: input.metadata.description || '',
      site: input.metadata.site || '',
      image: input.metadata.image || '',
      tags,
    },
    structuredData: input.structuredData,
    metaLookup: input.metaLookup,
  }
}

export function renderPreset(
  preset: ClipPreset,
  context: RenderContext,
  options: { flattenPath: boolean; forcePlaceholderLiteral: boolean },
): RenderOutput {
  const state = { usedPlaceholderLiteral: false }

  const frontmatter: Record<string, string | string[]> = {}
  for (const property of preset.properties) {
    const rendered = renderTemplate(property.value, context, property.name, state, options)
    if (property.type === 'multitext') {
      const values = normalizeMultitext(rendered, property.name, context)
      if (values.length > 0) frontmatter[property.name] = values
      continue
    }
    const value = stringifyValue(rendered).trim()
    if (value) frontmatter[property.name] = value
  }

  if (!frontmatter.title && context.variables.title) {
    frontmatter.title = context.variables.title
  }
  if (!frontmatter.url) {
    frontmatter.url = context.variables.url
  }

  const noteBody = stringifyValue(renderTemplate(preset.noteContentFormat || '{{content}}', context, 'noteContentFormat', state, options)).trim()
  const noteName = stringifyValue(renderTemplate(preset.noteNameFormat || '{{title}}', context, 'noteName', state, options)).trim() || context.variables.title || 'untitled'

  const subdirSegments = options.flattenPath
    ? []
    : segmentizePath(stringifyValue(renderTemplate(preset.path || '', context, 'path', state, options)))

  return {
    frontmatter,
    noteBody: noteBody || context.variables.content,
    noteName,
    subdirSegments,
    usedPlaceholderLiteral: state.usedPlaceholderLiteral,
  }
}

function renderTemplate(
  template: string,
  context: RenderContext,
  fieldName: string,
  state: { usedPlaceholderLiteral: boolean },
  options: { forcePlaceholderLiteral: boolean },
): unknown {
  const source = typeof template === 'string' ? template : ''
  return source.replace(/\{\{(.*?)\}\}/gs, (_, expression: string) => {
    const value = evaluateExpression(expression, context, fieldName, state, options)
    return stringifyValue(value)
  })
}

function evaluateExpression(
  expression: string,
  context: RenderContext,
  fieldName: string,
  state: { usedPlaceholderLiteral: boolean },
  options: { forcePlaceholderLiteral: boolean },
): unknown {
  const normalized = normalizeExpressionText(expression)
  const parts = normalized.split('|').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  let value: unknown = resolveBase(parts[0], context, fieldName, state, options)
  for (const filter of parts.slice(1)) {
    value = applyFilter(value, filter)
  }
  return value
}

function resolveBase(
  base: string,
  context: RenderContext,
  fieldName: string,
  state: { usedPlaceholderLiteral: boolean },
  options: { forcePlaceholderLiteral: boolean },
): unknown {
  const normalized = base.trim()
  const literal = parseQuotedLiteral(normalized)
  if (literal !== null) {
    if (options.forcePlaceholderLiteral) {
      state.usedPlaceholderLiteral = true
      return `[placeholder: ${JSON.stringify(literal)}]`
    }
    state.usedPlaceholderLiteral = true
    return fallbackForPromptLiteral(context, fieldName)
  }
  if (normalized.startsWith('meta:')) {
    const [, metaKind, ...rest] = normalized.split(':')
    const key = `${metaKind.toLowerCase()}:${rest.join(':').toLowerCase()}`
    return context.metaLookup[key] || ''
  }
  if (normalized.startsWith('schema:')) {
    const tail = normalized.slice('schema:'.length)
    if (tail.startsWith('@')) {
      const separator = tail.indexOf(':')
      const typeName = tail.slice(1, separator === -1 ? undefined : separator)
      const propertyPath = separator === -1 ? '' : tail.slice(separator + 1)
      const value = getSchemaValues(context.structuredData, typeName, propertyPath)
      if (value.length > 0) return value
      return deriveSchemaFallback(typeName, propertyPath, context)
    }
    const value = getSchemaValues(context.structuredData, null, tail)
    if (value.length > 0) return value
    return deriveSchemaFallback(null, tail, context)
  }
  const variables = context.variables as unknown as Record<string, unknown>
  if (normalized in variables) {
    return variables[normalized]
  }
  return ''
}

function parseQuotedLiteral(value: string): string | null {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")
  }
  return null
}

function normalizeExpressionText(expression: string): string {
  return String(expression)
    .replace(/\\\\+"/g, '"')
    .replace(/\\"/g, '"')
    .replace(/\\\\+'/g, "'")
    .replace(/\\'/g, "'")
}

function fallbackForPromptLiteral(context: RenderContext, fieldName: string): unknown {
  const normalized = String(fieldName || '').toLowerCase()
  if (normalized.includes('title') || normalized.includes('name')) return context.variables.title || ''
  if (normalized.includes('author')) return context.variables.author || ''
  if (normalized.includes('tag')) return context.variables.tags
  if (normalized.includes('description')) return context.variables.description || ''
  return ''
}

function deriveSchemaFallback(
  typeName: string | null,
  propertyPath: string,
  context: RenderContext,
): unknown {
  const ty = String(typeName || '').toLowerCase()
  const path = String(propertyPath || '').toLowerCase()
  const v = context.variables
  if (ty === 'videoobject') {
    if (path === 'name') return v.title || ''
    if (path === 'description') return v.description || ''
    if (path === 'thumbnailurl') return v.image || ''
    if (path === 'uploaddate') return v.published || ''
    if (path === 'author') return v.author || ''
    if (path === 'embedurl') return deriveEmbedUrl(v.url)
  }
  if (path === 'image.url') return v.image || ''
  return ''
}

function deriveEmbedUrl(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl)
    if (parsed.hostname.includes('youtube.com') && parsed.searchParams.has('v')) {
      return `https://www.youtube.com/embed/${parsed.searchParams.get('v')}`
    }
    if (parsed.hostname === 'youtu.be') {
      const videoId = parsed.pathname.replace(/^\/+/, '')
      return videoId ? `https://www.youtube.com/embed/${videoId}` : pageUrl
    }
    return pageUrl
  } catch {
    return pageUrl
  }
}

function applyFilter(value: unknown, filterExpression: string): unknown {
  const [name, rawArgs = ''] = filterExpression.split(/:(.+)/s)
  const filterName = name.trim().toLowerCase()
  switch (filterName) {
    case 'first':
      return Array.isArray(value) ? value[0] || '' : firstFromString(value)
    case 'last':
      return Array.isArray(value) ? value.at(-1) || '' : lastFromString(value)
    case 'split': {
      const [delimiter = ''] = extractQuotedArgs(rawArgs)
      return String(stringifyValue(value)).split(delimiter)
    }
    case 'replace': {
      const args = extractQuotedArgs(rawArgs)
      let output = stringifyValue(value)
      for (let i = 0; i < args.length; i += 2) {
        const search = args[i] ?? ''
        const replacement = args[i + 1] ?? ''
        output = output.split(search).join(replacement)
      }
      return output
    }
    case 'date': {
      const [format = 'YYYY-MM-DD'] = extractQuotedArgs(rawArgs)
      return formatDate(value, format)
    }
    default:
      return value
  }
}

function extractQuotedArgs(rawArgs: string): string[] {
  const matches = [...String(rawArgs).matchAll(/"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/g)]
  return matches.map((match) => (match[1] ?? match[2] ?? '').replace(/\\"/g, '"').replace(/\\'/g, "'"))
}

function firstFromString(value: unknown): string {
  const items = String(value).split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)
  return items[0] || ''
}

function lastFromString(value: unknown): string {
  const items = String(value).split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)
  return items.at(-1) || ''
}

function formatDate(input: unknown, format: string): string {
  const candidate = Array.isArray(input) ? input[0] : input
  const date = new Date(candidate as string)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return format
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/DD/g, pad(date.getDate()))
    .replace(/HH/g, pad(date.getHours()))
    .replace(/mm/g, pad(date.getMinutes()))
    .replace(/ss/g, pad(date.getSeconds()))
    .replace(/Z/g, zone)
}

function getSchemaValues(
  schemaItems: Record<string, unknown>[],
  typeName: string | null,
  propertyPath: string,
): string[] {
  const out: string[] = []
  for (const item of schemaItems) {
    const types = Array.isArray(item['@type']) ? (item['@type'] as unknown[]) : [item['@type']]
    if (typeName) {
      const matched = types.some((t) => String(t).toLowerCase() === typeName.toLowerCase())
      if (!matched) continue
    }
    const value = getDeepValue(item, propertyPath)
    if (value !== undefined && value !== null && value !== '') flattenAndPush(value, out)
  }
  return out
}

function getDeepValue(target: unknown, propertyPath: string): unknown {
  if (!propertyPath) return target
  let current: unknown = target
  for (const key of propertyPath.split('.')) {
    if (current === undefined || current === null) return undefined
    if (Array.isArray(current)) {
      current = current.map((item) => getDeepValue(item, key)).filter((item) => item !== undefined)
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

function flattenAndPush(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenAndPush(item, output)
  } else if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>
    if (typeof r.name === 'string' && r.name.trim()) output.push(r.name.trim())
    else if (typeof r['@id'] === 'string' && (r['@id'] as string).trim()) output.push((r['@id'] as string).trim())
    else if (typeof r.url === 'string' && r.url.trim()) output.push(r.url.trim())
  } else if (typeof value === 'string' && value.trim()) {
    output.push(value.trim())
  } else if (typeof value === 'number') {
    output.push(String(value))
  }
}

function parseKeywords(raw: string): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean))]
}

function normalizeMultitext(value: unknown, fieldName: string, context: RenderContext): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (fieldName.toLowerCase().includes('tag') && context.variables.tags.length > 0) return context.variables.tags
  const raw = String(value || '').trim()
  if (!raw) return []
  const hashMatches = raw.match(/#[^\s#,;]+/g)
  if (hashMatches?.length) return [...new Set(hashMatches)]
  return [...new Set(raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))]
}

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return value == null ? '' : String(value)
}

function segmentizePath(relativePath: string): string[] {
  return String(relativePath || '')
    .split(/[\\/]+/)
    .map((segment) => sanitizeFileNameSegment(segment))
    .filter(Boolean)
}

// Characters that produce broken markdown image refs / filesystem paths.
// Each replace step is unambiguous so a future invisible-control-char paste
// can't quietly disable the rule (the original character-class regex was
// silently corrupted with a U+0000–U+001F range that excluded both space
// and dash, leaving file names untouched and producing markdown image refs
// that broke on the first space when previewed in strict parsers).
// Explicit ranges so an invisible-control-char paste can't quietly disable
// a rule. U+0000–U+001F + DEL are filesystem-illegal on every OS we ship to;
// the rest are the Win32 reserved set.
const CONTROL_CHAR_CLASS = ['\\u0000', '-\\u001f', '\\u007f'].join('')
const FS_ILLEGAL_CHARS_RE = new RegExp(`[${CONTROL_CHAR_CLASS}<>:"/\\\\|?*]`, 'g')
const ANY_WHITESPACE_RE = /\s+/g
const COLLAPSE_DASHES_RE = /-{2,}/g
const TRIM_DASHES_RE = /^-+|-+$/g
const TRAILING_DOTS_RE = /\.+$/g

export function sanitizeFileNameSegment(name: string): string {
  const cleaned = String(name || '')
    .replace(FS_ILLEGAL_CHARS_RE, '-')
    .replace(ANY_WHITESPACE_RE, '-')
    .replace(COLLAPSE_DASHES_RE, '-')
    .replace(TRIM_DASHES_RE, '')
    .replace(TRAILING_DOTS_RE, '')
  return cleaned.slice(0, 160)
}

export function sanitizeNoteFileName(name: string): string {
  return sanitizeFileNameSegment(name) || `clip-${Date.now()}`
}
