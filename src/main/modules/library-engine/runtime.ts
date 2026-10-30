import { join } from 'node:path'
import { BookSourceService } from './source-service'
import { registerBookSourceIPC } from './source-ipc'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { getDatabase } from '../database'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { VaultService } from '../settings-engine/vault-service'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { applyDocumentOperation } from '../document-engine/document-write-service'
import { LibraryHighlightService } from './highlight-service'
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

export function setupLibraryIPC(): void {
  const db = getDatabase().getRawDb()
  if (!db) throw new Error('Library database unavailable')
  const vault = new VaultService(new AppSettingsRepository(), {
    home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged,
  })
  const engine = new LibraryEngine({
    vault: () => vault.get(),
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
  registerLibraryIPC(ipcMain, {
    engine, reading: new LibraryReadingRepository(db), changed,
    highlights: new LibraryHighlightService(engine, { write: async input => {
      const root = engine.vaultRoot()
      if (!root) throw new Error('请先配置可用的资料库')
      const search = getSearchEngine()
      if (!search) throw new Error('文档索引尚未就绪')
      search.getRepository().ensureWorkspace(root)
      return applyDocumentOperation(input)
    } }),
    pickFiles: async () => {
      const result = await dialog.showOpenDialog({ title: '导入书籍', properties: ['openFile', 'multiSelections'], filters: [{ name: '电子书', extensions: [...formats] }] })
      return result.canceled ? [] : result.filePaths
    },
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
    openExternal: url => shell.openExternal(url),
  })
  activeBookSources = sources
  registerBookSourceIPC(ipcMain, sources)
  const stopWatching = watchLibrary(engine, changed, error => console.error('[library] change notification failed', error))
  app.once('before-quit', () => { void stopWatching().catch(error => console.error('[library] watcher shutdown failed', error)) })
}
