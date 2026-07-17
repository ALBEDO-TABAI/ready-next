/**
 * BrowserView intent boundary (Stage X4 PR-shell-1).
 *
 * Per plan §9 lines 616–653, the renderer must NOT directly toggle native
 * BrowserView visibility/bounds. Instead, every shell-level decision is
 * emitted as a declarative `BrowserViewIntent` on the `browser:intent`
 * IPC channel; the main side (`BrowserTabShellService.applyIntent`) is the
 * single decision point that maps an intent to actual BrowserView API
 * calls.
 *
 * This module is the SHARED contract — both renderer and main import the
 * same `Rect` type alias and `BrowserViewIntent` discriminated union so
 * no re-declaration drift can happen (plan §9 line 721 explicitly forbids
 * it).
 *
 * `intentId` is monotonically increasing. The renderer is the source of
 * truth for ordering; the main side echoes the id back on ack-bearing
 * intents (PR-shell-2 wires the ack round-trip for `hide-all`).
 */

export type Rect = { x: number; y: number; w: number; h: number }

export type HideAllReason = 'overlay-open' | 'mode-switch-prepare'
export type HideReason = 'mode-switch' | 'overlay-open' | 'tab-deactivate' | 'split-collapse'
export type ShowReason = 'mode-switch' | 'tab-activate' | 'split-promote'

export type BrowserViewIntent =
  | { kind: 'show'; intentId: number; tabId: string; bounds: Rect; reason: ShowReason; expectsAck?: true }
  | { kind: 'hide'; intentId: number; tabId: string; reason: HideReason; expectsAck?: true }
  | { kind: 'hide-all'; intentId: number; reason: HideAllReason; expectsAck?: true }
  | { kind: 'set-bounds'; intentId: number; tabId: string; bounds: Rect }
  | { kind: 'secondary-set-bounds'; intentId: number; tabId: string; bounds: Rect }

/**
 * Renderer-side monotonic counter. The renderer owns ordering; the main
 * side just echoes the id back on ack-bearing intents.
 */
let intentIdCounter = Date.now()
export function nextIntentId(): number {
  intentIdCounter += 1
  return intentIdCounter
}

/**
 * IPC channel name. Renderer → main (push, no return value besides ack).
 */
export const BROWSER_VIEW_INTENT_CHANNEL = 'browser:intent'

/**
 * Ack channel name (main → renderer). Carries `{ intentId }` echoing the
 * original intent. PR-shell-2 uses this for the `hide-all` round-trip
 * before mode-switch state flip.
 */
export const BROWSER_VIEW_INTENT_ACK_CHANNEL = 'browser:intent-ack'

export interface BrowserViewIntentAck {
  intentId: number
}
