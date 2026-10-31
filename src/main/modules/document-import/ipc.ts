import { dialog, type IpcMain } from 'electron'
import { z } from 'zod'
import { ImportKindSchema, ImportLocationSchema, type ImportReply } from '../../../shared/document-import'
import type { DocumentPageService } from '../document-pages/service'
import type { DocumentDatabaseService } from '../document-database/service'
import { DocumentImportService } from './service'

export function registerDocumentImportIPC(ipcMain: Pick<IpcMain, 'handle'>, dependencies: {
  pages: DocumentPageService; database(): Promise<DocumentDatabaseService>
}) {
  const services = new Map<string, DocumentImportService>()
  const service = async () => {
    const database = await dependencies.database()
    let current = services.get(database.root)
    if (!current) { current = new DocumentImportService(database.root, dependencies.pages, database); services.set(database.root, current) }
    return current
  }
  const reply = async <T>(work: () => Promise<T>): Promise<ImportReply<T>> => {
    try { return { ok: true, value: await work() } } catch (error) { return { ok: false, message: String(error) } }
  }
  ipcMain.handle('documentImport:choose', (_event, input: unknown) => reply(async () => {
    const kind = ImportKindSchema.parse(input), current = await service()
    const result = await dialog.showOpenDialog({ title: kind === 'notion' ? '选择 Notion Markdown & CSV 导出包' : '选择 Inkwell 工作区 JSON 备份', properties: ['openFile'], filters: [{ name: kind, extensions: [kind === 'notion' ? 'zip' : 'json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    if (await service() !== current) throw new Error('资料库已切换，请重新选择来源')
    return current.addSource(result.filePaths[0], kind)
  }))
  ipcMain.handle('documentImport:preflight', (_event, sourceId: unknown, target: unknown) => reply(async () => (await service()).preflight(z.string().parse(sourceId), target === undefined ? undefined : ImportLocationSchema.parse(target))))
  ipcMain.handle('documentImport:execute', (_event, id: unknown) => reply(async () => (await service()).execute(z.string().parse(id))))
  ipcMain.handle('documentImport:resume', (_event, id: unknown) => reply(async () => (await service()).resume(z.string().parse(id))))
  ipcMain.handle('documentImport:status', (_event, id: unknown) => reply(async () => (await service()).status(z.string().parse(id))))
  ipcMain.handle('documentImport:list', () => reply(async () => (await service()).list()))
}
