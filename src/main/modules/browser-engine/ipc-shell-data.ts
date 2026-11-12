import type { IpcMain } from 'electron'
import { browserTabRequestSchema } from '../../../shared/browser-shell'
import type { BrowserSuggestionService } from './suggestion-service'
import type { BrowserPageToolsService } from './page-tools-service'

export function setupBrowserShellDataIPC(ipcMain: Pick<IpcMain, 'handle'>, pages: BrowserPageToolsService, suggestions: BrowserSuggestionService): void {
  ipcMain.handle('browser:suggest', (_event, input: unknown) => suggestions.suggest(input))
  ipcMain.handle('browser:findInPage', (_event, input: unknown) => pages.find(input))
  ipcMain.handle('browser:stopFindInPage', (_event, input: unknown) => pages.stopFind(input))
  ipcMain.handle('browser:getPageCapabilities', (_event, input: unknown) => pages.capabilities(browserTabRequestSchema.parse(input).tabId))
  ipcMain.handle('browser:readTab', (_event, input: unknown) => pages.read(browserTabRequestSchema.parse(input).tabId))
}
