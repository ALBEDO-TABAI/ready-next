import { ipcMain, type WebContents } from 'electron'
import { createDocumentTabTransport } from './document-write-transport'
import { parseDocumentSyncReply, type DocumentSyncReply } from '../../../shared/document-operations'
import { buildSearchIndexContentHash } from '../search-engine/adapters'
import { configureDocumentWriteService, documentWriteError } from './document-write-service'

const owners = new Map<number, WebContents>()
const pending = new Map<string, { owner: number; resolve(reply: DocumentSyncReply): void }>()
let sequence = 0

const transport = createDocumentTabTransport(() => [...owners.values()].map((owner) => ({
  id: owner.id,
  request: (request) => new Promise<DocumentSyncReply>((resolve) => {
    const requestId = `${request.id}:${++sequence}`
    const finish = (reply: DocumentSyncReply) => { clearTimeout(timer); pending.delete(requestId); resolve(reply) }
    const timer = setTimeout(() => finish({ ok: false, message: 'Document synchronization timed out' }), Math.max(1, request.deadline - Date.now()))
    pending.set(requestId, { owner: owner.id, resolve: finish })
    try { owner.send('document:operationSync', { requestId, request }) } catch (error) { finish({ ok: false, message: String(error) }) }
  }),
})))

export function setupDocumentWriteIPC(): void {
  ipcMain.removeHandler('document:registerOperationSync')
  ipcMain.handle('document:registerOperationSync', (event) => {
    if (!owners.has(event.sender.id)) {
      const id = event.sender.id
      owners.set(id, event.sender)
      event.sender.once('destroyed', () => {
        owners.delete(id)
        for (const item of pending.values()) if (item.owner === id) item.resolve({ ok: false, message: 'Document window closed' })
      })
    }
  })
  ipcMain.removeAllListeners('document:operationSyncReply')
  ipcMain.on('document:operationSyncReply', (event, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || !('requestId' in payload) || typeof payload.requestId !== 'string') return
    const item = pending.get(payload.requestId)
    if (item?.owner === event.sender.id) {
      try { item.resolve(parseDocumentSyncReply('reply' in payload ? payload.reply : undefined)) } catch (error) { item.resolve({ ok: false, message: String(error) }) }
    }
  })
  configureDocumentWriteService({
    tabs: transport,
    index: async (path, content) => {
      const { getSearchEngine } = await import('../search-engine/ipc-handler')
      const engine = getSearchEngine()
      const root = engine?.findWorkspaceRootForPath(path)
      if (!engine || !root) throw new Error('Document search workspace unavailable')
      const result = await engine.indexDocument(root, path, content)
      if (!result.ok) throw documentWriteError('write_failed', result.error || 'Document index update failed')
      const row = engine.getRepository().getConnection().prepare('SELECT d.content_hash AS hash FROM documents d JOIN workspaces w ON w.id=d.workspace_id WHERE w.root=? AND d.path=?').get<{ hash: string }>(root, path)
      if (row?.hash !== buildSearchIndexContentHash(content)) throw documentWriteError('readback_mismatch', 'Document index readback mismatch')
    },
  })
}
