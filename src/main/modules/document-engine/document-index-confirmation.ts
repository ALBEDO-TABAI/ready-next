import { ObjectRegistry } from '../object-service/registry'
import { buildSearchIndexContentHash } from '../search-engine/adapters'
import { documentWriteError } from './document-write-service'

type IndexEngine = NonNullable<ReturnType<typeof import('../search-engine/ipc-handler')['getSearchEngine']>>

/** Index confirmation covers indexed files only; a file outside every workspace (or before the index starts) still saves. */
export async function confirmDocumentIndex(engine: IndexEngine | null | undefined, path: string, content: string): Promise<void> {
  const root = engine?.findWorkspaceRootForPath(path)
  if (!engine || !root) return
  const result = await engine.indexDocument(root, path, content)
  if (!result.ok) throw documentWriteError('write_failed', result.error || 'Document index update failed')
  const row = engine.getRepository().getConnection().prepare('SELECT d.content_hash AS hash FROM documents d WHERE d.object_id=?').get<{ hash: string }>(new ObjectRegistry(engine.getRepository().getConnection()).find(path)?.id ?? null)
  if (row?.hash !== buildSearchIndexContentHash(content)) throw documentWriteError('readback_mismatch', 'Document index readback mismatch')
}
