import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { CanvasIdSchema } from '../../../shared/ready-canvas'
import { CanvasImportService, ImportSchema } from '../canvas-import/service'
import { CanvasService } from './canvas-service'
import { BufferSchema, CreateSchema, WriteSchema } from './schema'

/** F supplies recovery readiness and the application's existing sender/resource authorization. */
export function registerCanvasIPC(ipc: Pick<IpcMain, 'handle'>, service: CanvasService, imports: CanvasImportService,
  ready: Promise<void>, authorize: (event: IpcMainInvokeEvent, path: string) => void): void {
  const reply = async <T>(event: IpcMainInvokeEvent, work: () => T | Promise<T>) => {
    try { await ready; authorize(event, service.root); return { ok: true, value: await work() } }
    catch (error) { return { ok: false, error: String(error) } }
  }
  ipc.handle('canvas:create', (event, input: unknown) => reply(event, () => service.create(CreateSchema.parse(input))))
  ipc.handle('canvas:open', (event, input: unknown) => reply(event, () => service.open(CanvasIdSchema.parse(input))))
  ipc.handle('canvas:read', (event, input: unknown) => reply(event, () => service.read(CanvasIdSchema.parse(input))))
  ipc.handle('canvas:release', (event, input: unknown) => reply(event, () => service.release(CanvasIdSchema.parse(input))))
  ipc.handle('canvas:write', (event, input: unknown) => reply(event, () => service.write(WriteSchema.parse(input))))
  ipc.handle('canvas:updateBuffer', (event, input: unknown) => reply(event, () => service.updateBuffer(BufferSchema.parse(input))))
  ipc.handle('canvas:readBuffer', (event, input: unknown) => reply(event, () => service.buffer(CanvasIdSchema.parse(input))))
  ipc.handle('canvas:saveBuffer', (event, input: unknown) => reply(event, () => service.saveBuffer(z.strictObject({ objectId: CanvasIdSchema, handleId: CanvasIdSchema, expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), operationId: CanvasIdSchema }).parse(input))))
  ipc.handle('canvas:prepareAttachment', (event, input: unknown) => reply(event, () => {
    const path = z.string().min(1).parse(input); authorize(event, path); return service.prepareAttachment(path)
  }))
  ipc.handle('canvas:import', (event, input: unknown) => reply(event, () => {
    const request = ImportSchema.parse(input); authorize(event, request.sourcePath)
    if (request.mediaDirectory) authorize(event, request.mediaDirectory)
    return imports.import(request)
  }))
}
