import electron, { type BrowserWindow, type IpcMain } from 'electron'
import { getDatabase, assertDatabaseConnectionReady } from '../database'
import { FastCardCollectionService } from '../fastcard/collection-service'
import { FastCardMediaCache } from '../fastcard/media-cache'
import { FastCardRepository } from '../repositories/fastcard-repository'
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
import type { FastCardOverlayWindow } from './fastcard-overlay-window'

interface BrowserFastCardIPCOptions {
  ipc?: Pick<IpcMain, 'handle'>
  getRepository?: () => FastCardRepository
  getMediaCache?: () => FastCardMediaCache
  getMainWindow: () => BrowserWindow | null
  preloadPath: string
  rendererFile: string
}

let overlayWindow: FastCardOverlayWindow | null = null
let overlayRequest = 0

async function getOverlayWindow(options: BrowserFastCardIPCOptions): Promise<FastCardOverlayWindow | null> {
  const { FastCardOverlayWindow } = await import('./fastcard-overlay-window')
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
  const ipcMain = options.ipc ?? electron.ipcMain
  const getRepository = options.getRepository ?? (() => {
    const db = getDatabase().getRawDb()
    assertDatabaseConnectionReady(db, 'FastCard database')
    return new FastCardRepository(db)
  })
  let collection: FastCardCollectionService | undefined
  const getCollection = () => collection ??= new FastCardCollectionService(getRepository(), options.getMediaCache?.() ?? new FastCardMediaCache(electron.app.getPath('userData')))
  const receipt = <T>(action: (payload: unknown) => T) => (_: unknown, payload: unknown): FastCardIPCResult<T> => {
    try {
      const data = action(payload)
      return data === undefined ? { success: true } : { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  // Literal channel names keep these handlers visible to the IPC contract gate.
  ipcMain.handle('browser:fastCardList', async () => {
    try { return { success: true, data: await getCollection().list() } }
    catch (error) { return { success: false, error: String(error) } }
  })
  ipcMain.handle('browser:fastCardAdd', async (_, payload: unknown) => {
    try { return { success: true, data: await getCollection().add(payload) } }
    catch (error) { return { success: false, error: String(error) } }
  })
  ipcMain.handle('browser:fastCardRemove', receipt((payload) => getRepository().remove(payload)))
  ipcMain.handle('browser:fastCardClear', receipt(() => getRepository().clear()))

  ipcMain.handle(
    'browser:fastCardTranslateSelection',
    async (_, payload: FastCardTranslateRequest): Promise<FastCardIPCResult<FastCardTranslateResult>> => {
      try {
        const { translateFastCardSelection } = await import('./fastcard-ai-service')
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
        const { describeFastCardImage } = await import('./fastcard-ai-service')
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
        const { resolveFastCardVideo } = await import('./fastcard-video-resolver')
        return { success: true, data: await resolveFastCardVideo(payload) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle('browser:fastCardOverlayShow', async (_, snapshot: FastCardOverlaySnapshot): Promise<FastCardIPCResult<void>> => {
    const request = ++overlayRequest
    try {
      const overlay = await getOverlayWindow(options)
      if (request !== overlayRequest) return { success: true }
      if (!overlay) return { success: false, error: '主窗口不可用' }
      await overlay.show(snapshot)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:fastCardOverlayHide', (): FastCardIPCResult<void> => {
    try {
      overlayRequest++
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
