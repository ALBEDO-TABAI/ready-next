import { assertBoundary, DocumentBlockError, fragmentHash } from './positions'
import { calloutHeader, parseDocumentBlocks, type DocumentBlock } from './parser'
import { invertRanges, replaceRanges, type ReplacementRange, type ReplaceRangesOperation } from './ranges'

export interface DocumentBuffer { content: string; version: number }
export interface DocumentSelection { anchor: number; focus: number }
export interface BlockEdit {
  operation: ReplaceRangesOperation
  inverse: ReplaceRangesOperation
  selectionBefore: DocumentSelection
  selectionAfter: DocumentSelection
}
export type BlockCommand =
  | { type: 'replace'; block: DocumentBlock; markdown: string; mode?: 'source' }
  | { type: 'split'; block: DocumentBlock; offset: number; separator: string }
  | { type: 'merge'; first: DocumentBlock; second: DocumentBlock; separator: string }
  | { type: 'move'; block: DocumentBlock; target: DocumentBlock; placement: 'before' | 'after'; prefix: string; suffix: string }
  | { type: 'insertAfter'; block: DocumentBlock; markdown: string; prefix: string; suffix: string }
  | { type: 'delete'; block: DocumentBlock }
  | { type: 'paste'; at: number; markdown: string; prefix: string; suffix: string }
  | { type: 'callout'; block: DocumentBlock; calloutType: string; fold: '' | '-' | '+' }
  | { type: 'moveInColumns'; block: DocumentBlock; fromColumn: DocumentBlock; toColumn: DocumentBlock; at: number; prefix: string; suffix: string }

function requireRich(block: DocumentBlock): void {
  if (block.capability !== 'rich') throw new DocumentBlockError('source_required', 'This block requires whole-source editing')
}

export function createRangeEdit(buffer: DocumentBuffer, ranges: readonly ReplacementRange[], selectionBefore: DocumentSelection,
  selectionAfter?: DocumentSelection): BlockEdit {
  const operation: ReplaceRangesOperation = { type: 'replaceRanges', expectedVersion: buffer.version, ranges: ranges.map(range => ({ ...range })) }
  const after = replaceRanges(buffer.content, operation, buffer.version)
  const selection = selectionAfter ?? selectionBefore
  for (const offset of [selectionBefore.anchor, selectionBefore.focus]) assertBoundary(buffer.content, offset)
  for (const offset of [selection.anchor, selection.focus]) assertBoundary(after, offset)
  return {
    operation, inverse: { type: 'replaceRanges', expectedVersion: buffer.version + 1, ranges: invertRanges(buffer.content, ranges) },
    selectionBefore: { ...selectionBefore }, selectionAfter: { ...selection },
  }
}

/** All separators are explicit command arguments. No trimming or global newline repair occurs. */
export function createBlockCommand(buffer: DocumentBuffer, command: BlockCommand, selectionBefore?: DocumentSelection): BlockEdit {
  const ranges: ReplacementRange[] = []
  const source = buffer.content
  function check(block: DocumentBlock): void {
    assertBoundary(source, block.start); assertBoundary(source, block.end)
    if (block.end < block.start || source.slice(block.start, block.end) !== block.raw || fragmentHash(block.raw) !== block.hash) {
      throw new DocumentBlockError('stale_range', 'Block no longer matches its original source range')
    }
  }
  function edit(start: number, end: number, replacement: string) {
    ranges.push({ start, end, expectedText: source.slice(start, end), replacement })
  }
  let cursor = 0
  if ('block' in command) check(command.block)
  switch (command.type) {
    case 'replace':
      if (command.mode !== 'source') requireRich(command.block)
      edit(command.block.start, command.block.end, command.markdown)
      cursor = command.block.start + command.markdown.length
      break
    case 'split': {
      requireRich(command.block)
      assertBoundary(command.block.raw, command.offset)
      const at = command.block.start + command.offset
      edit(at, at, command.separator); cursor = at + command.separator.length
      break
    }
    case 'merge':
      check(command.first); check(command.second)
      requireRich(command.first); requireRich(command.second)
      if (command.first.parentId !== command.second.parentId || command.first.end > command.second.start
        || !/^\s*$/.test(source.slice(command.first.end, command.second.start))) {
        throw new DocumentBlockError('invalid_command', 'Only adjacent sibling blocks can be merged')
      }
      edit(command.first.end, command.second.start, command.separator)
      cursor = command.first.end + command.separator.length
      break
    case 'insertAfter':
      edit(command.block.end, command.block.end, command.prefix + command.markdown + command.suffix)
      cursor = command.block.end + command.prefix.length + command.markdown.length
      break
    case 'delete':
      if (command.block.capability !== 'rich') throw new DocumentBlockError('source_required', 'Delete this block through whole-source replacement')
      edit(command.block.start, command.block.end, ''); cursor = command.block.start
      break
    case 'paste':
      assertBoundary(source, command.at)
      if (parseDocumentBlocks(source).blocks.some(block => block.capability !== 'rich'
        && block.type !== 'columns' && block.type !== 'column' && command.at > block.start && command.at < block.end)) {
        throw new DocumentBlockError('source_required', 'Pasting inside this block requires whole-source replacement')
      }
      edit(command.at, command.at, command.prefix + command.markdown + command.suffix)
      cursor = command.at + command.prefix.length + command.markdown.length
      break
    case 'callout': {
      if (command.block.type !== 'callout' || !/^[\w-]+$/.test(command.calloutType) || !['', '-', '+'].includes(command.fold)) {
        throw new DocumentBlockError('invalid_command', 'Invalid callout type or fold state')
      }
      const header = calloutHeader.exec(command.block.raw)!
      // Preserve optional decoration, title spacing, quote prefix, and every body byte.
      const token = /^\[![\w-]+/.exec(command.block.raw.slice(header[1].length))![0]
      const start = command.block.start + header[1].length
      edit(start, start + token.length, `[!${command.calloutType}`)
      const close = command.block.raw.indexOf(']', header[1].length) + command.block.start + 1
      edit(close, close + header[3].length, command.fold)
      cursor = command.block.start
      break
    }
    case 'move': case 'moveInColumns': {
      const moved = command.block
      if (moved.capability !== 'rich') throw new DocumentBlockError('source_required', 'This block only supports whole-source replacement')
      let at: number
      if (command.type === 'move') {
        check(command.target)
        if (moved.parentId !== command.target.parentId) throw new DocumentBlockError('invalid_command', 'Move requires sibling blocks')
        at = command.placement === 'before' ? command.target.start : command.target.end
      } else {
        check(command.fromColumn); check(command.toColumn)
        if (command.fromColumn.type !== 'column' || command.toColumn.type !== 'column'
          || command.fromColumn.parentId !== command.toColumn.parentId || moved.parentId !== command.fromColumn.id
          || command.at < command.toColumn.start || command.at > command.toColumn.end
          || command.toColumn.children.some(part => part.kind === 'block' && command.at > part.start && command.at < part.end)) {
          throw new DocumentBlockError('invalid_command', 'Column move must target a boundary in the same columns group')
        }
        at = command.at
      }
      if (at >= moved.start && at <= moved.end) throw new DocumentBlockError('invalid_command', 'Move target intersects the moved block')
      edit(moved.start, moved.end, '')
      edit(at, at, command.prefix + moved.raw + command.suffix)
      cursor = at - (at > moved.end ? moved.raw.length : 0) + command.prefix.length
      break
    }
  }
  const before = selectionBefore ?? { anchor: 'block' in command ? command.block.start : 0, focus: 'block' in command ? command.block.start : 0 }
  return createRangeEdit(buffer, ranges, before, { anchor: cursor, focus: cursor })
}
