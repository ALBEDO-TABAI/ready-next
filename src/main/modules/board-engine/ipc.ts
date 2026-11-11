import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { CanvasIdSchema } from '../../../shared/ready-canvas'
import { CanvasImportService, ImportSchema } from '../canvas-import/service'
import { CanvasService } from './canvas-service'
import { BufferSchema, CreateSchema, WriteSchema } from './schema'

export interface CanvasServices { canvas: CanvasService; imports: CanvasImportService }
export function registerCanvasIPC(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Promise<CanvasServices>,
  authorize: (event: IpcMainInvokeEvent, path: string) => void): void {
  const reply = async <T>(event: IpcMainInvokeEvent, work: (service: CanvasService, imports: CanvasImportService) => T | Promise<T>) => {
    try { const { canvas, imports } = await resolve(); authorize(event, canvas.root); return { ok: true, value: await work(canvas, imports) } }
    catch (error) { return { ok: false, error: String(error) } }
  }
  ipcMain.handle('canvas:create', (event, input: unknown) => reply(event, service => service.create(CreateSchema.parse(input))))
  ipcMain.handle('canvas:open', (event, input: unknown) => reply(event, service => service.open(CanvasIdSchema.parse(input))))
  ipcMain.handle('canvas:read', (event, input: unknown) => reply(event, service => service.read(CanvasIdSchema.parse(input))))
  ipcMain.handle('canvas:release', (event, input: unknown) => reply(event, service => service.release(CanvasIdSchema.parse(input))))
  ipcMain.handle('canvas:write', (event, input: unknown) => reply(event, service => service.write(WriteSchema.parse(input))))
  ipcMain.handle('canvas:updateBuffer', (event, input: unknown) => reply(event, service => service.updateBuffer(BufferSchema.parse(input))))
  ipcMain.handle('canvas:readBuffer', (event, input: unknown) => reply(event, service => service.buffer(CanvasIdSchema.parse(input))))
  ipcMain.handle('canvas:saveBuffer', (event, input: unknown) => reply(event, service => service.saveBuffer(z.strictObject({ objectId: CanvasIdSchema, handleId: CanvasIdSchema, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), operationId: CanvasIdSchema }).parse(input))))
  ipcMain.handle('canvas:prepareAttachment', (event, input: unknown) => reply(event, service => {
    const path = z.string().min(1).parse(input); authorize(event, path); return service.prepareAttachment(path)
  }))
  ipcMain.handle('canvas:import', (event, input: unknown) => reply(event, (service, imports) => {
    const request = ImportSchema.parse(input); authorize(event, request.sourcePath)
    if (request.mediaDirectory) authorize(event, request.mediaDirectory)
    return imports.import(request)
  }))
}

export type CanvasResult<T> = { ok: true; value: T } | { ok: false; error: string }
export interface CanvasAPI {
  exportImage(input: import('../../../shared/ready-canvas/export-image').CanvasExportImageRequest): Promise<import('../../../shared/ready-canvas/export-image').CanvasExportImageResult>
  create(input: z.input<typeof CreateSchema>): Promise<CanvasResult<Awaited<ReturnType<CanvasService['create']>>>>
  open(objectId: string): Promise<CanvasResult<Awaited<ReturnType<CanvasService['open']>>>>
  read(handleId: string): Promise<CanvasResult<Awaited<ReturnType<CanvasService['read']>>>>
  release(handleId: string): Promise<CanvasResult<void>>
  write(input: Parameters<CanvasService['write']>[0]): Promise<CanvasResult<Awaited<ReturnType<CanvasService['write']>>>>
  updateBuffer(input: z.input<typeof BufferSchema>): Promise<CanvasResult<void>>
  readBuffer(objectId: string): Promise<CanvasResult<ReturnType<CanvasService['buffer']>>>
  saveBuffer(input: Parameters<CanvasService['saveBuffer']>[0]): Promise<CanvasResult<Awaited<ReturnType<CanvasService['saveBuffer']>>>>
  prepareAttachment(path: string): Promise<CanvasResult<string>>
  import(input: z.input<typeof ImportSchema>): Promise<CanvasResult<Awaited<ReturnType<CanvasImportService['import']>>>>
  onChanged(listener: (event: { root: string }) => void): () => void
}
