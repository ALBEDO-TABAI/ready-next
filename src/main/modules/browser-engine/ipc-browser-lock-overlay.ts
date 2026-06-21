import { ipcMain, type BrowserWindow } from 'electron'
import type {
  BrowserLockOverlayIPCResult,
  BrowserLockOverlaySnapshot,
} from '../../../shared/browser-lock-overlay'
import { BrowserLockOverlayWindow } from './browser-lock-overlay-window'

interface BrowserLockOverlayIPCOptions {
  getMainWindow: () => BrowserWindow | null
  preloadPath: string
  rendererFile: string
}

let overlayWindow: BrowserLockOverlayWindow | null = null

function getOverlayWindow(options: BrowserLockOverlayIPCOptions): BrowserLockOverlayWindow | null {
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (!overlayWindow) {
    overlayWindow = new BrowserLockOverlayWindow({
      mainWindow,
      preloadPath: options.preloadPath,
      rendererFile: options.rendererFile,
    })
    return overlayWindow
  }
  overlayWindow.setMainWindow(mainWindow)
  return overlayWindow
}

export function setupBrowserLockOverlayIPC(options: BrowserLockOverlayIPCOptions): void {
  ipcMain.handle('browser:lockOverlayShow', async (_, snapshot: BrowserLockOverlaySnapshot): Promise<BrowserLockOverlayIPCResult<void>> => {
    try {
      const overlay = getOverlayWindow(options)
      if (!overlay) return { success: false, error: '主窗口不可用' }
      await overlay.show(snapshot)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:lockOverlayHide', (): BrowserLockOverlayIPCResult<void> => {
    try {
      overlayWindow?.hide()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:lockOverlayGetSnapshot', (): BrowserLockOverlayIPCResult<BrowserLockOverlaySnapshot | null> => {
    try {
      return { success: true, data: overlayWindow?.getSnapshot() ?? null }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
