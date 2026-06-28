import { ipcMain, type BrowserWindow } from 'electron'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
} from '../../../shared/browser-vertical-rail-overlay'
import { VerticalRailOverlayWindow } from './vertical-rail-overlay-window'

interface VerticalRailOverlayIPCOptions {
  getMainWindow: () => BrowserWindow | null
  preloadPath: string
  rendererFile: string
}

interface IPCResult<T = void> {
  success: boolean
  error?: string
  data?: T
}

let overlayWindow: VerticalRailOverlayWindow | null = null

function getOverlayWindow(options: VerticalRailOverlayIPCOptions): VerticalRailOverlayWindow | null {
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (!overlayWindow) {
    overlayWindow = new VerticalRailOverlayWindow({
      mainWindow,
      preloadPath: options.preloadPath,
      rendererFile: options.rendererFile,
    })
    return overlayWindow
  }
  overlayWindow.setMainWindow(mainWindow)
  return overlayWindow
}

export function setupBrowserVerticalRailOverlayIPC(options: VerticalRailOverlayIPCOptions): void {
  ipcMain.handle('browser:verticalRailOverlayShow', async (_, snapshot: VerticalRailOverlaySnapshot): Promise<IPCResult> => {
    try {
      const overlay = getOverlayWindow(options)
      if (!overlay) return { success: false, error: '主窗口不可用' }
      await overlay.show(snapshot)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:verticalRailOverlayHide', (): IPCResult => {
    try {
      overlayWindow?.hide()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:verticalRailOverlayGetSnapshot', (): IPCResult<VerticalRailOverlaySnapshot | null> => {
    try {
      return { success: true, data: overlayWindow?.getSnapshot() ?? null }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Forward commands from the overlay renderer to the main window renderer.
  ipcMain.handle('browser:verticalRailOverlayCommand', (_, command: VerticalRailOverlayCommand): IPCResult => {
    try {
      const mainWindow = options.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: '主窗口不可用' }
      mainWindow.webContents.send('browser:verticalRailOverlayCommand', command)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
