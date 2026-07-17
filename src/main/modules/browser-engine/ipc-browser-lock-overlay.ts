import { ipcMain, type BrowserWindow } from 'electron'
import type {
  BrowserLockOverlayIPCResult,
  BrowserLockOverlaySnapshot,
} from '../../../shared/browser-lock-overlay'
import { BrowserLockOverlayWindow } from './browser-lock-overlay-window'
import { BrowserAgentPointerWindow } from './browser-agent-pointer-window'
import type { BrowserAgentPointerSnapshot } from '../../../shared/browser-agent-pointer'

interface BrowserLockOverlayIPCOptions {
  getMainWindow: () => BrowserWindow | null
  preloadPath: string
  rendererFile: string
}

let overlayWindow: BrowserLockOverlayWindow | null = null
let pointerWindow: BrowserAgentPointerWindow | null = null
let activeOptions: BrowserLockOverlayIPCOptions | null = null
let pointerRevision = 0
let pointerHideTimer: ReturnType<typeof setTimeout> | null = null

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

function getPointerWindow(options: BrowserLockOverlayIPCOptions): BrowserAgentPointerWindow | null {
  const mainWindow = options.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (!pointerWindow) {
    pointerWindow = new BrowserAgentPointerWindow({
      mainWindow,
      preloadPath: options.preloadPath,
      rendererFile: options.rendererFile,
    })
    return pointerWindow
  }
  pointerWindow.setMainWindow(mainWindow)
  return pointerWindow
}

export function publishBrowserAgentPointer(snapshot: Omit<BrowserAgentPointerSnapshot, 'revision' | 'occurredAt'>): void {
  const options = activeOptions
  if (!options) return
  if (pointerHideTimer) clearTimeout(pointerHideTimer)
  pointerHideTimer = null
  const pointer = getPointerWindow(options)
  if (!pointer) return
  void pointer.show({ ...snapshot, revision: ++pointerRevision, occurredAt: Date.now() })
}

export function clearBrowserAgentPointer(): void {
  if (pointerHideTimer) clearTimeout(pointerHideTimer)
  pointerHideTimer = null
  pointerWindow?.hide()
}

export function publishBrowserAgentActionLifecycle(phase: 'start' | 'finish' | 'abort'): void {
  overlayWindow?.noteAction(phase)
  if (pointerHideTimer) clearTimeout(pointerHideTimer)
  pointerHideTimer = null
  if (phase === 'start') return
  pointerHideTimer = setTimeout(() => {
    clearBrowserAgentPointer()
  }, 800)
}

export function setupBrowserLockOverlayIPC(options: BrowserLockOverlayIPCOptions): void {
  activeOptions = options
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

  ipcMain.handle('browser:lockOverlayDismiss', (): BrowserLockOverlayIPCResult<void> => {
    try {
      overlayWindow?.dismiss()
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

  ipcMain.handle('browser:agentPointerGetSnapshot', (): BrowserLockOverlayIPCResult<BrowserAgentPointerSnapshot | null> => {
    return { success: true, data: pointerWindow?.getSnapshot() ?? null }
  })
}
