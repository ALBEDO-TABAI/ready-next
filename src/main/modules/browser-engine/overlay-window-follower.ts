interface OverlayDisplay {
  id: number
  bounds: Electron.Rectangle
  workArea: Electron.Rectangle
}

interface OverlayWindowFollowerDeps {
  apply: () => void
  getDisplayMatching: (bounds: Electron.Rectangle) => OverlayDisplay
  onDisplayMetricsChanged?: (listener: () => void) => void
  offDisplayMetricsChanged?: (listener: () => void) => void
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  frameMs?: number
}

export class OverlayWindowFollower {
  private timer: ReturnType<typeof setTimeout> | null = null
  private trailing = false
  private cachedDisplay: OverlayDisplay | null = null

  constructor(private readonly deps: OverlayWindowFollowerDeps) {
    this.deps.onDisplayMetricsChanged?.(this.invalidateDisplay)
  }

  schedule(): void {
    if (!this.timer) {
      this.deps.apply()
      const setTimer = this.deps.setTimeout ?? setTimeout
      this.timer = setTimer(() => {
        this.timer = null
        if (!this.trailing) return
        this.trailing = false
        this.deps.apply()
      }, Math.max(1, this.deps.frameMs ?? 16))
      return
    }
    this.trailing = true
  }

  displayFor(bounds: Electron.Rectangle): OverlayDisplay {
    const centerX = bounds.x + bounds.width / 2
    const centerY = bounds.y + bounds.height / 2
    const cached = this.cachedDisplay
    if (
      cached
      && centerX >= cached.bounds.x
      && centerX < cached.bounds.x + cached.bounds.width
      && centerY >= cached.bounds.y
      && centerY < cached.bounds.y + cached.bounds.height
    ) {
      return cached
    }
    this.cachedDisplay = this.deps.getDisplayMatching(bounds)
    return this.cachedDisplay
  }

  cancel(): void {
    if (this.timer) (this.deps.clearTimeout ?? clearTimeout)(this.timer)
    this.timer = null
    this.trailing = false
    this.cachedDisplay = null
  }

  dispose(): void {
    this.cancel()
    this.deps.offDisplayMetricsChanged?.(this.invalidateDisplay)
  }

  private invalidateDisplay = (): void => {
    this.cachedDisplay = null
  }
}
