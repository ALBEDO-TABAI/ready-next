import { BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { FastCardOverlaySnapshot } from '../../../shared/fastcard'

interface FastCardOverlayWindowOptions {
  mainWindow: BrowserWindow
  preloadPath: string
  rendererFile: string
}

const OVERLAY_WIDTH = 384
const OVERLAY_GAP = 10
const OVERLAY_MIN_HEIGHT = 260

export class FastCardOverlayWindow {
  private window: BrowserWindow | null = null
  private snapshot: FastCardOverlaySnapshot | null = null
  private boundParentWindow: BrowserWindow | null = null

  constructor(private options: FastCardOverlayWindowOptions) {
    this.bindParentWindow(this.options.mainWindow)
  }

  setMainWindow(mainWindow: BrowserWindow): void {
    this.options.mainWindow = mainWindow
    this.bindParentWindow(mainWindow)
    if (this.snapshot && this.window && !this.window.isDestroyed()) {
      this.applyBounds(this.snapshot)
    }
  }

  async show(snapshot: FastCardOverlaySnapshot): Promise<void> {
    this.snapshot = snapshot
    const window = await this.ensureWindow()
    this.applyBounds(snapshot)
    if (!window.isVisible()) window.showInactive()
    window.webContents.send('browser:fastCardOverlaySnapshot', snapshot)
  }

  hide(): void {
    this.snapshot = null
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide()
    }
  }

  sendSnapshot(): void {
    if (!this.snapshot || !this.window || this.window.isDestroyed()) return
    this.window.webContents.send('browser:fastCardOverlaySnapshot', this.snapshot)
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
    this.reposition()
  }

  private handleParentClosed = (): void => {
    this.destroy()
  }

  private reposition(): void {
    if (!this.snapshot || !this.window || this.window.isDestroyed() || !this.window.isVisible()) return
    this.applyBounds(this.snapshot)
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window

    this.window = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_MIN_HEIGHT,
      show: false,
      parent: this.options.mainWindow,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
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

    if (process.platform === 'darwin') {
      this.window.setWindowButtonVisibility(false)
    }

    this.window.on('closed', () => {
      this.window = null
    })
    this.window.webContents.on('did-finish-load', () => this.sendSnapshot())

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await this.window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/browser-fastcard-overlay`)
    } else {
      await this.window.loadFile(this.options.rendererFile, { hash: '/browser-fastcard-overlay' })
    }

    return this.window
  }

  private applyBounds(snapshot: FastCardOverlaySnapshot): void {
    if (!this.window || this.window.isDestroyed()) return
    const mainBounds = this.options.mainWindow.getContentBounds()
    const display = screen.getDisplayMatching(mainBounds)
    const width = Math.min(OVERLAY_WIDTH, Math.max(300, Math.round(snapshot.bounds.width - OVERLAY_GAP * 2)))
    const height = Math.max(OVERLAY_MIN_HEIGHT, Math.round(snapshot.bounds.height))
    const x = mainBounds.x + Math.round(snapshot.bounds.left + snapshot.bounds.width - width - OVERLAY_GAP)
    const y = mainBounds.y + Math.round(snapshot.bounds.top)
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
