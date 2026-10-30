import { basename } from 'node:path'
import { z } from 'zod'
import type { IpcMain } from 'electron'
import type { DatabaseConnection } from '../database/connection'
import { ObjectLinkRepository } from '../search-engine/object-links'
import type { ObjectLink, ObjectLinkEndpoint } from '../../../shared/object-links'
import type { ReadyRef } from '../../../shared/ready-ref'
import type { ObjectRelations, ObjectRelationsResult, RelationItem } from './contract'

export class ObjectRelationsService {
  constructor(private readonly db: DatabaseConnection) {}
  private describe(endpoint: ObjectLinkEndpoint | null): { ref: ReadyRef | null; title: string; sourceType: string; reason: string | null } {
    if (!endpoint) return { ref: null, title: '', sourceType: 'unresolved', reason: null }
    if ('ref' in endpoint) {
      const ref = endpoint.ref
      return { ref, title: ref.kind === 'web' ? ref.url : ref.kind === 'day' ? ref.date : ref.kind === 'book-location' ? ref.book : 'id' in ref ? ref.id : 'RSS 查询', sourceType: ref.kind, reason: null }
    }
    const row = this.db.prepare('SELECT kind,current_path,last_known_path,status FROM objects WHERE id=?')
      .get<{ kind: string; current_path: string | null; last_known_path: string; status: string }>(endpoint.objectId)
    if (!row) return { ref: null, title: endpoint.objectId, sourceType: 'unresolved', reason: '对象已不存在' }
    const kind = row.kind === 'markdown' ? 'page' : row.kind === 'canvas' ? 'canvas' : 'file'
    return { ref: row.status === 'present' ? { kind, id: endpoint.objectId } : null,
      title: basename(row.current_path ?? row.last_known_path).replace(/\.md$/i, ''), sourceType: kind,
      reason: row.status === 'present' ? null : row.status === 'trashed' ? '对象已移入回收站' : '对象已失效' }
  }
  query(input: unknown): ObjectRelations {
    const id = z.string().min(1).parse(input)
    const links = new ObjectLinkRepository(this.db)
    const map = (link: ObjectLink, endpoint: ObjectLinkEndpoint | null): RelationItem => {
      const info = this.describe(endpoint)
      return { ...info, id: link.id, title: info.title || link.rawTarget, relation: link.kind,
        reason: info.reason || (!link.resolved ? link.unresolvedReason : null) }
    }
    const outgoing = links.outgoing({ objectId: id }).map(link => map(link, link.target))
    const incoming = links.incoming({ objectId: id }).map(link => map(link, link.source))
    const count = (side: 'source' | 'target') => this.db.prepare(`SELECT COUNT(*) AS n FROM object_links WHERE ${side}_id=?`).get<{ n: number }>(id)!.n
    const backlinkCount = count('target')
    return { outgoing, incoming, backlinkCount, truncated: count('source') > outgoing.length || backlinkCount > incoming.length }
  }
}

export function registerObjectRelationsIPC(ipcMain: Pick<IpcMain, 'handle'>, service: () => ObjectRelationsService): void {
  ipcMain.handle('objectRelations:query', (_event, id: unknown): ObjectRelationsResult => {
    try { return { ok: true, value: service().query(id) } }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  })
}
