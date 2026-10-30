import { repairBinding } from './object-link-extract'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { ObjectLinkEndpointSchema, type ExtractedObjectLink, type ObjectLink, type ObjectLinkEndpoint, type ObjectLinkKind } from '../../../shared/object-links'
import { parseReadyUri, toReadyUri } from '../../../shared/ready-ref'
import type { DatabaseConnection } from '../database/connection'

interface LinkRow {
  id: string; source_id: string | null; source_ref: string | null; target_id: string | null; target_ref: string | null
  kind: ObjectLinkKind; raw_target: string; target_text: string; fragment: string | null; source_line: number | null; source_offset: number | null
  source_node_id: string | null; resolved: number; unresolved_reason: string | null
}
interface Target { id: string; current_path: string | null; status: string; identity_state: string }
function endpoint(id: string | null, uri: string | null): ObjectLinkEndpoint | null {
  if (id !== null) return { objectId: id }
  if (uri === null) return null
  const parsed = parseReadyUri(uri)
  if (!parsed.ok) throw new Error(`Invalid indexed ReadyRef: ${uri}`)
  return { ref: parsed.ref }
}
function key(input: ObjectLinkEndpoint): { id: string | null; uri: string | null } {
  const parsed = ObjectLinkEndpointSchema.parse(input)
  if ('objectId' in parsed) return { id: parsed.objectId, uri: null }
  const ref = parsed.ref
  if (ref.kind === 'page' || ref.kind === 'file' || ref.kind === 'canvas') return { id: ref.id, uri: null }
  return { id: null, uri: toReadyUri(ref) }
}

/** The only owner of relation resolution. Repair receipts survive deletion of derived rows. */
export class ObjectLinkRepository {
  constructor(private readonly db: DatabaseConnection) {}

  outgoing(input: ObjectLinkEndpoint, limit = 1000): ObjectLink[] { return this.query(input, 'source', limit) }
  incoming(input: ObjectLinkEndpoint, limit = 1000): ObjectLink[] { return this.query(input, 'target', limit) }
  private query(input: ObjectLinkEndpoint, side: 'source' | 'target', limit: number): ObjectLink[] {
    const { id, uri } = key(input)
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid relation limit')
    const node = 'ref' in input && input.ref.kind === 'canvas' ? input.ref.node : undefined
    const predicate = node ? side === 'source' ? ' AND source_node_id=?' : ' AND raw_target=?' : ''
    const parameters = node ? [id ?? uri, side === 'source' ? node : 'ref' in input ? toReadyUri(input.ref) : '', limit] : [id ?? uri, limit]
    return this.db.prepare(`SELECT * FROM object_links WHERE ${side}_${id ? 'id' : 'ref'}=?${predicate} ORDER BY id LIMIT ?`)
      .all<LinkRow>(...parameters).map(row => ({ id: row.id, source: endpoint(row.source_id, row.source_ref)!, target: endpoint(row.target_id, row.target_ref),
        sourceNodeId: row.source_node_id, kind: row.kind, rawTarget: row.raw_target, fragment: row.fragment, sourceLine: row.source_line, sourceOffset: row.source_offset,
        resolved: row.resolved === 1, unresolvedReason: row.unresolved_reason }))
  }

  replace(source: ObjectLinkEndpoint, links: ExtractedObjectLink[], sourceHash: string | null): void {
    const { id, uri } = key(source)
    this.db.prepare(`DELETE FROM object_links WHERE source_${id ? 'id' : 'ref'}=?`).run(id ?? uri)
    for (const [index, link] of links.entries()) {
      const edgeId = createHash('sha256').update(JSON.stringify([id ?? uri, link.kind, link.rawTarget, link.sourceNodeId ?? null, link.sourceOffset ?? (link.sourceNodeId ? 0 : index)])).digest('hex')
      this.db.prepare(`INSERT OR IGNORE INTO object_links(id,source_id,source_ref,kind,raw_target,target_text,fragment,source_line,source_offset,source_node_id,resolved,unresolved_reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,0,'尚未解析')`).run(edgeId, id, uri, link.kind, link.rawTarget, link.targetText, link.fragment, link.sourceLine, link.sourceOffset, link.sourceNodeId ?? null)
    }
    if (id) {
      const bindings = new Set(links.map(link => JSON.stringify(repairBinding(link.kind, link.rawTarget))))
      for (const row of this.db.prepare('SELECT kind,raw_target FROM object_link_repairs WHERE source_id=?').all<{kind:string;raw_target:string}>(id)) {
        if (!bindings.has(JSON.stringify({kind:row.kind,rawTarget:row.raw_target}))) this.db.prepare('DELETE FROM object_link_repairs WHERE source_id=? AND kind=? AND raw_target=?').run(id,row.kind,row.raw_target)
      }
    }
    this.resolveRows(this.db.prepare(`SELECT * FROM object_links WHERE source_${id ? 'id' : 'ref'}=?`).all<LinkRow>(id ?? uri), sourceHash)
  }

  resolveWorkspace(workspaceId: number): void {
    this.resolveRows(this.db.prepare(`SELECT l.* FROM object_links l JOIN objects s ON s.id=l.source_id WHERE s.workspace_id=?`).all<LinkRow>(workspaceId))
  }
  resolveDocument(documentId: number): void {
    const doc = this.db.prepare('SELECT object_id,path,name,workspace_id FROM documents WHERE id=?').get<{ object_id: string | null; path: string; name: string; workspace_id: number }>(documentId)
    if (!doc?.object_id) return
    // B8: outgoing, matching incoming names/paths, and existing bindings only.
    // Unrelated unresolved links wait for the workspace pass, never a file save.
    const stem = doc.name.replace(/\.md$/i, '').toLowerCase()
    const name = doc.name.toLowerCase()
    const rows = this.db.prepare(`SELECT l.* FROM object_links l LEFT JOIN objects s ON s.id=l.source_id
      WHERE l.source_id=? OR l.target_id=? OR (s.workspace_id=? AND (lower(l.target_text) IN (?,?)
        OR substr(lower(l.target_text),-length(?)-1)='/'||?
        OR substr(lower(l.target_text),-length(?)-1)='/'||?))`)
      .all<LinkRow>(doc.object_id, doc.object_id, doc.workspace_id, stem, name, stem, stem, name, name)
    this.resolveRows(rows)
  }

  private resolveRows(rows: LinkRow[], sourceHash?: string | null): void {
    for (const row of rows) {
      const source = row.source_id ? this.db.prepare('SELECT current_path,workspace_id,content_hash FROM objects WHERE id=?').get<{ current_path: string | null; workspace_id: number; content_hash: string | null }>(row.source_id) : null
      const binding = repairBinding(row.kind, row.raw_target)
      const receipt = row.source_id ? this.db.prepare('SELECT target_id,state FROM object_link_repairs WHERE source_id=? AND kind=? AND raw_target=?').get<{ target_id: string; state: string }>(row.source_id, binding.kind, binding.rawTarget) : null
      let target: Target | undefined
      let targetRef: string | null = null, reason: string | null = null
      const ready = parseReadyUri(row.raw_target)
      if (ready.ok) {
        const normalized = key({ ref: ready.ref })
        if (normalized.id) target = this.db.prepare('SELECT * FROM objects WHERE id=?').get<Target>(normalized.id)
        else targetRef = normalized.uri
      } else if (row.raw_target.startsWith('ready://')) reason = '无效 ReadyRef'
      else if (receipt) target = this.db.prepare('SELECT * FROM objects WHERE id=?').get<Target>(receipt.target_id)
      else if (/^[a-z][a-z0-9+.-]*:/i.test(row.target_text)) {
        if (/^https?:\/\//i.test(row.target_text)) {
          const parsed = parseReadyUri(`ready://web?url=${encodeURIComponent(row.raw_target)}`)
          if (parsed.ok) targetRef = toReadyUri(parsed.ref)
        }
        if (!targetRef) reason = '不支持的链接协议'
      } else if (source?.current_path) {
        let text: string
        try { text = decodeURIComponent(row.target_text) } catch { reason = '无效链接编码'; text = '' }
        if (!reason) {
          const root = row.source_node_id ? this.db.prepare('SELECT root FROM workspaces WHERE id=?').get<{ root: string }>(source.workspace_id)?.root : undefined
          const absolute = text ? resolve(root ?? dirname(source.current_path), text) : source.current_path
          const paths = [absolute, absolute + '.md']
          let candidates = this.db.prepare(`SELECT * FROM objects WHERE status='present' AND identity_state<>'conflict' AND current_path IN (?,?)`).all<Target>(...paths)
          if (!candidates.length && !text.startsWith('.') && !text.startsWith('/')) {
            const root = this.db.prepare('SELECT root FROM workspaces WHERE id=?').get<{ root: string }>(source.workspace_id)?.root
            if (root) {
              const path = resolve(root, text)
              candidates = this.db.prepare(`SELECT * FROM objects WHERE status='present' AND identity_state<>'conflict' AND current_path IN (?,?)`).all<Target>(path, path + '.md')
            }
            if (!candidates.length && !text.includes('/')) {
              const stem = text.replace(/\.md$/i, '').toLowerCase()
              candidates = this.db.prepare(`SELECT * FROM objects WHERE workspace_id=? AND status='present' AND identity_state<>'conflict'
                AND lower(replace(current_path, rtrim(current_path, replace(current_path, '/', '')), '')) IN (?,?)`)
                .all<Target>(source.workspace_id, stem, stem + '.md')
                .filter(o => basename(o.current_path!).replace(/\.md$/i, '').toLowerCase() === stem)
            }
          }
          if (!candidates.length) candidates = this.db.prepare(`SELECT DISTINCT o.* FROM objects o JOIN file_move_receipts r ON r.object_id=o.id
            WHERE o.status='trashed' AND o.identity_state<>'conflict' AND r.old_path IN (?,?)`).all<Target>(...paths)
          if (candidates.length === 1) target = candidates[0]
          else if (candidates.length > 1) reason = '多个候选'
        }
      }
      const resolved = !!targetRef || !!target && target.status === 'present' && target.identity_state !== 'conflict'
      this.db.prepare('UPDATE object_links SET target_id=?,target_ref=?,resolved=?,unresolved_reason=? WHERE id=?')
        .run(target?.id ?? null, targetRef, resolved ? 1 : 0, resolved ? null : reason ?? (target?.status === 'trashed' ? '已回收' : target ? '目标不可用' : '目标不存在'), row.id)
      if (row.source_id && target && !ready.ok) {
        this.db.prepare(`INSERT INTO object_link_repairs(source_id,kind,raw_target,target_id,source_hash,state) VALUES(?,?,?,?,?,'confirmed')
          ON CONFLICT(source_id,kind,raw_target) DO UPDATE SET source_hash=excluded.source_hash WHERE object_link_repairs.state='confirmed'`)
          .run(row.source_id, binding.kind, binding.rawTarget, target.id, sourceHash === undefined ? source?.content_hash ?? null : sourceHash)
      }
    }
  }
}
