import type { PreviewBlock } from '../../components/document/note-preview-parser'

function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function getRenderSource(content: string, block: PreviewBlock): string {
  if (block.source) return content.slice(block.source.start, block.source.end)
  if (block.type === 'markdown') return block.markdown
  if (block.type === 'details') return `${block.summary}\n${block.markdown}\n${block.open ? '1' : '0'}`
  if (block.type === 'chips') return block.chips.map((chip) => `${chip.kind}:${chip.raw}`).join('\n')
  if (block.type === 'embed') return block.embedId
  if (block.type === 'widget') return block.widgetId
  return block.reason
}

export function buildPreviewBlockRenderKeys(
  content: string,
  blocks: PreviewBlock[],
): Map<string, string> {
  const occurrences = new Map<string, number>()
  const keys = new Map<string, string>()
  for (const block of blocks) {
    const signature = `${block.type}:${hashText(getRenderSource(content, block))}`
    const occurrence = occurrences.get(signature) || 0
    occurrences.set(signature, occurrence + 1)
    keys.set(block.id, `${signature}:${occurrence}`)
  }
  return keys
}

export function buildPreviewBlockSourceLines(
  content: string,
  blocks: PreviewBlock[],
): Map<string, number> {
  const ranged = blocks
    .filter((block) => block.source !== null)
    .sort((left, right) => left.source!.start - right.source!.start)
  const lines = new Map<string, number>()
  let cursor = 0
  let line = 1
  for (const block of ranged) {
    const target = block.source!.start
    while (cursor < target && cursor < content.length) {
      if (content.charCodeAt(cursor) === 10) line += 1
      cursor += 1
    }
    lines.set(block.id, line)
  }
  return lines
}
