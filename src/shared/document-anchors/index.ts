import { z } from 'zod'
import { parseDocumentBlocks, fragmentHash, type DocumentBlock } from '../document-blocks'

export const AnchorSchema = z.object({
  id: z.string().min(1), explicitId: z.string().regex(/^[\w-]+$/).nullable(),
  raw: z.string(), type: z.string(), before: z.string().nullable(), after: z.string().nullable(),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), version: z.string().min(1),
}).strict()
export type DocumentAnchor = z.infer<typeof AnchorSchema>
export type AnchorLocation = { state: 'located'; start: number; end: number } | { state: 'lost'; reason: string }
export function explicitBlockId(source: string, block: DocumentBlock): string | null {
  if (['frontmatter', 'code', 'widget', 'mermaid', 'html'].includes(block.type)) {
    return /^(?:\r\n|\n|\r){2}\^([\w-]+)[ \t]*(?=\r?\n|$)/.exec(source.slice(block.end))?.[1] ?? null
  }
  return /(?:^|\s)\^([\w-]+)[ \t]*$/.exec(block.raw)?.[1]
    ?? /^(?:\r\n|\n|\r){2}\^([\w-]+)[ \t]*(?=\r?\n|$)/.exec(source.slice(block.end))?.[1] ?? null
}
export function anchoredBlocks(source: string) {
  return parseDocumentBlocks(source).blocks.filter(block => block.type !== 'frontmatter' && !/^\^[\w-]+\s*$/.test(block.raw))
}
export function createAnchor(source: string, start: number, end: number, version: string, id: string): DocumentAnchor {
  const blocks = anchoredBlocks(source), index = blocks.findIndex(block => block.start === start && block.end === end)
  const block = blocks[index]
  if (!block) throw new Error('所选块已变化')
  return AnchorSchema.parse({ id, explicitId: explicitBlockId(source, block), raw: block.raw, type: block.type,
    before: blocks[index - 1]?.raw ?? null, after: blocks[index + 1]?.raw ?? null, start, end, version })
}
export function relocateAnchor(source: string, anchor: DocumentAnchor): AnchorLocation {
  const blocks = anchoredBlocks(source)
  let matches = blocks.filter(block => anchor.explicitId
    ? explicitBlockId(source, block) === anchor.explicitId
    : block.type === anchor.type && block.raw === anchor.raw)
  if (!anchor.explicitId && matches.length > 1) matches = matches.filter(block => {
    const index = blocks.indexOf(block)
    return (blocks[index - 1]?.raw ?? null) === anchor.before && (blocks[index + 1]?.raw ?? null) === anchor.after
  })
  // A container and its nested paragraph can share a trailing marker. The outer block owns it.
  const owners = anchor.explicitId ? matches.filter(block => !matches.some(other => other !== block && other.start <= block.start && other.end >= block.end)) : matches
  return owners.length === 1 ? { state: 'located', start: owners[0].start, end: owners[0].end }
    : { state: 'lost', reason: owners.length ? '原位置已变化：有多个候选块' : '原位置已变化：原块已删除或改写' }
}
export function markBlock(source: string, block: DocumentBlock, id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error('无效块编号')
  if (explicitBlockId(source, block)) return block.raw
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return block.raw + (['paragraph', 'heading'].includes(block.type) ? ' ' : eol + eol) + '^' + id
}
export function parseSyncedBlock(raw: string): { page: string; blockId: string } | null {
  const match = /^!\[\[([^[\]|\r\n]*?)#\^([\w-]+)\]\]$/.exec(raw.trim())
  return match ? { page: match[1], blockId: match[2] } : null
}

/** Include an Obsidian standalone marker when a command moves or deletes its owning block. */
export function blockWithMarker(source: string, block: DocumentBlock): DocumentBlock {
  const suffix = /^(?:\r\n|\n|\r){2}\^[\w-]+[ \t]*(?=\r?\n|$)/.exec(source.slice(block.end))?.[0]
  if (!suffix) return block
  const raw = block.raw + suffix
  return { ...block, end: block.end + suffix.length, byteEnd: block.byteEnd + new TextEncoder().encode(suffix).length, raw, hash: fragmentHash(raw) }
}
