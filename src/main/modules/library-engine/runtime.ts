import { LibraryArchiveImporter } from './archive-import'
import { registerLibraryArchiveIPC } from './archive-ipc'
import { join } from 'node:path'
import { BookSourceService } from './source-service'
import { registerBookSourceIPC } from './source-ipc'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { getDatabase } from '../database'
import { ObjectRegistry } from '../object-service/registry'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { VaultService } from '../settings-engine/vault-service'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { applyDocumentOperation } from '../document-engine/document-write-service'
import { SourceDocumentService } from './source-documents'
import { LibraryEngine } from './library-engine'
import { LibraryReadingRepository } from './reading-repository'
import { registerLibraryIPC } from './ipc-handler'
import { watchLibrary } from './changes'
import { formats } from './validation'
import type { LibraryState } from '../../../shared/library'

let activeBookSources: BookSourceService | undefined

/** Must be awaited by the app quit owner before closing ready.db. */
export async function shutdownLibrarySources(): Promise<void> {
  if (activeBookSources) { await activeBookSources.ready; await activeBookSources.jobs.shutdown() }
}

export function setupLibraryIPC() {
  const db = getDatabase().getRawDb()
  if (!db) throw new Error('Library database unavailable')
  const vault = new VaultService(new AppSettingsRepository(), {
    home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged,
  })
  const engine = new LibraryEngine({
    vault: () => vault.get(),
    registry: new ObjectRegistry(db),
    write: async (input) => {
      const state = vault.get()
      if (state.status !== 'ready') throw Object.assign(new Error('请先配置可用的资料库'), { code: 'no_vault' })
      // The shared writer indexes its result; a newly configured vault may not have been opened as a workspace yet.
      const search = getSearchEngine()
      if (!search) throw new Error('文档索引尚未就绪')
      search.getRepository().ensureWorkspace(state.root)
      return applyDocumentOperation(input)
    },
  })
  const changed = (state: LibraryState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('library:changed', state)
    }
  }
  const reading = new LibraryReadingRepository(db)
  const highlights = SourceDocumentService.books(engine, { write: async input => {
    const root = engine.vaultRoot()
    if (!root) throw new Error('请先配置可用的资料库')
    const search = getSearchEngine()
    if (!search) throw new Error('文档索引尚未就绪')
    search.getRepository().ensureWorkspace(root)
    return applyDocumentOperation(input)
  } })
  registerLibraryIPC(ipcMain, {
    engine, reading, changed,
    highlights,
    pickFiles: async () => {
      const result = await dialog.showOpenDialog({ title: '导入书籍', properties: ['openFile', 'multiSelections'], filters: [{ name: '电子书', extensions: [...formats] }] })
      return result.canceled ? [] : result.filePaths
    },
  })
  const suggestion = join(app.getPath('appData'), 'Ready Library', 'library')
  registerLibraryArchiveIPC(ipcMain, {
    engine, importer: new LibraryArchiveImporter(engine, reading, highlights), changed, suggestion,
    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({ title: '选择藏书阁数据目录（包含 library.json）', properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    confirm: async directory => (await dialog.showMessageBox({ type: 'question', title: '从藏书阁导入',
      message: '将书籍和阅读记录复制到当前资料库？', detail: `${directory}\n原目录保持不变。已导入的书籍会跳过。`,
      buttons: ['取消', '导入'], defaultId: 0, cancelId: 0 })).response === 1,
  })
  const sources = new BookSourceService({
    db, cache: join(app.getPath('userData'), 'Cache', 'book-sources'), engine,
    settings: new AppSettingsRepository(),
    changed: jobs => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('librarySources:changed', jobs)
      }
    },
    libraryChanged: async () => changed(await engine.get()),
  })
  activeBookSources = sources
  registerBookSourceIPC(ipcMain, sources)
  const stopWatching = watchLibrary(engine, changed, error => console.error('[library] change notification failed', error))
  app.once('before-quit', () => { void stopWatching().catch(error => console.error('[library] watcher shutdown failed', error)) })
  return { engine, reading }
}
