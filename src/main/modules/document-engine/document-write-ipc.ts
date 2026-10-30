import { ipcMain, type WebContents } from 'electron'
import { createDocumentTabTransport } from './document-write-transport'
import { parseDocumentSyncReply, type DocumentSyncReply } from '../../../shared/document-operations'
import { configureDocumentWriteService } from './document-write-service'
import { confirmDocumentIndex } from './document-index-confirmation'

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
  ipcMain.handle('document:registerOperationSync', async (event) => {
    if (!owners.has(event.sender.id)) {
      const id = event.sender.id
      owners.set(id, event.sender)
      event.sender.once('destroyed', () => {
        owners.delete(id)
        for (const item of pending.values()) if (item.owner === id) item.resolve({ ok: false, message: 'Document window closed' })
      })
    }
    const { getDatabase } = await import('../database')
    const { DocumentMarksRepository } = await import('./document-marks-repository')
    const db = getDatabase().getRawDb()
    if (db) await new DocumentMarksRepository(db).backfillPortableIdentities()
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
      await confirmDocumentIndex(getSearchEngine(), path, content)
    },
  })
}
