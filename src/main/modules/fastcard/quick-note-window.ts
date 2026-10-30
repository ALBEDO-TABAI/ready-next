import { BrowserWindow } from 'electron'

/** Dedicated window: browser overlay snapshots and page changes must not replace an active recording. */
export class FastCardQuickNoteWindow {
  private window: BrowserWindow | null = null
  private loading: Promise<void> | null = null
  constructor(private readonly options: { preloadPath: string; rendererFile: string; rendererUrl?: string }) {}
  async show(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({ width: 440, height: 420, show: false, frame: false, resizable: true,
        title: 'Ready Next · 快记', webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false } })
      this.window = window
      // Closing while recording/saving is controlled by the renderer's receipt-aware Close button.
      window.on('close', event => event.preventDefault())
      window.on('closed', () => { this.window = null; this.loading = null })
      const route = '/browser-fastcard-overlay?quick-note=1'
      this.loading = this.options.rendererUrl ? window.loadURL(`${this.options.rendererUrl}/#${route}`)
        : window.loadFile(this.options.rendererFile, { hash: route })
    }
    try { await this.loading }
    catch (error) { this.destroy(); throw error }
    if (!this.window || this.window.isDestroyed()) throw new Error('快记窗口已关闭')
    this.window.show(); this.window.focus()
  }
  hide(): void { this.window?.hide() }
  destroy(): void { this.window?.destroy(); this.window = null; this.loading = null }
}
