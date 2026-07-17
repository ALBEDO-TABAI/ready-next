import type { BrowserLockOverlaySnapshot } from '../../../shared/browser-lock-overlay'

export function resolveBrowserLockOverlayIdentity(snapshot: BrowserLockOverlaySnapshot): string {
  return snapshot.identity?.trim() || [snapshot.kind, snapshot.label, snapshot.detail].join(':')
}

export class BrowserLockOverlayVisibilityState {
  private currentIdentity: string | null = null
  private dismissedIdentity: string | null = null
  private terminalHiddenIdentity: string | null = null

  observe(snapshot: BrowserLockOverlaySnapshot): boolean {
    const identity = resolveBrowserLockOverlayIdentity(snapshot)
    this.currentIdentity = identity
    if (this.dismissedIdentity && this.dismissedIdentity !== identity) this.dismissedIdentity = null
    if (this.terminalHiddenIdentity && this.terminalHiddenIdentity !== identity) this.terminalHiddenIdentity = null
    return this.shouldShowCurrent()
  }

  dismissCurrent(): void {
    this.dismissedIdentity = this.currentIdentity
  }

  beginAction(): boolean {
    this.terminalHiddenIdentity = null
    return this.shouldShowCurrent()
  }

  finishAction(snapshot?: BrowserLockOverlaySnapshot | null): void {
    this.terminalHiddenIdentity = snapshot
      ? resolveBrowserLockOverlayIdentity(snapshot)
      : this.currentIdentity
  }

  reset(): void {
    this.currentIdentity = null
    this.dismissedIdentity = null
    this.terminalHiddenIdentity = null
  }

  private shouldShowCurrent(): boolean {
    return Boolean(
      this.currentIdentity
      && this.dismissedIdentity !== this.currentIdentity
      && this.terminalHiddenIdentity !== this.currentIdentity
    )
  }
}
