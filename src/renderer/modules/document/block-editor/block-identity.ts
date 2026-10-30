import type { DocumentBlock, ParsedDocument } from '../../../../shared/document-blocks'
import { changedSpan } from './text-edit'

/** UI identity follows unchanged source across offset shifts. It never supplies
 * edit ranges: every command still binds the current parser range and version. */
export class BlockIdentity {
  private source = ''
  private previous: Array<{ block: DocumentBlock; key: string }> = []
  private serial = 0
  resolve(document: ParsedDocument): Map<string, string> {
    const change = changedSpan(this.source, document.source)
    const delta = document.source.length - this.source.length
    const remaining = new Set(this.previous)
    const next: typeof this.previous = []
    const keys = new Map<string, string>()
    for (const block of document.blocks) {
      const match = [...remaining].find(item => item.block.type === block.type && item.block.raw === block.raw
        && (item.block.start >= change.end ? item.block.start + delta : item.block.start) === block.start)
        ?? [...remaining].find(item => item.block.type === block.type && item.block.start === block.start)
      const key = match?.key ?? `block-${++this.serial}`
      if (match) remaining.delete(match)
      next.push({ block, key }); keys.set(block.id, key)
    }
    this.source = document.source; this.previous = next
    return keys
  }
}
