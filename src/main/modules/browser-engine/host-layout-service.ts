import { BrowserWindow, WebContentsView } from 'electron'

import { parkedBrowserHostBounds, type BrowserHostView, type BrowserRect } from './host-types'
import { withHtmlInCanvasWebPreferences } from '../app-control/html-in-canvas-feature'

const HOST_BORDER_RADIUS = 18
export type BrowserHostPresentationState = 'visible' | 'parked' | 'hidden' | 'detached'

export class BrowserHostLayoutService {
  private appliedBoundsByView = new WeakMap<BrowserHostView, string>()
  private presentationByView = new WeakMap<BrowserHostView, BrowserHostPresentationState>()
  private readonly offscreenBounds: BrowserRect = { x: -100000, y: -100000, width: 1, height: 1 }

  constructor(private mainWindow: BrowserWindow) {}

  setMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.presentationByView = new WeakMap<BrowserHostView, BrowserHostPresentationState>()
  }

  createHost(partition: string): BrowserHostView {
    const options = {
      webPreferences: withHtmlInCanvasWebPreferences({
        nodeIntegration: false,
        contextIsolation: true,
        partition,
        spellcheck: true,
        webSecurity: true,
      }),
    }
    const view = new WebContentsView(options)
    try {
      view.setBorderRadius(HOST_BORDER_RADIUS)
    } catch {
      // Keep the page usable if a platform rejects the visual clipping hint.
    }
    return view
  }

  detachHost(view: BrowserHostView): void {
    if (this.getHostPresentationState(view) === 'detached') return
    try {
      this.mainWindow.contentView.removeChildView(view as WebContentsView)
    } catch {
      // ignore detached host errors
    }
    this.presentationByView.set(view, 'detached')
  }

  showHost(view: BrowserHostView, bounds: BrowserRect): void {
    if (this.getHostPresentationState(view) === 'visible') {
      this.setHostBoundsNow(view, bounds)
      return
    }
    if (this.getHostPresentationState(view) !== 'detached') {
      this.raiseHost(view)
    } else {
      this.attachHost(view)
    }
    this.presentationByView.set(view, 'visible')
    this.appliedBoundsByView.delete(view)
    this.setHostBoundsNow(view, bounds)
  }

  hideHost(view: BrowserHostView): void {
    if (this.getHostPresentationState(view) === 'detached') return
    this.presentationByView.set(view, 'hidden')
    this.setHostBoundsNow(view, this.offscreenBounds)
  }

  parkHost(view: BrowserHostView, bounds: BrowserRect): void {
    if (this.getHostPresentationState(view) === 'detached') this.attachHost(view)
    this.presentationByView.set(view, 'parked')
    this.setHostBoundsNow(view, parkedBrowserHostBounds(bounds))
  }

  applyBounds(view: BrowserHostView, bounds: BrowserRect): void {
    if (this.getHostPresentationState(view) !== 'visible') return
    this.setHostBoundsNow(view, bounds)
  }

  isHostAttached(view: BrowserHostView): boolean {
    return this.getHostPresentationState(view) !== 'detached'
  }

  isHostHidden(view: BrowserHostView): boolean {
    return this.getHostPresentationState(view) === 'hidden'
  }

  isHostVisible(view: BrowserHostView): boolean {
    return this.getHostPresentationState(view) === 'visible'
  }

  getHostPresentationState(view: BrowserHostView): BrowserHostPresentationState {
    return this.presentationByView.get(view) || 'detached'
  }

  private attachHost(view: BrowserHostView): void {
    if (this.getHostPresentationState(view) !== 'detached') return
    this.mainWindow.contentView.addChildView(view as WebContentsView)
    this.presentationByView.set(view, 'hidden')
  }

  private raiseHost(view: BrowserHostView): void {
    try {
      this.mainWindow.contentView.removeChildView(view as WebContentsView)
      this.mainWindow.contentView.addChildView(view as WebContentsView)
    } catch {
      // ignore host ordering failures; the bounds sync below still runs.
    }
  }

  private setHostBoundsNow(view: BrowserHostView, bounds: BrowserRect): void {
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
    if (this.appliedBoundsByView.get(view) === key) return
    view.setBounds(bounds)
    this.appliedBoundsByView.set(view, key)
  }
}
