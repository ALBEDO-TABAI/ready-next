import { z } from 'zod'
import { getDatabase } from '../database'
import type { DatabaseConnection } from '../database/connection'
import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { LIBRARY_FIELDS, LIBRARY_KIND_BOOK } from '../../../shared/library'
import { previewRSSWorkContext, sendableRSSWorkContext } from './work-context-service'
import type { RSSWorkContextSources } from './work-context'

/** Read the existing object/document title projections, never a page body or LibraryEngine.get (which upgrades files). */
export function rssWorkContextSources(db: DatabaseConnection, calendar: RSSWorkContextSources['calendar']): RSSWorkContextSources {
  const titles = () => db.prepare(`SELECT o.id,d.name,d.frontmatter_json AS metadata,CAST(o.mtime_ns AS REAL)/1000000 AS editedAt
    FROM objects o JOIN documents d ON d.object_id=o.id WHERE o.status='present' AND o.identity_state<>'conflict' AND o.kind='markdown'
    ORDER BY o.id`).all<{id:string;name:string;metadata:string|null;editedAt:number}>().map(row => {
      const metadata = row.metadata ? z.record(z.string(), z.unknown()).parse(JSON.parse(row.metadata)) : {}
      return { ...row, metadata, title: typeof metadata.title === 'string' ? metadata.title : row.name.replace(/\.md$/i,'') }
    })
  return {
    pages: () => titles().filter(p => p.metadata[LIBRARY_FIELDS.kind] !== LIBRARY_KIND_BOOK).map(({id,title,editedAt}) => ({id,title,editedAt})),
    projects: () => {
      const roots = db.prepare('SELECT root FROM workspaces ORDER BY root').all<{root:string}>().map(r => r.root)
      return new FileProjectIdentityRepository(db).listProjects(roots).map(p => ({title:p.displayName,active:p.status === 'active'}))
    },
    calendar,
    books: () => titles().filter(p => p.metadata[LIBRARY_FIELDS.kind] === LIBRARY_KIND_BOOK).map(p => ({id:p.id,title:p.title,reading:p.metadata[LIBRARY_FIELDS.status] === '在读'})),
  }
}
function currentRSSWorkContext(read: typeof previewRSSWorkContext) {
  try {
    const manager = getDatabase(), db = manager.getRawDb()
    if (!db) throw new Error('RSS work context database unavailable')
    const now = Date.now()
    return read(manager.rss.sieve, rssWorkContextSources(db, () => manager.calendar.listOccurrences(now / 1000, (now + 7 * 86400000) / 1000)
      .map(o => ({title:o.event.title,startsAt:o.start}))), now)
  } catch (error) {
    console.warn('[rss-work-context] dependencies unavailable; omitting context', error)
    return { text:'',entries:[] }
  }
}

export function previewCurrentRSSWorkContext() { return currentRSSWorkContext(previewRSSWorkContext) }
export function sendableCurrentRSSWorkContext() { return currentRSSWorkContext(sendableRSSWorkContext) }
