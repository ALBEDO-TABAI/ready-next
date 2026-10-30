import { app, ipcMain } from 'electron'
import { getDatabase } from '../database'
import { ObjectRegistry } from '../object-service/registry'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { VaultService } from '../settings-engine/vault-service'
import { registerDocumentDraftIPC } from './ipc'
import { DocumentDraftService, type DraftDependencies } from './service'

export function setupDocumentDraftIPC(completeCanvas?: DraftDependencies['completeCanvas']): DocumentDraftService {
  const db = getDatabase().getRawDb()
  if (!db) throw new Error('Draft database unavailable')
  const vault = new VaultService(new AppSettingsRepository(), {
    home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged,
  })
  const service = new DocumentDraftService(db, {
    completeCanvas,
    registry: new ObjectRegistry(db),
    index: async (root, path) => {
      const search = getSearchEngine()
      if (!search) throw new Error('文档索引尚未就绪')
      search.getRepository().ensureWorkspace(root)
      const result = await search.indexDocument(root, path)
      if (!result.ok) throw new Error(result.error ?? '草稿定稿索引失败')
    },
  })
  registerDocumentDraftIPC(ipcMain, service, () => vault.get())
  return service
}
