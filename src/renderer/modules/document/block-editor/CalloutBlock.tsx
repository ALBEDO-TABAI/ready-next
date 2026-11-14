import { calloutHeader, fragmentHash, parseInlineBlock, type DocumentBlock, type InlineModel } from '../../../../shared/document-blocks'
import { plainModel } from './editing'

// A callout in the page view edits in place (design language plan §1.8): its title is one editable line and its
// body is the callout's own blocks. Markdown puts the "[!type] title" header and the first body lines in one
// paragraph, so that paragraph is shown as two parts: the title, and the lines after it as the first body block.

export interface CalloutView {
  type: string; color?: string
  /** The title's characters in the header line, as a block of their own (empty when the callout has no title). */
  title: DocumentBlock; titleModel: InlineModel
  /** The lines of the first paragraph after the header line, as a block of their own; null when there are none. */
  lead: DocumentBlock | null
  rest: DocumentBlock[]
}

/** How to show a callout for editing, or null when it has to stay a source block (folded callouts, unusual headers). */
export function calloutView(block: DocumentBlock, content: string): CalloutView | null {
  const header = calloutHeader.exec(block.raw)
  const children = block.children.filter((part): part is DocumentBlock => part.kind === 'block')
  const first = children[0]
  if (!header || block.callout?.fold || !first || first.type !== 'paragraph' || first.start !== block.start + header[1].length) return null
  const end = block.start + header[0].length
  const line = /\r\n|\n|\r/.exec(first.raw)
  if (first.start + (line?.index ?? first.raw.length) !== end) return null
  const part = (start: number, to: number, name: string): DocumentBlock => {
    const raw = content.slice(start, to)
    return { ...first, id: `${first.id}:${name}`, start, end: to, raw, hash: fragmentHash(raw), capability: 'rich', children: [] }
  }
  const title = part(end - header[4].trimStart().length, end, 'title')
  // A first title typed into a bare "[!type]" header needs the space that separates it from the bracket.
  const parsed = title.raw ? parseInlineBlock(title.raw) : { ...plainModel(), prefix: header[4] ? '' : ' ' }
  if (parsed.capability !== 'rich') return null
  let lead: DocumentBlock | null = null
  if (line) {
    const after = first.raw.slice(line.index + line[0].length)
    const start = first.start + line.index + line[0].length + /^(?:[ \t]{0,3}>[ \t]?)*/.exec(after)![0].length
    if (content.slice(start, first.end).trim()) lead = part(start, first.end, 'lead')
  }
  return {
    type: header[2].toLowerCase(), color: /^\[![\w-]+\|([\w-]+)\]/.exec(block.raw.slice(header[1].length))?.[1]?.toLowerCase(),
    title, titleModel: parsed, lead, rest: children.slice(1),
  }
}
