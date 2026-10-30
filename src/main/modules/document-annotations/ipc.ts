import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { VaultService } from '../settings-engine/vault-service'
import type { DocumentPageService } from '../document-pages/service'
import { AnnotationCommandSchema, TemplateCommandSchema } from '../../../shared/document-comments'
import type { PageResult } from '../../../shared/document-pages'
import { DocumentTemplateService } from '../document-templates/service'
import { AnnotationStorage } from './storage'
import { DocumentAnnotationService } from './service'

export function registerDocumentAnnotationsIPC(ipcMain: Pick<IpcMain, 'handle'>, dependencies: {
  vault: Pick<VaultService, 'get'>; pages: DocumentPageService; ready: Promise<void>
}) {
  const services = new Map<string, { annotations: DocumentAnnotationService; templates: DocumentTemplateService; recovered: Promise<void> }>()
  const service = async () => {
    await dependencies.ready
    const state = dependencies.vault.get()
    if (state.status !== 'ready') throw new Error('请先配置资料库')
    let current = services.get(state.root)
    if (!current) {
      const storage = new AnnotationStorage(state.root)
      const templates = new DocumentTemplateService(storage, dependencies.pages), recovered = templates.recover()
      recovered.catch(error => console.error('[templates] recovery failed', error))
      current = { annotations: new DocumentAnnotationService(storage, dependencies.pages.registry), templates, recovered }
      services.set(state.root, current)
    }
    return current
  }
  const reply = async <T>(work: () => Promise<T>): Promise<PageResult<T>> => {
    try { return { ok: true, value: await work() } }
    catch (error) { return { ok: false, code: 'annotation_failed', message: String(error) } }
  }
  ipcMain.handle('documentAnnotations:comments', (_event, input: unknown) => reply(async () => (await service()).annotations.comments(AnnotationCommandSchema.parse(input))))
  ipcMain.handle('documentAnnotations:synced', (_event, input: unknown) => reply(async () => {
    const request = z.object({ path: z.string().min(1), raw: z.string() }).strict().parse(input)
    return (await service()).annotations.synced(request.path, request.raw)
  }))
  ipcMain.handle('documentAnnotations:templates', (_event, input: unknown) => reply(async () => { const context = await service(); await context.recovered; return context.templates.execute(TemplateCommandSchema.parse(input)) }))
}
