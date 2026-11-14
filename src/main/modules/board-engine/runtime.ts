import { homedir } from 'node:os'
import { registerCanvasImageExportIPC } from './export-image'
import { fastCardBoardPort } from './fastcard-board-port'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain } from 'electron'
import { getDatabase } from '../database'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { FastCardRepository } from '../repositories/fastcard-repository'
import { VaultService } from '../settings-engine/vault-service'
import { canonicalObjectPath, isInside, ObjectRegistry } from '../object-service/registry'
import { CanvasService } from './canvas-service'
import { registerCanvasIPC } from './ipc'
import { SubBoardCoordinator, type SubBoardPages } from './sub-boards'
import { createCanvasResolver } from './resolver'
import { CanvasImportService } from '../canvas-import/service'
import { CanvasCompositionService } from '../canvas-composition/service'
import { registerCanvasCompositionIPC } from '../canvas-composition/ipc'
import { setupDocumentDraftIPC } from '../document-drafts/runtime'
import { hashBytes } from '../document-drafts/files'
import { FastCardMediaCache } from '../fastcard/media-cache'
import { FastCardCollectionService } from '../fastcard/collection-service'
import { FastCardTransferService } from '../fastcard/transfer-service'
import { FastCardQuickNoteService } from '../fastcard/quick-note-service'
import { FastCardQuickNoteWindow } from '../fastcard/quick-note-window'
import { registerFastCardServicesIPC } from '../fastcard/ipc'
import { copyFastCardImage } from '../fastcard/document-image'

export function setupCanvasRuntime(ready: Promise<void>, paths: { preloadPath: string; rendererFile: string; rendererUrl?: string }, pages: SubBoardPages) {
  const db = getDatabase().getRawDb()
  if (!db) throw new Error('Canvas database unavailable')
  const vault = new VaultService(new AppSettingsRepository(), { home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged })
  const registry = new ObjectRegistry(db), repository = new FastCardRepository(db), cache = new FastCardMediaCache(app.getPath('userData'))
  const collection = new FastCardCollectionService(repository, cache)
  const quickWindow = new FastCardQuickNoteWindow(paths)
  const quickNote = new FastCardQuickNoteService({
    register: (key, callback) => globalShortcut.register(key, callback), unregister: key => globalShortcut.unregister(key),
    show: () => quickWindow.show(), hide: () => quickWindow.hide(),
    readClipboard: async () => { const image = (await clipboard.read()).find(item => item.types.includes('image/png')); return image ? { kind: 'image', bytes: Buffer.from(await (await image.getType('image/png')).arrayBuffer()) } : { kind: 'text', text: await clipboard.readText() } },
    notify: status => { if (!status.registered) dialog.showErrorBox('快记', status.error) },
  }, collection, repository, cache)
  const drafts = setupDocumentDraftIPC(async (draft, receipt, keep) => (await resolve()).composition.complete(draft, receipt, keep))
  const resolve = createCanvasResolver({ ready, root: () => { const state = vault.get(); return state.status === 'ready' ? canonicalObjectPath(state.root) : null }, create: root => {
    const canvas = new CanvasService(registry, root, { changed: () => changed() })
    const imports = new CanvasImportService(canvas), composition = new CanvasCompositionService(canvas, drafts), subBoards = new SubBoardCoordinator(canvas, pages)
    const changed = () => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('canvas:changed', { root }) }
    const transfer = new FastCardTransferService(hashBytes(root), repository, cache, fastCardBoardPort(canvas))
    return { canvas, imports, composition, transfer, subBoards, async recover() {
      const results = await canvas.recover()
      if (results.some(result => result.state === 'recovery-required')) throw new Error('画板恢复尚未完成')
      await imports.recover(); await composition.recover(); await subBoards.recover()
      const transfers = await transfer.recover()
      for (const result of transfers) if (result.error) console.error('[canvas] transfer recovery', result)
    } }
  } })
  const authorize = (_event: Electron.IpcMainInvokeEvent, path: string) => {
    const state = vault.get()
    if (state.status !== 'ready' || !isInside(canonicalObjectPath(state.root), canonicalObjectPath(path))) throw new Error('路径不在当前资料库中')
  }
  registerCanvasIPC(ipcMain, resolve, authorize, async event => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: '选择 Stillroom 空间', properties: ['openFile'], filters: [{ name: 'Stillroom 空间', extensions: ['zip', 'json'] }] }
    const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })
  const exportWindow = (sender: Electron.WebContents) => {
    const window = BrowserWindow.fromWebContents(sender)
    if (!window || window.isDestroyed() || window.webContents !== sender) throw new Error('发起导出的窗口已不可用')
    return window
  }
  registerCanvasImageExportIPC(ipcMain, {
    contentSize: sender => { const [width, height] = exportWindow(sender).getContentSize(); return [width, height] },
    showSaveDialog: (sender, request) => dialog.showSaveDialog(exportWindow(sender), request),
    getFallbackExportDir: homedir,
  })
  registerCanvasCompositionIPC(ipcMain, async event => { const services = await resolve(); authorize(event, services.canvas.root); return services.composition })
  registerFastCardServicesIPC(ipcMain, { transfer: async () => (await resolve()).transfer, quickNote,
    documentImage: async input => copyFastCardImage(input, (await resolve()).canvas.root, registry, repository, cache) })
  // First-run setup may have no library. Requests resolve the newly configured library lazily.
  void ready.then(async () => { if (vault.get().status === 'ready') await resolve(); quickNote.start() }).catch(error => console.error('[canvas] startup recovery failed', error))
  return { drafts, repository, stop() { quickNote.stop(); quickWindow.destroy() } }
}
