import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { CanvasIdSchema, Sha256Schema } from '../../../shared/ready-canvas'
import { CanvasImportService, ImportSchema } from '../canvas-import/service'
import { CanvasService } from './canvas-service'
import { BufferSchema, CreateSchema, WriteSchema } from './schema'
import { MoveCardsSchema, UndoMoveSchema } from './card-moves'
import type { SubBoardCoordinator } from './sub-boards'
import { importStillroomSpace, type StillroomImportResult } from './stillroom-entry'

export interface CanvasServices { canvas: CanvasService; imports: CanvasImportService; subBoards: SubBoardCoordinator }
const StillroomSchema = z.strictObject({ operationId: CanvasIdSchema, objectId: CanvasIdSchema, handleId: CanvasIdSchema, expectedVersion: Sha256Schema, at: z.strictObject({ x: z.number().int(), y: z.number().int() }) })
export function registerCanvasIPC(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Promise<CanvasServices>,
  authorize: (event: IpcMainInvokeEvent, path: string) => void,
  /** The system file dialog for a Stillroom space (the person's pick is the authorization to read it). */
  chooseStillroom: (event: IpcMainInvokeEvent) => Promise<string | null> = async () => null): void {
  const reply = async <T>(event: IpcMainInvokeEvent, work: (service: CanvasService, imports: CanvasImportService, subBoards: SubBoardCoordinator) => T | Promise<T>) => {
    try { const { canvas, imports, subBoards } = await resolve(); authorize(event, canvas.root); return { ok: true, value: await work(canvas, imports, subBoards) } }
    catch (error) { return { ok: false, error: String(error) } }
  }
  ipcMain.handle('canvas:create', (event, input: unknown) => reply(event, service => service.create(CreateSchema.parse(input))))
  ipcMain.handle('canvas:open', (event, input: unknown) => reply(event, service => service.open(CanvasIdSchema.parse(input))))
  ipcMain.handle('canvas:read', (event, input: unknown) => reply(event, service => service.read(CanvasIdSchema.parse(input))))
  ipcMain.handle('canvas:release', (event, input: unknown) => reply(event, service => service.release(CanvasIdSchema.parse(input))))
  // Writes go through the sub-board coordinator: a sub-board file follows its card in and out of the bin (M4 §9.3).
  ipcMain.handle('canvas:write', (event, input: unknown) => reply(event, (_service, _imports, subBoards) => subBoards.write(WriteSchema.parse(input))))
  ipcMain.handle('canvas:moveCards', (event, input: unknown) => reply(event, (_service, _imports, subBoards) => subBoards.moveCards(MoveCardsSchema.parse(input))))
  ipcMain.handle('canvas:undoMove', (event, input: unknown) => reply(event, (_service, _imports, subBoards) => subBoards.undoMove(UndoMoveSchema.parse(input))))
  ipcMain.handle('canvas:subBoards', (event, input: unknown) => reply(event, (_service, _imports, subBoards) => subBoards.summaries(CanvasIdSchema.parse(input))))
  ipcMain.handle('canvas:importStillroom', (event, input: unknown) => reply(event, async (service, imports, subBoards) => {
    const request = StillroomSchema.parse(input), sourcePath = await chooseStillroom(event)
    return sourcePath ? importStillroomSpace({ canvas: service, imports, subBoards }, { ...request, sourcePath }) : null
  }))
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
  /** 下载为 ZIP: the files themselves of the chosen cards (or the whole board), sub-boards as folders; Main asks where to save. */
  downloadZip(input: import('../../../shared/ready-canvas').CanvasDownloadRequest): Promise<import('../../../shared/ready-canvas').CanvasDownloadResult>
  create(input: z.input<typeof CreateSchema>): Promise<CanvasResult<Awaited<ReturnType<CanvasService['create']>>>>
  open(objectId: string): Promise<CanvasResult<Awaited<ReturnType<CanvasService['open']>>>>
  read(handleId: string): Promise<CanvasResult<Awaited<ReturnType<CanvasService['read']>>>>
  release(handleId: string): Promise<CanvasResult<void>>
  write(input: Parameters<CanvasService['write']>[0]): Promise<CanvasResult<Awaited<ReturnType<CanvasService['write']>>>>
  /** Cards change boards between a board and its sub-board, or into a new sub-board (M4 §9.1). */
  moveCards(input: z.input<typeof MoveCardsSchema>): Promise<CanvasResult<Awaited<ReturnType<SubBoardCoordinator['moveCards']>>>>
  undoMove(input: z.input<typeof UndoMoveSchema>): Promise<CanvasResult<Awaited<ReturnType<SubBoardCoordinator['undoMove']>>>>
  subBoards(parentObjectId: string): Promise<CanvasResult<ReturnType<SubBoardCoordinator['summaries']>>>
  /** Pick a Stillroom space (ZIP or autosave JSON) and bring it in as a sub-board of this board; null when cancelled. */
  importStillroom(input: z.input<typeof StillroomSchema>): Promise<CanvasResult<StillroomImportResult | null>>
  updateBuffer(input: z.input<typeof BufferSchema>): Promise<CanvasResult<void>>
  readBuffer(objectId: string): Promise<CanvasResult<ReturnType<CanvasService['buffer']>>>
  saveBuffer(input: Parameters<CanvasService['saveBuffer']>[0]): Promise<CanvasResult<Awaited<ReturnType<CanvasService['saveBuffer']>>>>
  prepareAttachment(path: string): Promise<CanvasResult<string>>
  import(input: z.input<typeof ImportSchema>): Promise<CanvasResult<Awaited<ReturnType<CanvasImportService['import']>>>>
  onChanged(listener: (event: { root: string }) => void): () => void
}
