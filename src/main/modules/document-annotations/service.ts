import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { z } from 'zod'
import { AnchorSchema, anchoredBlocks, createAnchor, parseSyncedBlock, relocateAnchor } from '../../../shared/document-anchors'
import { AnnotationCommandSchema, CommentsSchema, type AnnotationCommand, type AnnotationSnapshot, type SyncedSnapshot } from '../../../shared/document-comments'
import { checkedPath } from '../document-drafts/files'
import { documentVersion } from '../document-engine/document-write-service'
import type { ObjectRegistry } from '../object-service/registry'
import { AnnotationStorage } from './storage'
import { resolveWikiPage } from './references'
const AnchorsSchema = z.object({ version: z.literal(1), anchors: z.array(AnchorSchema) }).strict()

export class DocumentAnnotationService {
  constructor(readonly storage: AnnotationStorage, readonly registry: ObjectRegistry) {}
  private page(path: string) {
    checkedPath(this.storage.root, path)
    if (!/\.md$/i.test(path) || path.split(/[\\/]/).includes('.ready')) throw new Error('请选择资料库中的 Markdown 页面')
    const row = existsSync(path) ? this.registry.register(path) : this.registry.find(path)
    if (!row || row.identity_state === 'conflict') throw new Error('页面不存在或身份不明确')
    return row
  }
  comments(input: AnnotationCommand): Promise<AnnotationSnapshot> {
    const request = AnnotationCommandSchema.parse(input)
    return this.storage.serial(async () => {
      const page = this.page(request.path), commentsPath = this.storage.path('comments', page.id), anchorsPath = this.storage.path('anchors', page.id)
      const comments = this.storage.read(commentsPath, CommentsSchema) ?? { version: 1 as const, revision: 0, threads: [] }
      const anchors = this.storage.read(anchorsPath, AnchorsSchema) ?? { version: 1 as const, anchors: [] }
      const content = page.status === 'present' && page.current_path ? readFileSync(checkedPath(this.storage.root, page.current_path), 'utf8') : ''
      if (request.type !== 'read') {
        if (request.expectedRevision !== comments.revision) throw new Error('评论已变化，请刷新后重试')
        if (request.type === 'add') {
          if (documentVersion(content) !== request.expectedVersion) throw new Error('正文已变化，请先保存并刷新')
          const anchor = createAnchor(content, request.start, request.end, request.expectedVersion, randomUUID())
          anchors.anchors.push(anchor)
          await this.storage.write(anchorsPath, anchors)
          comments.threads.push({ id: randomUUID(), anchorId: anchor.id, resolved: false, messages: [{ id: randomUUID(), text: request.text, createdAt: Date.now() }] })
        } else {
          const thread = comments.threads.find(item => item.id === request.threadId)
          if (!thread) throw new Error('评论不存在')
          if (request.type === 'delete') comments.threads = comments.threads.filter(item => item !== thread)
          if (request.type === 'resolve') thread.resolved = request.resolved
          if (request.type === 'reply') thread.messages.push({ id: randomUUID(), text: request.text, createdAt: Date.now() })
          if (request.type === 'edit') {
            const message = thread.messages.find(item => item.id === request.messageId)
            if (!message) throw new Error('评论消息不存在')
            message.text = request.text
          }
        }
        comments.revision++
        await this.storage.write(commentsPath, CommentsSchema.parse(comments))
      }
      return { objectId: page.id, revision: comments.revision, threads: comments.threads.map(thread => {
        const anchor = anchors.anchors.find(item => item.id === thread.anchorId)
        if (!anchor) throw new Error('评论锚点文件不完整')
        return { ...thread, anchor, quote: anchor.raw, location: relocateAnchor(content, anchor) }
      }) }
    })
  }
  synced(path: string, raw: string, seen: string[] = []): SyncedSnapshot {
    const ref = parseSyncedBlock(raw)
    if (!ref) throw new Error('请输入 ![[页面#^块编号]]')
    this.page(path)
    const target = resolveWikiPage(this.storage.root, path, ref.page), page = this.page(target), key = page.id + '#' + ref.blockId
    if (seen.includes(key) || seen.length >= 16) throw new Error('同步块循环引用或层级过深')
    const source = readFileSync(target, 'utf8')
    const anchor = { id: ref.blockId, explicitId: ref.blockId, raw: '', type: '', before: null, after: null, start: 0, end: 0, version: documentVersion(source) }
    const location = relocateAnchor(source, anchor)
    if (location.state === 'lost') throw new Error(location.reason)
    let content = source.slice(location.start, location.end).replace(/(?:\s)\^[\w-]+[ \t]*$/, '')
    for (const block of anchoredBlocks(content).filter(block => !block.parentId).reverse()) {
      const nested = parseSyncedBlock(block.raw)
      if (nested) content = content.slice(0, block.start) + this.synced(target, block.raw, [...seen, key]).content + content.slice(block.end)
    }
    return { objectId: page.id, path: target, blockId: ref.blockId, content, version: documentVersion(source) }
  }
}
