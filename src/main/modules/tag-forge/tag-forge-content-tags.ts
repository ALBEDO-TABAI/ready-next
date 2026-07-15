import { parseDocumentGraph } from '../../../shared/document-graph-parse'

const TAG_LINE = /^(?:#[\p{L}\p{N}_\-/]+\s*){1,20}$/u

export function extractDocumentTagLabels(content: string): string[] {
  const graph = parseDocumentGraph(content)
  const frontmatter = Array.isArray(graph.frontmatter?.tags) ? graph.frontmatter.tags.map(String) : []
  return unique([...frontmatter, ...extractLeadingHashtagLabels(graph.body)])
}

export function extractLeadingHashtagLabels(body: string): string[] {
  const { lines, start, end } = leadingTagBlock(body)
  return unique(lines.slice(start, end).flatMap((line) => (
    [...line.matchAll(/#([\p{L}\p{N}_\-/]+)/gu)].map((match) => match[1])
  )))
}

export function stripLeadingHashtagLines(body: string): string {
  const { lines, start, end } = leadingTagBlock(body)
  if (start === end) return body
  return lines.slice(end).join('\n').replace(/^\n+/, '')
}

function leadingTagBlock(body: string): { lines: string[]; start: number; end: number } {
  const lines = body.replace(/^\uFEFF/, '').split(/\r?\n/)
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  let end = start
  while (end < lines.length && TAG_LINE.test(lines[end].trim())) end += 1
  return { lines, start, end }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  return values.map((value) => value.trim().replace(/^#/, '')).filter((value) => {
    const key = value.toLocaleLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
