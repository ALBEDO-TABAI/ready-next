const CODE_FENCE_REGEX = /```[\w-]*\s*\n?[\s\S]*?\n?```/g
const MERMAID_FENCE_REGEX = /```mermaid[^\n]*\n([\s\S]*?)```/gi
const SHOW_WIDGET_FENCE_REGEX = /```show-widget\s*\n?([\s\S]*?)(?:\n?\s*```|$)/gi

export type DocumentVisualSyntaxIssueKind =
  | 'widget_empty'
  | 'widget_json_invalid'
  | 'widget_svg_unclosed'
  | 'widget_boundary_violation'
  | 'malformed_mermaid_static'
  | 'exposed_mermaid_source'

export interface DocumentVisualSyntaxIssue {
  kind: DocumentVisualSyntaxIssueKind
  message: string
}

function stripCodeFences(content: string): string {
  return content.replace(CODE_FENCE_REGEX, '\n')
}

function isMermaidEdgeLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || /^-{3,}$/.test(trimmed)) return false
  if (!/(?:-->|---|--x|---x|==>|-\.->|--o|o--)/.test(trimmed)) return false
  return /(?:["'\][]|<br\s*\/?>|[\p{Script=Han}])/iu.test(trimmed)
}

function isMermaidNodeLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^%%\s*\S/.test(trimmed)) return true
  if (/^(?:graph|flowchart)\s+(?:TD|TB|BT|LR|RL)\b/i.test(trimmed)) return true
  return /^[\p{L}\p{N}_-]+\s*(?:\[[^\]]+\]|\([^)]+\)|\{[^}]+\})/u.test(trimmed)
}

export function hasExposedMermaidSource(content: string): boolean {
  const outsideFences = stripCodeFences(content)
  const lines = outsideFences.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const mermaidLikeLines = lines.filter((line) => isMermaidEdgeLine(line) || isMermaidNodeLine(line))
  if (mermaidLikeLines.length < 2) return false

  const hasEdge = mermaidLikeLines.some(isMermaidEdgeLine)
  if (!hasEdge) return false

  const hasGraphDeclaration = mermaidLikeLines.some((line) => /^(?:graph|flowchart)\s+(?:TD|TB|BT|LR|RL)\b/i.test(line))
  const hasMermaidFence = /```mermaid\b/i.test(content)
  const hasSourceOnlyMarkup = mermaidLikeLines.some((line) => /<br\s*\/?>|^%%\s*\S/i.test(line))

  return hasGraphDeclaration || hasMermaidFence || hasSourceOnlyMarkup || mermaidLikeLines.length >= 3
}

function findWidgetSyntaxIssue(content: string): DocumentVisualSyntaxIssue | null {
  SHOW_WIDGET_FENCE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SHOW_WIDGET_FENCE_REGEX.exec(content)) !== null) {
    const raw = (match[1] || '').trim()
    if (!raw) {
      return { kind: 'widget_empty', message: '目标文档里有空的 show-widget 代码块' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { kind: 'widget_json_invalid', message: '目标文档里的 show-widget JSON 不完整或无法解析' }
    }
    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
    const widgetCode = typeof record?.widget_code === 'string'
      ? record.widget_code
      : typeof record?.widgetCode === 'string'
        ? record.widgetCode
        : ''
    if (/<svg[\s>]/i.test(widgetCode) && !/<\/svg>/i.test(widgetCode)) {
      return { kind: 'widget_svg_unclosed', message: '目标文档里的 show-widget SVG 没有闭合' }
    }
  }
  return null
}

function findMalformedMermaidBlockIssue(content: string): DocumentVisualSyntaxIssue | null {
  MERMAID_FENCE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MERMAID_FENCE_REGEX.exec(content)) !== null) {
    const block = match[1] || ''
    const lines = block.split(/\r?\n/)
    for (const line of lines) {
      if (/(?:--|-\.)\s*["“][^"”]+["”]\s*(?:---|-->|\.->|==>)/.test(line)) {
        return { kind: 'malformed_mermaid_static', message: '目标文档里的 Mermaid 代码块使用了不兼容的边标签语法' }
      }
      if (/^\s*subgraph\s+[A-Za-z_][\w-]*\s*\["/.test(line)) {
        return { kind: 'malformed_mermaid_static', message: '目标文档里的 Mermaid 代码块使用了不兼容的 subgraph 标题语法' }
      }
    }
  }
  return null
}

export function findDocumentVisualSyntaxIssueDetail(content: string): DocumentVisualSyntaxIssue | null {
  const widgetIssue = findWidgetSyntaxIssue(content)
  if (widgetIssue) return widgetIssue
  const malformedMermaidIssue = findMalformedMermaidBlockIssue(content)
  if (malformedMermaidIssue) return malformedMermaidIssue
  return hasExposedMermaidSource(content)
    ? { kind: 'exposed_mermaid_source', message: '目标文档里有裸露的 Mermaid/关系图源码，没有放进完整的 ```mermaid 代码块' }
    : null
}

export function findDocumentVisualSyntaxIssue(content: string): string | null {
  return findDocumentVisualSyntaxIssueDetail(content)?.message || null
}

export function findShowWidgetBoundaryViolation(
  content: string,
  ranges: Array<{ start: number; end: number }>,
): DocumentVisualSyntaxIssue | null {
  if (ranges.length === 0 || !/```show-widget/i.test(content)) return null
  SHOW_WIDGET_FENCE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SHOW_WIDGET_FENCE_REGEX.exec(content)) !== null) {
    const fenceStart = match.index ?? 0
    const fenceEnd = fenceStart + match[0].length
    const overlaps = ranges.some((range) => range.start < fenceEnd && range.end > fenceStart)
    if (overlaps) {
      return {
        kind: 'widget_boundary_violation',
        message: '不能用普通文本替换工具修改 show-widget 代码块内部内容',
      }
    }
  }
  return null
}
