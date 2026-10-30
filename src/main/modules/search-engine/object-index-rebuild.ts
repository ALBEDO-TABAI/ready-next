import { FastCardRepository } from '../repositories/fastcard-repository'
import { ObjectLinkRepository } from './object-links'
import { linkTarget } from './object-link-extract'
import type { SearchEngine } from './indexer'

/** Keep identity, repair receipts, and every domain record; delete only projections. */
export async function rebuildObjectIndex(engine: SearchEngine, roots: string[]): Promise<void> {
  const repository = engine.getRepository(), db = repository.getConnection()
  const registered = repository.listWorkspaceRoots().filter(w => w.root !== '@shared').map(w => w.root)
  if (registered.some(root => !roots.includes(root))) throw new Error('Rebuild requires all registered library roots')
  engine.cancelPendingWorkspaceResolves()
  repository.transaction(() => {
    db.exec('DELETE FROM object_links; DELETE FROM documents;')
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='documents_fts'").get()) db.exec('DELETE FROM documents_fts')
  })
  for (const root of roots) {
    const result = await engine.reindexAllSources({ root })
    const errors = Object.values(result.perSource).flatMap(r => r.error ? [r.error] : [])
    if (!result.ok || errors.length) throw new Error(`Object index rebuild failed: ${errors.join('; ')}`)
  }
}

export function refreshCardLinks(engine: SearchEngine): void {
  const repository = engine.getRepository(), db = repository.getConnection()
  const links = new ObjectLinkRepository(db)
  repository.transaction(() => {
    db.exec("DELETE FROM object_links WHERE kind='card-source'")
    for (const card of new FastCardRepository(db).list()) {
      const url = card.source?.pageUrl
      links.replace({ ref: { kind: 'fastcard', id: card.id } }, url ? [linkTarget(url, 'card-source', null, null)] : [], null)
    }
  })
}
