import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DraftResult } from '../../../shared/document-drafts'
import { CanvasComposeInputSchema, CanvasPreviewInputSchema } from '../../../shared/document-drafts'
import type { CanvasCompositionService } from './service'

/** F resolves the active vault and authorizes the sender before returning its service. */
export function registerCanvasCompositionIPC(ipcMain: Pick<IpcMain, 'handle'>,
  authorizedService: (event: IpcMainInvokeEvent) => Promise<CanvasCompositionService>): void {
  const reply = async <T>(event: IpcMainInvokeEvent, work: (service: CanvasCompositionService) => T | Promise<T>): Promise<DraftResult<T>> => {
    try { return { ok: true, value: await work(await authorizedService(event)) } }
    catch (error) { return { ok: false,
      code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'composition_failed',
      message: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle('canvasComposition:compose', (event, input: unknown) => reply(event, service => service.compose(CanvasComposeInputSchema.parse(input))))
  ipcMain.handle('canvasComposition:recover', event => reply(event, service => service.recover()))
  ipcMain.handle('canvasComposition:preview', (event, input: unknown) => reply(event, service => service.preview(CanvasPreviewInputSchema.parse(input))))
}
