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

export function inputRule(text: string, eol: string): string | null {
  if (/^#{1,6} $/.test(text) || /^([-*+] |1\. |> )$/.test(text)) return text
  if (/^\[ ?\] $/.test(text)) return '- [ ] '
  if (/^``` ?$/.test(text)) return `\`\`\`${eol}${eol}\`\`\``
  if (text === '---') return '---'
  return null
}

/** Split/paste is one history item even when existing inline marks need reserialization. */
export function spliceRich(buffer: DocumentBuffer, block: DocumentBlock, model: InlineModel, spans: InlineSpan[],
  start: number, end: number, inserted: InlineSpan[][] | null, continuation: string): { edit: BlockEdit; at: number; empty: boolean } {
  const left = inlineMarkdown(model, sliceSpans(spans, 0, start))
  const right = inlineMarkdown(plainModel(), sliceSpans(spans, end))
  const eol = newline(buffer.content)
  const separator = continuation ? eol + continuation : eol + eol
  const pieces = inserted?.map(part => inlineMarkdown(plainModel(), part))
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
