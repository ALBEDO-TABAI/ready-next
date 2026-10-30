import type { IpcMain } from 'electron'
import { z } from 'zod'
import type { LibraryResult } from '../../../shared/library'
import type { BookSourceService } from './source-service'
export function registerBookSourceIPC(ipcMain: Pick<IpcMain, 'handle'>, service: BookSourceService): void {
  const result = async <T>(work: () => T | Promise<T>): Promise<LibraryResult<T>> => {
    try { await service.ready; return { success: true, data: await work() } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
  const id = (input: unknown) => z.string().uuid().parse(input)
  ipcMain.handle('librarySources:settings', () => result(() => service.settings()))
  ipcMain.handle('librarySources:configure', (_event, input: unknown) => result(() => service.configure(input)))
  ipcMain.handle('librarySources:status', () => result(() => service.status()))
  ipcMain.handle('librarySources:search', (_event, input: unknown) => result(() => service.search(input)))
  ipcMain.handle('librarySources:categories', () => result(() => service.categories()))
  ipcMain.handle('librarySources:jobs', () => result(() => service.jobs.list()))
  ipcMain.handle('librarySources:download', (_event, input: unknown) => result(() => service.start(input)))
  ipcMain.handle('librarySources:cancel', (_event, input: unknown) => result(() => service.jobs.cancel(id(input))))
  ipcMain.handle('librarySources:retry', (_event, input: unknown) => result(() => service.retry(id(input))))
  ipcMain.handle('librarySources:openManual', (_event, input: unknown) => result(() => service.openManual(id(input))))
  ipcMain.handle('librarySources:answer', (_event, input: unknown) => result(() => {
    const answer = z.object({ id: z.string().uuid(), token: z.string().uuid(), text: z.string().trim().min(1).max(16) }).strict().parse(input)
    service.jobs.answer(answer.id, answer.token, answer.text)
  }))
}
