export class BrowserPopupProtection {
  private readonly activeCountByTab = new Map<string, number>()
  private readonly pendingTabByContents = new Map<number, string>()

  constructor(private readonly onChange?: (tabId: string) => void) {}

  isProtected(tabId: string): boolean {
    return (this.activeCountByTab.get(tabId) ?? 0) > 0
      || [...this.pendingTabByContents.values()].includes(tabId)
  }

  markPending(sourceContentsId: number, tabId: string | null | undefined): void {
    this.clearPending(sourceContentsId)
    if (!tabId) return
    this.pendingTabByContents.set(sourceContentsId, tabId)
    this.onChange?.(tabId)
  }

  clearPending(sourceContentsId: number): void {
    const tabId = this.pendingTabByContents.get(sourceContentsId)
    if (!tabId) return
    this.pendingTabByContents.delete(sourceContentsId)
    this.onChange?.(tabId)
  }

  beginPopup(tabId: string | null | undefined): () => void {
    if (!tabId) return () => undefined
    this.activeCountByTab.set(tabId, (this.activeCountByTab.get(tabId) ?? 0) + 1)
    this.onChange?.(tabId)
    let released = false
    return () => {
      if (released) return
      released = true
      const next = Math.max(0, (this.activeCountByTab.get(tabId) ?? 0) - 1)
      if (next === 0) this.activeCountByTab.delete(tabId)
      else this.activeCountByTab.set(tabId, next)
      this.onChange?.(tabId)
    }
  }
}
