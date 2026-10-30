import { isMap, isScalar, parseDocument, stringify } from 'yaml'

export type DocumentOperation =
  | { type: 'setFrontmatterFields'; set: Record<string, unknown>; remove?: string[] }
  | { type: 'appendBlock'; underHeading?: string; markdown: string }
  | { type: 'replaceRange'; start: number; end: number; expectedText: string; replacement: string }

export interface DocumentTabSnapshot { id: string; path: string; content: string; isDirty: boolean }
export type DocumentSyncRequest = {
  id: string
  path: string
  deadline: number
} & (
  | { phase: 'prepare'; operation: DocumentOperation; diskContent: string }
  | { phase: 'commit' }
  | { phase: 'rollback'; content?: string }
  | { phase: 'release' }
)
export type DocumentSyncReply =
  | { ok: true; tabs: DocumentTabSnapshot[]; content?: string }
  | { ok: false; message: string; code?: 'dirty_conflict' | 'operation_failed' }

export function replaceRange(content: string, input: Omit<Extract<DocumentOperation, { type: 'replaceRange' }>, 'type'>): string {
  const { start, end, expectedText, replacement } = input
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > content.length) {
    throw new Error('Invalid replacement range')
  }
  if (content.slice(start, end) !== expectedText) throw new Error('replaceRange expectedText mismatch')
  return content.slice(0, start) + replacement + content.slice(end)
}

function frontmatterRange(content: string): { start: number; end: number; bodyStart: number } | null {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content)
  if (!opening) return null
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(content.slice(opening[0].length))
  if (!closing) throw new Error('Unclosed frontmatter')
  return { start: opening[0].length, end: opening[0].length + closing.index, bodyStart: opening[0].length + closing.index + closing[0].length }
}

export function readDocumentSource(content: string): { frontmatter: Record<string, unknown>; body: string; bodyStart: number } {
  const range = frontmatterRange(content)
  if (!range) {
    const bodyStart = content.startsWith('\uFEFF') ? 1 : 0
    return { frontmatter: {}, body: content.slice(bodyStart), bodyStart }
  }
  const doc = parseDocument(content.slice(range.start, range.end))
  if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '))
  if (doc.contents && !isMap(doc.contents)) throw new Error('Frontmatter must be a mapping')
  const frontmatter: Record<string, unknown> = doc.toJS() ?? {}
  return { frontmatter, body: content.slice(range.bodyStart), bodyStart: range.bodyStart }
}

export function setFrontmatterFields(content: string, input: Omit<Extract<DocumentOperation, { type: 'setFrontmatterFields' }>, 'type'>): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const range = frontmatterRange(content)
  const yaml = range ? content.slice(range.start, range.end) : ''
  const doc = parseDocument(yaml)
  if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join('; '))
  if (doc.contents && !isMap(doc.contents)) throw new Error('Frontmatter must be a mapping')
  const edits: Array<{ start: number; end: number; text: string }> = []
  const removals = new Set(input.remove ?? [])
  const fields = new Map(Object.entries(input.set))
  for (const name of removals) {
    if (fields.has(name)) throw new Error(`Field both set and removed: ${name}`)
  }
  if (isMap(doc.contents)) {
    if (doc.contents.flow) throw new Error('Flow frontmatter mapping cannot be patched without changing unrelated bytes')
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Frontmatter keys must be strings')
      const name = pair.key.value
      if (!removals.has(name) && !fields.has(name)) continue
      const keyRange = pair.key.range
      const value = pair.value
      if (!keyRange || !value || !('range' in value) || !value.range) throw new Error(`Cannot patch field: ${name}`)
      if (removals.has(name)) {
        const start = yaml.lastIndexOf('\n', keyRange[0] - 1) + 1
        let end = value.range[2]
        if (end > 0 && yaml[end - 1] !== '\n') {
          const eol = yaml.indexOf('\n', end)
          end = eol < 0 ? yaml.length : eol + 1
        }
        edits.push({ start, end, text: '' })
      } else {
        const next = fields.get(name)
        if (!isScalar(value) || JSON.stringify(value.toJSON()) !== JSON.stringify(next)) {
          if (!isScalar(value) || (next !== null && typeof next === 'object') || value.type === 'BLOCK_LITERAL' || value.type === 'BLOCK_FOLDED') {
            const text = stringify({ [name]: next }, { lineWidth: 0 }).replace(/\n/g, newline)
            edits.push({ start: keyRange[0], end: value.range[2], text })
          } else {
            const text = stringify(next, { lineWidth: 0 }).trimEnd().replace(/\n/g, newline)
            edits.push({ start: value.range[0], end: value.range[1], text })
          }
        }
        fields.delete(name)
      }
    }
  }
  let next = yaml
  for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  for (const [name, value] of fields) {
    const field = stringify({ [name]: value }, { lineWidth: 0 }).replace(/\n/g, newline)
    next += (next && !next.endsWith('\n') ? newline : '') + field
  }
  // Parsing the result also rejects invalid values and broken alias dependencies.
  const checked = parseDocument(next)
  if (checked.errors.length) throw new Error(checked.errors.map((error) => error.message).join('; '))
  checked.toJS()
  if (range) return content.slice(0, range.start) + next + content.slice(range.end)
  if (!next) return content
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  return `${bom}---${newline}${next}---${newline}${content.slice(bom.length)}`
}

export function appendBlock(content: string, input: Omit<Extract<DocumentOperation, { type: 'appendBlock' }>, 'type'>): string {
  if (!input.markdown) return content
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  let offset = 0
  let level: number | null = null
  let fence: string | null = null
  let insertion = content.length
  const fm = frontmatterRange(content)
  for (const line of content.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
    } else if (!fence && (!fm || offset > fm.end)) {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*\r?\n?$/.exec(line)
      if (heading && level !== null && heading[1].length <= level) { insertion = offset; break }
      if (heading && level === null && heading[2] === input.underHeading) level = heading[1].length
    }
    offset += line.length
  }
  const before = content.slice(0, insertion)
  const after = content.slice(insertion)
  const separator = !before || before.endsWith(newline + newline) ? '' : before.endsWith(newline) ? newline : newline + newline
  const block = input.markdown
  const suffix = block.endsWith(newline) ? '' : newline
  return before + separator + block + suffix + (after ? newline : '') + after
}

export function applyDocumentOperation(content: string, operation: DocumentOperation): string {
  switch (operation.type) {
    case 'setFrontmatterFields': return setFrontmatterFields(content, operation)
    case 'appendBlock': return appendBlock(content, operation)
    case 'replaceRange': return replaceRange(content, operation)
    default: throw new Error('Unknown document operation')
  }
}

export function parseDocumentSyncReply(value: unknown): DocumentSyncReply {
  if (!value || typeof value !== 'object') throw new Error('Invalid document synchronization reply')
  if (!('ok' in value)) throw new Error('Missing document synchronization status')
  if (value.ok === false && 'message' in value && typeof value.message === 'string') {
    const code = 'code' in value && (value.code === 'operation_failed' || value.code === 'dirty_conflict') ? value.code : 'dirty_conflict'
    return { ok: false, message: value.message, code }
  }
  if (value.ok !== true || !('tabs' in value) || !Array.isArray(value.tabs)) throw new Error('Missing document tab snapshots')
  const tabs = value.tabs.map((tab: unknown): DocumentTabSnapshot => {
    if (!tab || typeof tab !== 'object' || !('id' in tab) || typeof tab.id !== 'string' || !('path' in tab) || typeof tab.path !== 'string'
      || !('content' in tab) || typeof tab.content !== 'string' || !('isDirty' in tab) || typeof tab.isDirty !== 'boolean') throw new Error('Invalid document tab snapshot')
    return { id: tab.id, path: tab.path, content: tab.content, isDirty: tab.isDirty }
  })
  if ('content' in value && value.content !== undefined && typeof value.content !== 'string') throw new Error('Invalid synchronized content')
  return { ok: true, tabs, content: 'content' in value && typeof value.content === 'string' ? value.content : undefined }
}
