/**
 * EP1-I3-2 — Bridge between the confirmation gate (tool dispatch) and the
 * electron-coupled wiring that owns the SQLite handle.
 *
 * Mirrors `ask-user-questions-bridge.ts`: the dispatcher reads the store
 * from this module; production registers a DB-backed instance at
 * `setupAgentIPC` boot. Default is null — with no store registered the gate
 * falls back to the I3-1 placeholder denial (an unconfirmable M2/M3 call is
 * NEVER executed), which is also what headless unit tests observe.
 */

import type { FrozenCallStore } from './frozen-call-store'

let registeredStore: FrozenCallStore | null = null

export function registerFrozenCallStore(store: FrozenCallStore | null): void {
  registeredStore = store
}

export function getFrozenCallStore(): FrozenCallStore | null {
  return registeredStore
}

/** Test helper — drop back to the unwired default. */
export function _resetFrozenCallBridgeForTests(): void {
  registeredStore = null
}
