import type { VaultService } from '../settings-engine/vault-service'
import type { DocumentPageService } from '../document-pages/service'
import type { DocumentWriteDependencies } from '../document-engine/document-write-service'
import { DocumentDatabaseService } from '../document-database/service'
import { CalendarLayersService } from './service'
import { LibrarySessions } from './reading'

/** Resolve after recovery on every call: an old vault never owns a new request. */
export function createCalendarLayersResolver(dependencies: {
  vault: Pick<VaultService, 'get'>; pages: DocumentPageService; ready: Promise<void>
  writer(): DocumentWriteDependencies | null
}) {
  return async () => {
    await dependencies.ready
    const state = dependencies.vault.get(), writer = dependencies.writer()
    if (state.status !== 'ready') throw new Error('请先配置可用的资料库')
    if (!writer) throw new Error('Document writer unavailable')
    const registry = dependencies.pages.registry
    registry.db.prepare('INSERT INTO workspaces(root) VALUES (?) ON CONFLICT(root) DO NOTHING').run(state.root)
    const database = new DocumentDatabaseService(state.root, registry, dependencies.pages, writer)
    return {
      layers: new CalendarLayersService(state.root, registry, database, writer, dependencies.pages),
      reading: new LibrarySessions(state.root, registry),
    }
  }
}
