import type { DocumentPageService } from '../document-pages/service'
import type { DocumentWriteDependencies } from '../document-engine/document-write-service'
import type { DocumentDatabaseService } from '../document-database/service'
import { CalendarLayersService } from './service'
import { LibrarySessions } from './reading'

/** Resolve after recovery on every call: an old vault never owns a new request. */
export function createCalendarLayersResolver(dependencies: {
  pages: DocumentPageService
  writer(): DocumentWriteDependencies | null
  /** The shared active-vault database resolver: it waits for recovery and refuses an unconfigured vault. */
  database(): Promise<DocumentDatabaseService>
}) {
  return async () => {
    const database = await dependencies.database(), writer = dependencies.writer()
    if (!writer) throw new Error('Document writer unavailable')
    const registry = dependencies.pages.registry
    return {
      layers: new CalendarLayersService(database.root, registry, database, writer, dependencies.pages),
      reading: new LibrarySessions(database.root, registry),
    }
  }
}
