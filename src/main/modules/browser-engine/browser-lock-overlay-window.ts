import { BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { BrowserLockOverlaySnapshot } from '../../../shared/browser-lock-overlay'

interface BrowserLockOverlayWindowOptions {
  mainWindow: BrowserWindow
  preloadPath: string
  rendererFile: string
}

const LOCK_OVERLAY_WIDTH = 304
const LOCK_OVERLAY_HEIGHT = 58
const LOCK_OVERLAY_GAP = 12

export class BrowserLockOverlayWindow {
  private window: BrowserWindow | null = null
  private snapshot: BrowserLockOverlaySnapshot | null = null
  private boundParentWindow: BrowserWindow | null = null

  constructor(private options: BrowserLockOverlayWindowOptions) {
    this.bindParentWindow(this.options.mainWindow)
  }

  setMainWindow(mainWindow: BrowserWindow): void {
    this.options.mainWindow = mainWindow
    this.bindParentWindow(mainWindow)
    if (this.snapshot && this.window && !this.window.isDestroyed()) {
      this.applyBounds(this.snapshot)
    }
  }

  async show(snapshot: BrowserLockOverlaySnapshot): Promise<void> {
    this.snapshot = snapshot
    const window = await this.ensureWindow()
    if (this.snapshot !== snapshot) {
      if (!this.snapshot && !window.isDestroyed()) window.hide()
      return
    }
    this.applyBounds(snapshot)
    window.setAlwaysOnTop(true, 'floating')
    if (!window.isVisible()) window.showInactive()
    window.moveTop()
    window.webContents.send('browser:lockOverlaySnapshot', snapshot)
  }

  hide(): void {
    this.snapshot = null
    if (this.window && !this.window.isDestroyed()) {
      this.window.setAlwaysOnTop(false)
      this.window.hide()
    }
  }

  getSnapshot(): BrowserLockOverlaySnapshot | null {
    return this.snapshot
  }

  sendSnapshot(): void {
    if (!this.window || this.window.isDestroyed()) return
    if (!this.snapshot) {
      if (this.window.isVisible()) this.window.hide()
      return
    }
    this.window.webContents.send('browser:lockOverlaySnapshot', this.snapshot)
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    if (this.boundParentWindow && !this.boundParentWindow.isDestroyed()) {
      this.boundParentWindow.off('move', this.handleParentMoveOrResize)
      this.boundParentWindow.off('resize', this.handleParentMoveOrResize)
      this.boundParentWindow.off('closed', this.handleParentClosed)
    }
    this.boundParentWindow = null
    this.window = null
    this.snapshot = null
  }

  private bindParentWindow(mainWindow: BrowserWindow): void {
    if (this.boundParentWindow === mainWindow) return
    if (this.boundParentWindow && !this.boundParentWindow.isDestroyed()) {
      this.boundParentWindow.off('move', this.handleParentMoveOrResize)
      this.boundParentWindow.off('resize', this.handleParentMoveOrResize)
      this.boundParentWindow.off('closed', this.handleParentClosed)
    }
    this.boundParentWindow = mainWindow
    mainWindow.on('move', this.handleParentMoveOrResize)
    mainWindow.on('resize', this.handleParentMoveOrResize)
    mainWindow.on('closed', this.handleParentClosed)
  }

  private handleParentMoveOrResize = (): void => {
    if (this.snapshot && this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.applyBounds(this.snapshot)
    }
  }

  private handleParentClosed = (): void => {
    this.destroy()
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window

    this.window = new BrowserWindow({
      width: LOCK_OVERLAY_WIDTH,
      height: LOCK_OVERLAY_HEIGHT,
      show: false,
      parent: this.options.mainWindow,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      hasShadow: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      trafficLightPosition: { x: -1000, y: -1000 },
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    this.window.setIgnoreMouseEvents(true, { forward: true })
    if (process.platform === 'darwin') {
      this.window.setWindowButtonVisibility(false)
    }

    this.window.on('closed', () => {
      this.window = null
    })
    this.window.webContents.on('did-finish-load', () => this.sendSnapshot())

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await this.window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/browser-lock-overlay`)
    } else {
      await this.window.loadFile(this.options.rendererFile, { hash: '/browser-lock-overlay' })
    }

    return this.window
  }

  private applyBounds(snapshot: BrowserLockOverlaySnapshot): void {
    if (!this.window || this.window.isDestroyed()) return
    const mainBounds = this.options.mainWindow.getContentBounds()
    const display = screen.getDisplayMatching(mainBounds)
    const width = Math.min(LOCK_OVERLAY_WIDTH, Math.max(236, Math.round(snapshot.bounds.width - LOCK_OVERLAY_GAP * 2)))
    const height = LOCK_OVERLAY_HEIGHT
    const x = mainBounds.x + Math.round(snapshot.bounds.left + snapshot.bounds.width - width - LOCK_OVERLAY_GAP)
    const y = mainBounds.y + Math.round(snapshot.bounds.top + LOCK_OVERLAY_GAP)
    const maxX = display.workArea.x + display.workArea.width - width
    const maxY = display.workArea.y + display.workArea.height - height
    this.window.setBounds({
      x: Math.max(display.workArea.x, Math.min(x, maxX)),
      y: Math.max(display.workArea.y, Math.min(y, maxY)),
      width,
      height,
    })
  }
}
