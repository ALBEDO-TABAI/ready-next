import { parseDocumentBlocks, parseInlineBlock, type DocumentBlock } from '../../../../shared/document-blocks'
import { emptyBlock, inlineMarkdown, plainModel } from './editing'

export const BLOCK_KINDS = [
  ['paragraph', '段落'], ['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'],
  ['bullet', '无序列表'], ['ordered', '有序列表'], ['task', '任务'], ['quote', '引用'],
  ['NOTE', '笔记 callout'], ['TIP', '提示 callout'], ['WARNING', '注意 callout'],
  ['code', '代码'], ['divider', '分隔线'],
] as const
export type BlockKind = typeof BLOCK_KINDS[number][0]

/** Strip only the selected block's structural wrapper, keeping its inline source. */
function bodyOf(block: DocumentBlock): string {
  const model = parseInlineBlock(block.raw)
  if (model.capability === 'rich') return inlineMarkdown(plainModel(), model.spans)
  if (['blockquote', 'callout'].includes(block.type)) {
    return block.raw.replace(/^ {0,3}> ?/gm, '').replace(/^\[![\w-]+(?:\|[\w-]+)?\][-+]?([^\r\n]*)(\r\n|\n|\r|$)/, (_match, title: string, eol: string) => title.trim() ? title.trim() + eol : '')
  }
  if (['list', 'listItem', 'taskItem'].includes(block.type)) return block.raw.replace(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '$1')
  if (['code', 'mermaid'].includes(block.type)) return block.raw.replace(/^(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/, '').replace(/(?:\r\n|\n|\r)(`{3,}|~{3,})\s*$/, '')
  if (block.type === 'thematicBreak') return ''
  throw new Error('此块包含不能转换的结构，请使用源码编辑')
}
export function convertBlock(block: DocumentBlock, kind: BlockKind, eol: string): string {
  const body = bodyOf(block)
  switch (kind) {
    case 'paragraph': return body
    case 'h1': case 'h2': case 'h3':
      if (/\r|\n/.test(body)) throw new Error('多行内容不能直接转换为单个标题')
      return '#'.repeat(Number(kind[1])) + ' ' + body
    case 'bullet': return body.split(/\r\n|\n|\r/).map(line => '- ' + line).join(eol)
    case 'ordered': return body.split(/\r\n|\n|\r/).map((line, i) => `${i + 1}. ${line}`).join(eol)
    case 'task': return body.split(/\r\n|\n|\r/).map(line => '- [ ] ' + line).join(eol)
    case 'quote': return body.split(/\r\n|\n|\r/).map(line => '> ' + line).join(eol)
    case 'NOTE': case 'TIP': case 'WARNING': return `> [!${kind}]${eol}` + body.split(/\r\n|\n|\r/).map(line => '> ' + line).join(eol)
    case 'code': {
      const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(match => match[0].length + 1)))
      return `${fence}${eol}${body}${eol}${fence}`
    }
    // A divider cannot contain text: keep the content as the following paragraph.
    case 'divider': return '---' + (body ? eol + eol + body : '')
  }
}
/**
 * Pure HTML comments and link definitions are Markdown metadata, not content: the page view hides them like the
 * ready:columns markers, they get no handle and are not move stops, and their bytes stay where they are.
 */
export function isNonContentBlock(block: DocumentBlock): boolean {
  return (block.type === 'html' && /^\s*(?:<!--[\s\S]*?-->\s*)+$/.test(block.raw))
    || (block.type === 'unknown' && /^ {0,3}\[[^\]\r\n]+\]:/.test(block.raw))
}
export function actionableBlocks(content: string): DocumentBlock[] {
  const parsed = parseDocumentBlocks(content)
  const empty = parsed.blocks.filter(block => block.type === 'column' && !block.children.some(child => child.kind === 'block')).map(block => emptyBlock(block.end, block.id))
  return [...parsed.blocks, ...empty].filter(block => block.type !== 'frontmatter' && block.type !== 'column' && !isNonContentBlock(block)
    && (block.parentId === null || parsed.blocks.find(parent => parent.id === block.parentId)?.type === 'column')).sort((a, b) => a.start - b.start)
}
