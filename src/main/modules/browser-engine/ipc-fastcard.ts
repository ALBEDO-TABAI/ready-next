import { ipcMain, type BrowserWindow } from 'electron'
import type {
  FastCardOverlayCommand,
  FastCardOverlaySnapshot,
  FastCardDescribeImageRequest,
  FastCardDescribeImageResult,
  FastCardIPCResult,
  FastCardResolveVideoRequest,
  FastCardResolveVideoResult,
  FastCardTranslateRequest,
  FastCardTranslateResult,
} from '../../../shared/fastcard'
import { describeFastCardImage, translateFastCardSelection } from './fastcard-ai-service'
import { FastCardOverlayWindow } from './fastcard-overlay-window'
import { resolveFastCardVideo } from './fastcard-video-resolver'

interface BrowserFastCardIPCOptions {
  getMainWindow: () => BrowserWindow | null
  preloadPath: string
  rendererFile: string
}

let overlayWindow: FastCardOverlayWindow | null = null

function getOverlayWindow(options: BrowserFastCardIPCOptions): FastCardOverlayWindow | null {
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (!overlayWindow) {
    overlayWindow = new FastCardOverlayWindow({
      mainWindow,
      preloadPath: options.preloadPath,
      rendererFile: options.rendererFile,
    })
    return overlayWindow
  }
  overlayWindow.setMainWindow(mainWindow)
  return overlayWindow
}

export function setupBrowserFastCardIPC(options: BrowserFastCardIPCOptions): void {
  ipcMain.handle(
    'browser:fastCardTranslateSelection',
    async (_, payload: FastCardTranslateRequest): Promise<FastCardIPCResult<FastCardTranslateResult>> => {
      try {
        return { success: true, data: await translateFastCardSelection(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'browser:fastCardDescribeImage',
    async (_, payload: FastCardDescribeImageRequest): Promise<FastCardIPCResult<FastCardDescribeImageResult>> => {
      try {
        return { success: true, data: await describeFastCardImage(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'browser:fastCardResolveVideo',
    async (_, payload: FastCardResolveVideoRequest): Promise<FastCardIPCResult<FastCardResolveVideoResult>> => {
      try {
        return { success: true, data: await resolveFastCardVideo(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle('browser:fastCardOverlayShow', async (_, snapshot: FastCardOverlaySnapshot): Promise<FastCardIPCResult<void>> => {
    try {
      const overlay = getOverlayWindow(options)
      if (!overlay) return { success: false, error: '主窗口不可用' }
      await overlay.show(snapshot)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:fastCardOverlayHide', (): FastCardIPCResult<void> => {
    try {
      overlayWindow?.hide()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:fastCardOverlayGetSnapshot', (): FastCardIPCResult<FastCardOverlaySnapshot | null> => {
    try {
      return { success: true, data: overlayWindow?.getSnapshot() ?? null }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:fastCardOverlayCommand', (_, command: FastCardOverlayCommand): FastCardIPCResult<void> => {
    try {
      const mainWindow = options.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: '主窗口不可用' }
      mainWindow.webContents.send('browser:fastCardOverlayCommand', command)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
