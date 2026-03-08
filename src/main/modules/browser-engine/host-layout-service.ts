import { BrowserView, BrowserWindow, WebContentsView } from 'electron'

import { type BrowserHostKind, type BrowserHostView, type BrowserRect } from './host-types'

export class BrowserHostLayoutService {
  private appliedBoundsByView = new WeakMap<BrowserHostView, string>()
  private pendingBoundsByView = new WeakMap<BrowserHostView, BrowserRect>()
  private boundsFlushTimers = new WeakMap<BrowserHostView, ReturnType<typeof setTimeout>>()
  private hostKindByView = new WeakMap<BrowserHostView, BrowserHostKind>()
  private attachedHosts = new WeakSet<BrowserHostView>()
  private hiddenHosts = new WeakSet<BrowserHostView>()
  private readonly offscreenBounds: BrowserRect = { x: -100000, y: -100000, width: 1, height: 1 }

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly browserHostKind: BrowserHostKind,
  ) {}

  createHost(partition: string): BrowserHostView {
    const options = {
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition,
        spellcheck: true,
        webSecurity: true,
      },
    }
    const view = this.browserHostKind === 'webContentsView'
      ? new WebContentsView(options)
      : new BrowserView(options)
    this.hostKindByView.set(view, this.browserHostKind)
    return view
  }

  detachHost(view: BrowserHostView): void {
    if (!this.attachedHosts.has(view)) return
    const timer = this.boundsFlushTimers.get(view)
    if (timer) {
      clearTimeout(timer)
      this.boundsFlushTimers.delete(view)
    }
    const kind = this.hostKindByView.get(view) || 'browserView'
    try {
      if (kind === 'webContentsView') {
        this.mainWindow.contentView.removeChildView(view as WebContentsView)
      } else {
        this.mainWindow.removeBrowserView(view as BrowserView)
      }
    } catch {
      // ignore detached host errors
    }
    this.attachedHosts.delete(view)
    this.hiddenHosts.delete(view)
  }

  showHost(view: BrowserHostView, bounds: BrowserRect): void {
    this.attachHost(view)
    this.hiddenHosts.delete(view)
    this.pendingBoundsByView.set(view, bounds)
    this.scheduleHostBounds(view, bounds)
  }

  hideHost(view: BrowserHostView): void {
    this.attachHost(view)
    this.hiddenHosts.add(view)
    this.pendingBoundsByView.set(view, this.offscreenBounds)
    this.setHostBoundsNow(view, this.offscreenBounds)
  }

  applyBounds(view: BrowserHostView, bounds: BrowserRect): void {
    this.pendingBoundsByView.set(view, bounds)
    if (this.hiddenHosts.has(view)) return
    this.scheduleHostBounds(view, bounds)
  }

  isHostAttached(view: BrowserHostView): boolean {
    return this.attachedHosts.has(view)
  }

  isHostHidden(view: BrowserHostView): boolean {
    return this.hiddenHosts.has(view)
  }

  isHostVisible(view: BrowserHostView): boolean {
    return this.attachedHosts.has(view) && !this.hiddenHosts.has(view)
  }

  private attachHost(view: BrowserHostView): void {
    if (this.attachedHosts.has(view)) return
    const kind = this.hostKindByView.get(view) || 'browserView'
    if (kind === 'webContentsView') {
      this.mainWindow.contentView.addChildView(view as WebContentsView)
    } else {
      this.mainWindow.addBrowserView(view as BrowserView)
    }
    this.attachedHosts.add(view)
  }

  private setHostBoundsNow(view: BrowserHostView, bounds: BrowserRect): void {
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
    if (this.appliedBoundsByView.get(view) === key) return
    view.setBounds(bounds)
    this.appliedBoundsByView.set(view, key)
  }

  private scheduleHostBounds(view: BrowserHostView, bounds: BrowserRect): void {
    this.pendingBoundsByView.set(view, bounds)
    const existing = this.boundsFlushTimers.get(view)
    if (existing) return
    const timer = setTimeout(() => {
      this.boundsFlushTimers.delete(view)
      const pending = this.pendingBoundsByView.get(view)
      if (!pending) return
      this.setHostBoundsNow(view, pending)
    }, 24)
    this.boundsFlushTimers.set(view, timer)
  }
}
