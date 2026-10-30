import type { VaultService } from '../settings-engine/vault-service'
import type { DocumentPageService } from '../document-pages/service'
import type { DocumentWriteDependencies } from '../document-engine/document-write-service'
import { vaultRoot } from '../document-drafts/files'
import { DocumentDatabaseService } from './service'

/**
 * Database requests run against the active vault, after the page service's startup recovery. The service and its
 * read cache are kept while the vault stays the same; a switch builds a new one and never serves the old vault.
 */
export function createDocumentDatabaseResolver(dependencies: {
  vault: Pick<VaultService, 'get'>; pages: DocumentPageService; ready: Promise<void>
  writer(): DocumentWriteDependencies | null
}): () => Promise<DocumentDatabaseService> {
  let current: { service: DocumentDatabaseService; writer: DocumentWriteDependencies } | null = null
  return async () => {
    await dependencies.ready
    const state = dependencies.vault.get(), writer = dependencies.writer()
    if (state.status !== 'ready') throw new Error('请先配置可用的资料库')
    if (!writer) throw new Error('Document writer unavailable')
    if (current?.service.root !== vaultRoot(state.root) || current.writer !== writer) {
      dependencies.pages.registry.db.prepare('INSERT INTO workspaces(root) VALUES (?) ON CONFLICT(root) DO NOTHING').run(state.root)
      current = { service: new DocumentDatabaseService(state.root, dependencies.pages.registry, dependencies.pages, writer), writer }
    }
    return current.service
  }
}
