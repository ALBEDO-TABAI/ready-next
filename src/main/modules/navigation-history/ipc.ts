import type { IpcMain } from 'electron'
import type { NavigationHistoryRepository } from './repository'
import { NavigationStateSchema, BrowserNavigationPositionSchema, type BrowserNavigationPosition } from '../../../shared/navigation-history'

export function registerNavigationHistoryIPC(ipcMain: Pick<IpcMain, 'handle'>, repository: NavigationHistoryRepository, browser: { read(): Promise<BrowserNavigationPosition | null>; restore(position: BrowserNavigationPosition): Promise<void> }): void {
  ipcMain.handle('navigationHistory:browserPosition', () => browser.read())
  ipcMain.handle('navigationHistory:restoreBrowserPosition', (_event, input: unknown) => browser.restore(BrowserNavigationPositionSchema.parse(input)))
  ipcMain.handle('navigationHistory:read', () => repository.read())
  ipcMain.handle('navigationHistory:save', (_event, state: unknown) => repository.save(NavigationStateSchema.parse(state)))
}
