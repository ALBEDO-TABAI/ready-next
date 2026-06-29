import { BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { VerticalRailOverlaySnapshot } from '../../../shared/browser-vertical-rail-overlay'
import { VERTICAL_RAIL_FLYOUT_MIN_HEIGHT } from '../../../shared/vertical-rail-flyout-layout'

interface VerticalRailOverlayWindowOptions {
  mainWindow: BrowserWindow
  preloadPath: string
  rendererFile: string
}

const OVERLAY_WIDTH = 248

export class VerticalRailOverlayWindow {
  private window: BrowserWindow | null = null
  private snapshot: VerticalRailOverlaySnapshot | null = null
  private boundParentWindow: BrowserWindow | null = null

  constructor(private options: VerticalRailOverlayWindowOptions) {
    this.bindParentWindow(this.options.mainWindow)
  }

  setMainWindow(mainWindow: BrowserWindow): void {
    this.options.mainWindow = mainWindow
    this.bindParentWindow(mainWindow)
    if (this.snapshot && this.window && !this.window.isDestroyed()) {
      this.applyBounds(this.snapshot)
    }
  }

  async show(snapshot: VerticalRailOverlaySnapshot): Promise<void> {
    this.snapshot = snapshot
    const window = await this.ensureWindow()
    if (this.snapshot !== snapshot) {
      if (!this.snapshot && !window.isDestroyed()) window.hide()
      return
    }
    this.applyBounds(snapshot)
    if (!window.isVisible()) window.showInactive()
    window.webContents.send('browser:verticalRailOverlaySnapshot', snapshot)
  }

  hide(): void {
    this.snapshot = null
    if (this.window && !this.window.isDestroyed()) this.window.hide()
  }

  sendSnapshot(): void {
    if (!this.window || this.window.isDestroyed()) return
    if (!this.snapshot) {
      if (this.window.isVisible()) this.window.hide()
      return
    }
    this.window.webContents.send('browser:verticalRailOverlaySnapshot', this.snapshot)
  }

  getSnapshot(): VerticalRailOverlaySnapshot | null {
    return this.snapshot
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
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
      height: 400,
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
      await this.window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/browser-vertical-rail-overlay`)
    } else {
      await this.window.loadFile(this.options.rendererFile, { hash: '/browser-vertical-rail-overlay' })
    }

    return this.window
  }

  private applyBounds(snapshot: VerticalRailOverlaySnapshot): void {
    if (!this.window || this.window.isDestroyed()) return
    const mainBounds = this.options.mainWindow.getContentBounds()
    const display = screen.getDisplayMatching(mainBounds)
    const width = OVERLAY_WIDTH
    const height = Math.max(VERTICAL_RAIL_FLYOUT_MIN_HEIGHT, Math.round(snapshot.bounds.height))
    // Sit flush to the RIGHT of the icon rail (bounds.left + rail width). The rail icons stay
    // visible in the main window; the overlay extends each icon's label outward.
    const x = mainBounds.x + Math.round(snapshot.bounds.left + snapshot.bounds.width)
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
