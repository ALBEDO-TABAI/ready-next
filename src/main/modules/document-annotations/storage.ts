import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { checkedPath, ensureDirectory, missing, vaultRoot } from '../document-drafts/files'
import { publishDocumentContent } from '../document-engine/document-write-service'

/** Main is the sole writer; all read/modify/publish work shares this queue. */
export class AnnotationStorage {
  readonly root: string
  private tail: Promise<unknown> = Promise.resolve()
  constructor(root: string) { this.root = vaultRoot(root) }
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result
  }
  path(kind: string, id: string): string {
    if (!/^[\w-]+$/.test(kind) || !/^[\w-]+$/.test(id)) throw new Error('无效元数据编号')
    return checkedPath(this.root, join(this.root, '.ready', kind, id + '.json'))
  }
  read<T>(path: string, schema: z.ZodType<T>): T | null {
    try { return schema.parse(JSON.parse(readFileSync(checkedPath(this.root, path), 'utf8'))) }
    catch (error) { if (missing(error)) return null; throw error }
  }
  async write(path: string, value: unknown): Promise<void> {
    checkedPath(this.root, path); ensureDirectory(this.root, dirname(path))
    const raw = JSON.stringify(value, null, 2)
    await publishDocumentContent(path, raw)
    if (readFileSync(checkedPath(this.root, path), 'utf8') !== raw) throw new Error('元数据回读不一致')
  }
}
