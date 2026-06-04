/**
 * Process-wide BrowserWriteLease singleton (counterplan WP1).
 *
 * The agent runner (acquire/heartbeat/release) and the Electron input layer
 * (recordUserSignal on real user interaction) must share ONE lease service, or
 * takeover detection cannot work. This module is that shared instance.
 *
 * `notifyUserTakeover` is the call site the Electron `before-input-event` /
 * navigation listeners invoke when they detect user-origin activity on the
 * user's BrowserView. Registering those listeners is the WP1 runtime spike;
 * this signal-handling path itself is plain code and is unit-tested.
 */

import { BrowserWriteLeaseService } from './browser-write-lease'
import type { AgentBrowserSurface } from './agent-browser-errors'
import type { UserSignalSource } from './browser-write-lease'

let instance: BrowserWriteLeaseService | null = null

export function getBrowserWriteLeaseService(): BrowserWriteLeaseService {
  if (!instance) instance = new BrowserWriteLeaseService()
  return instance
}

/** Electron input layer → takeover signal. Returns true if a takeover fired. */
export function notifyUserTakeover(
  source: UserSignalSource,
  surface: AgentBrowserSurface = 'user-view',
): boolean {
  return getBrowserWriteLeaseService().recordUserSignal({ surface, source })
}

/** Test-only: reset the singleton between tests. */
export function __resetBrowserWriteLeaseServiceForTests(): void {
  instance = null
}
