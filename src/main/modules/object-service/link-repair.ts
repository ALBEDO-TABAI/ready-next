import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { commitDocumentOperation, documentVersion, getDocumentWriteDependencies } from '../document-engine/document-write-service'
import { extractObjectLinks, repairBinding } from '../search-engine/object-link-extract'
import { ObjectRegistry, objectTransaction } from './registry'

type Binding = { source_id: string; kind: string; raw_target: string; target_id: string; source_hash: string | null; state: string }
/** Repair receipts are business records, not the disposable relation projection. */
export async function repairObjectLinks(registry: ObjectRegistry): Promise<void> {
  const dependencies = getDocumentWriteDependencies()
  if (!dependencies) return
  const db = registry.db
  const bindings = db.prepare("SELECT * FROM object_link_repairs WHERE state='pending'").all<Binding>()
  for (const sourceId of new Set(bindings.map(row => row.source_id))) {
    const source = registry.get(sourceId)
    if (source?.kind !== 'markdown' || !source.current_path || source.identity_state === 'conflict') continue
    const rows = db.prepare('SELECT * FROM object_link_repairs WHERE source_id=?').all<Binding>(sourceId)
    try {
      const original = readFileSync(source.current_path, 'utf8')
      if (rows.some(row => row.state === 'pending' && row.source_hash !== documentVersion(original))) continue
      const changes = new Map<string, string>()
      const edits: Array<{ start: number; end: number; text: string }> = []
      for (const link of extractObjectLinks(original)) {
        const binding = repairBinding(link.kind, link.rawTarget)
        const row = rows.find(r => r.state === 'pending' && r.kind === binding.kind && r.raw_target === binding.rawTarget)
        if (!row || link.sourceOffset === null) continue
        const target = registry.get(row.target_id)
        if (!target?.current_path || target.identity_state === 'conflict') continue
        const wiki = original.slice(link.sourceOffset).startsWith('[[') || original.slice(link.sourceOffset).startsWith('![[') || link.kind === 'frontmatter' && original.indexOf('[[', link.sourceOffset) <= link.sourceOffset + 1
        const path = relative(dirname(source.current_path), target.current_path).split('\\').join('/')
        const next = (wiki ? path.replace(/\.md$/i, '') : encodeURI(path)) + (link.fragment === null ? '' : '#' + link.fragment)
        if (next === link.rawTarget) continue
        const start = original.indexOf(link.rawTarget, link.sourceOffset)
        edits.push({ start, end: start + link.rawTarget.length, text: next })
        changes.set(row.kind + ':' + row.raw_target, repairBinding(link.kind, next).rawTarget)
      }
      if (!edits.length) continue
      let next = original
      for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
      const updated = rows.map(row => ({ ...row, raw_target: changes.get(row.kind + ':' + row.raw_target) ?? row.raw_target, source_hash: documentVersion(next), state: changes.has(row.kind + ':' + row.raw_target) ? 'confirmed' : row.state }))
      const store = (values: Binding[]) => objectTransaction(db, () => {
        db.prepare('DELETE FROM object_link_repairs WHERE source_id=?').run(sourceId)
        for (const row of values) db.prepare('INSERT OR REPLACE INTO object_link_repairs VALUES (?,?,?,?,?,?)').run(row.source_id, row.kind, row.raw_target, row.target_id, row.source_hash, row.state)
      })
      await commitDocumentOperation({ path: source.current_path, expectedVersion: documentVersion(original), operation: { type: 'replaceRange', start: 0, end: original.length, expectedText: original, replacement: next }, origin: 'object_link_repair' }, dependencies, {
        published: async () => { store(updated); registry.register(source.current_path!) },
        rollback: async () => { store(rows); registry.register(source.current_path!) },
      })
    } catch (error) {
      console.warn('[objects] link writeback remains pending', sourceId, String(error))
    }
  }
}
