import type { IpcMain } from 'electron'
import type { TodayService } from './service'
export function registerTodayIPC(ipcMain: Pick<IpcMain, 'handle'>, service: TodayService): void {
  ipcMain.handle('today:firstScreen', () => service.firstScreen())
  ipcMain.handle('today:sieve', () => service.sieve())
}
