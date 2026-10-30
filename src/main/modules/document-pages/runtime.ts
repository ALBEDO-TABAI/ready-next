import { app, BrowserWindow, ipcMain } from 'electron'
import { getDatabase } from '../database'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { VaultService } from '../settings-engine/vault-service'
import { ObjectRegistry, canonicalObjectPath, isInside } from '../object-service/registry'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { buildSearchIndexContentHash } from '../search-engine/adapters'
import { readFile } from 'node:fs/promises'
import { DocumentPageService } from './service'
import { registerDocumentPagesIPC } from './ipc'

export function setupDocumentPagesIPC() {
  const db = getDatabase().getRawDb()
  if (!db) throw new Error('Page database unavailable')
  const vault = new VaultService(new AppSettingsRepository(), { home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged })
  const registry = new ObjectRegistry(db)
  const service = new DocumentPageService(registry, { index: async path => {
    const search = getSearchEngine(), root = search?.findWorkspaceRootForPath(path)
    if (!search || !root) throw new Error('Page index is unavailable')
    const content = await readFile(path,'utf8'), result = await search.indexDocument(root,path,content)
    if (!result.ok) throw new Error(result.error ?? 'Page indexing failed')
    const stored = db.prepare('SELECT content_hash FROM documents WHERE object_id=?').get<{content_hash:string}>(registry.find(path)?.id)
    if (stored?.content_hash !== buildSearchIndexContentHash(content)) throw new Error('Page index readback mismatch')
  } })
  service.subscribe(event => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('documentPages:changed',event)
  })
  const recovery = service.recover()
  // Every handler awaits the same recovery barrier; failures stay visible and block further changes.
  recovery.catch(error => console.error('[pages] startup recovery failed',error))
  registerDocumentPagesIPC(ipcMain,service,recovery,path => {
    const state = vault.get()
    const roots = db.prepare('SELECT root FROM workspaces').all<{root:string}>().map(row => row.root)
    if (state.status === 'ready') roots.push(state.root)
    if (!roots.some(root => isInside(canonicalObjectPath(root),canonicalObjectPath(path)))) throw new Error('Path is outside open workspaces')
  })
  return { service, ready: recovery }
}
