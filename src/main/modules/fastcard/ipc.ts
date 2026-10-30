import type { IpcMain } from 'electron'
import { z } from 'zod'
import { FastCardTargetUnavailableError, type FastCardTransferService } from './transfer-service'
import type { FastCardQuickNoteService } from './quick-note-service'
import { getLinkPreview } from '../link-preview'

/** F registers once after the isolated userData/library guards and supplies B's library-scoped port. */
export function registerFastCardServicesIPC(ipcMain: Pick<IpcMain, 'handle'>, services: {
  transfer: () => Promise<FastCardTransferService>
  quickNote: FastCardQuickNoteService
}): void {
  const receipt = <T>(action: (input: unknown) => T | Promise<T>) => async (_event: unknown, input: unknown) => {
    try { return { success: true, data: await action(input) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof FastCardTargetUnavailableError ? { errorCode: error.code } : {}) } }
  }
  ipcMain.handle('fastcard:transfer', receipt(async input => (await services.transfer()).transfer(input)))
  ipcMain.handle('fastcard:undo', receipt(async input => (await services.transfer()).undo(z.string().parse(input))))
  ipcMain.handle('fastcard:targets', receipt(async () => (await services.transfer()).targets()))
  ipcMain.handle('fastcard:pending', receipt(async () => (await services.transfer()).pending()))
  ipcMain.handle('fastcard:quickClose', receipt(() => services.quickNote.close()))
  ipcMain.handle('fastcard:quickStatus', receipt(() => services.quickNote.getStatus()))
  ipcMain.handle('fastcard:quickText', receipt(input => {
    const parsed = z.strictObject({ text: z.string().max(1000000), itemId: z.string().min(1) }).parse(input)
    return services.quickNote.text(parsed.text, parsed.itemId)
  }))
  ipcMain.handle('fastcard:quickClipboard', receipt(input => services.quickNote.clipboard(z.string().min(1).parse(input))))
  ipcMain.handle('fastcard:quickRecording', receipt(input => {
    const parsed = z.strictObject({ bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength <= 50 * 1024 * 1024), mime: z.string(), itemId: z.string().min(1) }).parse(input)
    return services.quickNote.recording(Buffer.from(parsed.bytes), parsed.mime, parsed.itemId)
  }))
  ipcMain.handle('fastcard:transcribe', receipt(input => services.quickNote.transcribe(z.string().parse(input))))
  ipcMain.handle('fastcard:playback', receipt(input => services.quickNote.playback(z.string().parse(input))))
  ipcMain.handle('link-preview:get', receipt(input => getLinkPreview(z.string().max(8192).parse(input))))
}
