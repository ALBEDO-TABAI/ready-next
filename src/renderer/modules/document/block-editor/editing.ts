import {
  createBlockCommand, createRangeEdit, fragmentHash, parseInlineBlock, replaceRanges, serializeInlineBlock,
  type BlockEdit, type DocumentBlock, type DocumentBuffer, type InlineModel, type InlineSpan,
} from '../../../../shared/document-blocks'
import { plainText, sliceSpans } from './dom-inline'

export function emptyBlock(at: number, parentId: string | null = null): DocumentBlock {
  return { kind: 'block', id: `empty:${at}`, start: at, end: at, byteStart: 0, byteEnd: 0,
    raw: '', hash: fragmentHash(''), type: 'paragraph', capability: 'rich', sourceEditable: true, children: [], parentId }
}
export function inlineMarkdown(model: InlineModel, spans: readonly InlineSpan[]): string {
  const result = serializeInlineBlock(model, spans)
  if (result.capability !== 'rich') throw new Error(result.reason)
  return result.markdown
}
export function plainModel(): InlineModel {
  const model = parseInlineBlock('')
  if (model.capability !== 'rich') throw new Error('空文本模型不可编辑')
  return model
}
export const newline = (content: string) => /\r\n|\n|\r/.exec(content)?.[0] ?? '\n'

// A paragraph inside a quote or a callout that runs over several lines carries the quote marker on every line after
// its first ("a\n> b"). It is edited as the text without those markers and written back with them.
export const unquote = (raw: string) => raw.replace(/(\r\n|\n|\r)(?:[ \t]{0,3}>[ \t]?)+/g, '$1')
export const requote = (markdown: string, quote: string, eol?: string) => quote ? markdown.replace(/\r\n|\n|\r/g, found => (eol ?? found) + quote) : markdown
export const quoteOf = (raw: string, fallback: string) => /(?:\r\n|\n|\r)((?:[ \t]{0,3}>[ \t]?)+)/.exec(raw)?.[1] ?? fallback

export function inputRule(text: string, eol: string): string | null {
  if (/^#{1,6} $/.test(text) || /^([-*+] |1\. |> )$/.test(text)) return text
  if (/^\[ ?\] $/.test(text)) return '- [ ] '
  if (/^``` ?$/.test(text)) return `\`\`\`${eol}${eol}\`\`\``
  if (text === '---') return '---'
  return null
}

/** Split/paste is one history item even when existing inline marks need reserialization. */
export function spliceRich(buffer: DocumentBuffer, block: DocumentBlock, model: InlineModel, spans: InlineSpan[],
  start: number, end: number, inserted: InlineSpan[][] | null, continuation: string, quote = ''): { edit: BlockEdit; at: number; empty: boolean } {
  const eol = newline(buffer.content)
  const left = requote(inlineMarkdown(model, sliceSpans(spans, 0, start)), quote, eol)
  const right = requote(inlineMarkdown(plainModel(), sliceSpans(spans, end)), quote, eol)
  const separator = continuation ? eol + continuation : eol + eol
  const pieces = inserted?.map(part => requote(inlineMarkdown(plainModel(), part), quote, eol))
  const middle = pieces ? pieces.join(separator) : separator
  // First normalize only the edited block, then use the shared structural command.
  const prepared = createBlockCommand(buffer, { type: 'replace', block, markdown: left + right })
  const preparedContent = replaceRanges(buffer.content, prepared.operation, buffer.version)
  const preparedBlock = { ...block, raw: left + right, end: block.start + left.length + right.length, hash: fragmentHash(left + right) }
  const next = { content: preparedContent, version: buffer.version }
  const command = pieces
    ? createBlockCommand(next, { type: 'paste', at: block.start + left.length, markdown: middle, prefix: '', suffix: '' })
    : createBlockCommand(next, { type: 'split', block: preparedBlock, offset: left.length, separator })
  const content = replaceRanges(next.content, command.operation, next.version)
  const replacement = content.slice(block.start, content.length - (buffer.content.length - block.end))
  const at = block.start + left.length + middle.length
  return { edit: createRangeEdit(buffer, [{ start: block.start, end: block.end, expectedText: block.raw, replacement }],
    { anchor: block.start, focus: block.end }, { anchor: at, focus: at }), at,
    empty: !pieces && plainText(sliceSpans(spans, end)).length === 0 }
}
