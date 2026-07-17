import { BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { BrowserAgentPointerSnapshot } from '../../../shared/browser-agent-pointer'
import { OverlayWindowFollower } from './overlay-window-follower'

interface BrowserAgentPointerWindowOptions {
  mainWindow: BrowserWindow
  preloadPath: string
  rendererFile: string
}

export class BrowserAgentPointerWindow {
  private window: BrowserWindow | null = null
  private snapshot: BrowserAgentPointerSnapshot | null = null
  private boundParentWindow: BrowserWindow | null = null
  private readonly follower = new OverlayWindowFollower({
    apply: () => this.reposition(),
    getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
    onDisplayMetricsChanged: (listener) => screen.on('display-metrics-changed', listener),
    offDisplayMetricsChanged: (listener) => screen.off('display-metrics-changed', listener),
  })

  constructor(private options: BrowserAgentPointerWindowOptions) {
    this.bindParentWindow(options.mainWindow)
  }

  setMainWindow(mainWindow: BrowserWindow): void {
    this.options.mainWindow = mainWindow
    this.bindParentWindow(mainWindow)
  }

  async show(snapshot: BrowserAgentPointerSnapshot): Promise<void> {
    this.snapshot = snapshot
    const window = await this.ensureWindow()
    if (this.snapshot !== snapshot || window.isDestroyed()) return
    this.applyBounds(snapshot)
    window.setAlwaysOnTop(true, 'floating')
    if (!window.isVisible()) window.showInactive()
    window.moveTop()
    window.webContents.send('browser:agentPointerSnapshot', snapshot)
  }

  hide(): void {
    this.snapshot = null
    this.follower.cancel()
    if (this.window && !this.window.isDestroyed()) {
      this.window.setAlwaysOnTop(false)
      this.window.hide()
    }
  }

  getSnapshot(): BrowserAgentPointerSnapshot | null {
    return this.snapshot
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    if (this.boundParentWindow && !this.boundParentWindow.isDestroyed()) {
      this.boundParentWindow.off('move', this.handleParentMoveOrResize)
      this.boundParentWindow.off('resize', this.handleParentMoveOrResize)
      this.boundParentWindow.off('closed', this.handleParentClosed)
    }
    this.window = null
    this.snapshot = null
    this.boundParentWindow = null
    this.follower.dispose()
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
    this.follower.schedule()
  }

  private reposition(): void {
    if (this.snapshot && this.window?.isVisible()) this.applyBounds(this.snapshot)
  }

  private handleParentClosed = (): void => this.destroy()

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
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
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.window.setIgnoreMouseEvents(true, { forward: true })
    if (process.platform === 'darwin') this.window.setWindowButtonVisibility(false)
    this.window.on('closed', () => { this.window = null })
    this.window.webContents.on('did-finish-load', () => {
      if (this.snapshot) this.window?.webContents.send('browser:agentPointerSnapshot', this.snapshot)
    })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await this.window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/browser-agent-pointer`)
    } else {
      await this.window.loadFile(this.options.rendererFile, { hash: '/browser-agent-pointer' })
    }
    return this.window
  }

  private applyBounds(snapshot: BrowserAgentPointerSnapshot): void {
    if (!this.window || this.window.isDestroyed()) return
    const mainBounds = this.options.mainWindow.getContentBounds()
    const display = this.follower.displayFor(mainBounds)
    const width = Math.max(1, Math.round(snapshot.bounds.width))
    const height = Math.max(1, Math.round(snapshot.bounds.height))
    const desiredX = mainBounds.x + Math.round(snapshot.bounds.left)
    const desiredY = mainBounds.y + Math.round(snapshot.bounds.top)
    this.window.setBounds({
      x: Math.max(display.bounds.x, Math.min(desiredX, display.bounds.x + display.bounds.width - width)),
      y: Math.max(display.bounds.y, Math.min(desiredY, display.bounds.y + display.bounds.height - height)),
      width,
      height,
    })
  }
}
