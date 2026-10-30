import { readFileSync } from 'node:fs'
import { ObjectRegistry, canonicalObjectPath, isInside } from '../../object-service/registry'
import { withDocumentPathLock, type DocumentWriteDependencies } from '../../document-engine/document-write-service'
import type { ReminderFirePayload } from '../../../../shared/calendar-types'
import { dateMentionReference, type DateMentionTarget } from '../../../../shared/calendar/date-mentions'
import type { ReadyRef } from '../../../../shared/ready-ref'
import { DateMentionDocuments } from './documents'
import type { DateMentionService } from './service'
import type { MentionIndexEvent } from './index-events'

/** Resolves ownership at use time; timers and notifications never retain authority over an old vault. */
export class DateMentionController {
  private documents: DateMentionDocuments
  private synchronization: Promise<void> = Promise.resolve()
  constructor(private registry: ObjectRegistry, private service: DateMentionService, private root: () => string | null, timeZone?: () => string) {
    this.documents = new DateMentionDocuments(registry, service, timeZone)
  }
  private owns(objectId: string): boolean {
    const root = this.root(), object = this.registry.get(objectId)
    return !!root && !!object && isInside(canonicalObjectPath(root), canonicalObjectPath(object.current_path ?? object.last_known_path))
  }
  indexed(event: MentionIndexEvent): Promise<void> {
    const sync = async () => {
      const root = this.root()
      if (!root || canonicalObjectPath(event.workspaceRoot) !== canonicalObjectPath(root)) return
      const paths = new Set(event.changedPaths.map(canonicalObjectPath))
      for (const object of this.registry.list()) {
        if (object.kind !== 'markdown' || !this.owns(object.id) || !(event.reason === 'rebuild'
          || paths.has(object.last_known_path) || !!object.current_path && paths.has(object.current_path))) continue
        // Index acknowledgement precedes the writer's final readback/rollback. Wait for its path lock.
        await withDocumentPathLock(object.current_path ?? object.last_known_path, async () => {
          if (root === this.root() && this.owns(object.id)) this.documents.sync(object.id)
        })
      }
    }
    this.synchronization = this.synchronization.then(sync, sync)
    return this.synchronization
  }
  settled(): Promise<void> { return this.synchronization }
  async rebuild(): Promise<void> { const root = this.root(); if (root) await this.indexed({ workspaceRoot: root, reason: 'rebuild', changedPaths: [] }) }
  async deliver(payload: ReminderFirePayload, fire: (payload: ReminderFirePayload) => void): Promise<void> {
    await this.settled()
    const object = payload.mention && this.registry.get(payload.mention.objectId)
    if (object) await withDocumentPathLock(object.current_path ?? object.last_known_path, async () => fire(payload))
  }
  list() { return this.service.list().filter(row => this.owns(row.objectId)) }
  pending(until: number, now: number): ReminderFirePayload[] { return this.service.pending(until, now).filter(row => !!row.mention && this.owns(row.mention.objectId)) }
  claim(payload: ReminderFirePayload): boolean { return !!payload.mention && this.owns(payload.mention.objectId) && this.documents.claim(payload) }
  reference(id: string): ReadyRef {
    const row = this.list().find(row => row.id === id)
    if (!row) throw new Error('提醒不存在或不属于当前资料库')
    return dateMentionReference(row)
  }
  locate(ref: ReadyRef): DateMentionTarget {
    if (ref.kind !== 'file' || !ref.anchor?.startsWith('date-mention:')) throw new Error('日期提及引用无效')
    if (!this.owns(ref.id)) throw new Error('提醒不属于当前资料库')
    this.documents.sync(ref.id)
    const row = this.list().find(row => row.objectId === ref.id && row.id === ref.anchor)
    const object = this.registry.get(ref.id)
    if (!row || object?.status !== 'present' || !object.current_path) throw new Error('日期提及已不存在')
    if (object.identity_state === 'conflict') throw new Error('文档身份冲突，无法定位')
    const content = readFileSync(object.current_path, 'utf8')
    if (content.slice(row.start, row.end) !== row.text) throw new Error('原文正在变化，请重试')
    return { path: object.current_path, content, start: row.start, end: row.end }
  }
}

/** Add the missing saved-document publisher without introducing a second synchronization owner. */
export function withDateMentionIndex(writer: DocumentWriteDependencies, root: () => string | null,
  publish: (event: MentionIndexEvent) => void): DocumentWriteDependencies {
  return { ...writer, index: async (path, content) => {
    const startedRoot = root()
    await writer.index(path, content)
    if (startedRoot && startedRoot === root() && isInside(canonicalObjectPath(startedRoot), canonicalObjectPath(path))) {
      publish({ workspaceRoot: startedRoot, reason: 'incremental', changedPaths: [path] })
    }
  } }
}
