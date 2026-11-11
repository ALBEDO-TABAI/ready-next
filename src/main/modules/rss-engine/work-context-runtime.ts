import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { getDatabase } from '../database'
import type { DatabaseConnection } from '../database/connection'
import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { LIBRARY_DATABASE_PAGE, LIBRARY_FIELDS, LIBRARY_KIND_BOOK } from '../../../shared/library'
import { previewRSSWorkContext, sendableRSSWorkContext } from './work-context-service'
import type { RSSWorkContextSources } from './work-context'

/**
 * Only the library's own pages are the person's work (W5 §3): files in mounted folders, the 书房 page (阅读.md)
 * and the 模板 folder are never listed. Without a configured library there are no pages or books.
 */
export function isLibraryWorkPage(libraryRoot: string | null, path: string | null): boolean {
  if (!libraryRoot || !path) return false
  const inside = relative(libraryRoot, path)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return false
  return inside !== LIBRARY_DATABASE_PAGE && inside.split(sep)[0] !== '模板'
}

/** Read the existing object/document title projections, never a page body or LibraryEngine.get (which upgrades files). */
export function rssWorkContextSources(db: DatabaseConnection, calendar: RSSWorkContextSources['calendar'], libraryRoot: string | null): RSSWorkContextSources {
  const titles = () => db.prepare(`SELECT o.id,o.current_path AS path,d.name,d.frontmatter_json AS metadata,CAST(o.mtime_ns AS REAL)/1000000 AS editedAt
    FROM objects o JOIN documents d ON d.object_id=o.id WHERE o.status='present' AND o.identity_state<>'conflict' AND o.kind='markdown'
    ORDER BY o.id`).all<{id:string;path:string|null;name:string;metadata:string|null;editedAt:number}>().filter(row => isLibraryWorkPage(libraryRoot, row.path)).map(row => {
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
let readLibraryRoot: () => string | null = () => null
/** The processing runtime installs the active library root at startup; before that (and in tests) no pages are listed. */
export function setRSSWorkContextLibraryRoot(read: () => string | null): void { readLibraryRoot = read }

function currentRSSWorkContext(read: typeof previewRSSWorkContext) {
  try {
    const manager = getDatabase(), db = manager.getRawDb()
    if (!db) throw new Error('RSS work context database unavailable')
    const now = Date.now()
    return read(manager.rss.sieve, rssWorkContextSources(db, () => manager.calendar.listOccurrences(now / 1000, (now + 7 * 86400000) / 1000)
      .map(o => ({title:o.event.title,startsAt:o.start})), readLibraryRoot()), now)
  } catch (error) {
    console.warn('[rss-work-context] dependencies unavailable; omitting context', error)
    return { text:'',entries:[] }
  }
}

export function previewCurrentRSSWorkContext() { return currentRSSWorkContext(previewRSSWorkContext) }
export function sendableCurrentRSSWorkContext() { return currentRSSWorkContext(sendableRSSWorkContext) }
