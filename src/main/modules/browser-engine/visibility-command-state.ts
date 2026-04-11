export class BrowserVisibilityCommandState {
  private latestRequestId = 0
  private presented = true

  applyHide(requestId?: number | null): boolean {
    if (!this.accept(requestId)) return false
    this.presented = false
    return true
  }

  applyShow(requestId?: number | null): boolean {
    if (!this.accept(requestId)) return false
    this.presented = true
    return true
  }

  shouldPresentHosts(): boolean {
    return this.presented
  }

  private accept(requestId?: number | null): boolean {
    const normalized = Number(requestId || 0)
    if (!Number.isFinite(normalized) || normalized <= 0) {
      return true
    }
    if (normalized < this.latestRequestId) {
      return false
    }
    this.latestRequestId = normalized
    return true
  }
}
