import type { IpcMain } from 'electron'
import { z } from 'zod'
import { PageOperationSchema, PagePropertiesSchema, PageRootSchema, type PageResult } from '../../../shared/document-pages'
import { DocumentPageService } from './service'

export function registerDocumentPagesIPC(ipcMain: Pick<IpcMain,'handle'>, service: DocumentPageService,
  ready: Promise<void>, authorize: (path: string) => void): void {
  const reply = async <T>(work: () => T | Promise<T>): Promise<PageResult<T>> => {
    try { await ready; return { ok: true, value: await work() } }
    catch (error) {
      return { ok: false, message: String(error), code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'page_failed',
        ...(error instanceof Error && 'candidateNames' in error ? { candidateNames: z.array(z.string()).parse(error.candidateNames) } : {}) }
    }
  }
  const id = (value: unknown) => {
    const parsed = z.string().min(1).parse(value), row = service.registry.get(parsed)
    if (!row) throw new Error('Object not found')
    authorize(row.current_path ?? row.last_known_path)
    return parsed
  }
  ipcMain.handle('documentPages:tree', (_e, input: unknown) => reply(() => { const root = PageRootSchema.parse(input); authorize(root.path); return service.tree(root) }))
  ipcMain.handle('documentPages:properties', (_e, input: unknown) => reply(() => service.properties(id(input))))
  ipcMain.handle('documentPages:patchProperties', (_e, input: unknown, version: unknown, fields: unknown, remove: unknown) => reply(() => service.patchProperties(id(input), z.string().min(1).parse(version), PagePropertiesSchema.parse(fields), z.array(z.enum(['title','icon','cover','ready_page'])).optional().parse(remove))))
  ipcMain.handle('documentPages:operate', (_e, input: unknown) => reply(() => { const request = PageOperationSchema.parse(input); authorize(request.root); if (request.type === 'adopt') authorize(request.source); return service.operate(request) }))
  ipcMain.handle('documentPages:operation', (_e, input: unknown) => reply(() => service.operation(z.string().min(1).parse(input))))
  ipcMain.handle('documentPages:trash', (_e, input: unknown) => reply(() => { const root = z.string().min(1).parse(input); authorize(root); return service.trash(root) }))
  ipcMain.handle('documentPages:order', (_e, parent: unknown, ids: unknown) => reply(() => service.order(id(parent), z.array(z.string().min(1)).parse(ids).map(id))))
  ipcMain.handle('documentPages:favorite', (_e, input: unknown, value: unknown) => reply(() => service.favorite(id(input), z.boolean().parse(value))))
  ipcMain.handle('documentPages:visit', (_e, input: unknown) => reply(() => service.visit(id(input))))
  ipcMain.handle('documentPages:states', () => reply(() => service.states()))
  ipcMain.handle('documentPages:save', (_e, input: unknown) => reply(() => {
    const parsed = z.object({ path: z.string().min(1), content: z.string(), expectedVersion: z.string().min(1) }).strict().parse(input)
    authorize(parsed.path); return service.save(parsed)
  }))
}
