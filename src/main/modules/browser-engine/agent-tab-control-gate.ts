/**
 * Immediate user takeover helpers for the agent browser tab.
 *
 * The exact target claim is the synchronous ownership truth. User input and
 * the supervision button transition that claim directly to `user_owned`.
 * There is deliberately no intermediate confirmation state: the same input
 * that expresses takeover must continue to the page instead of being swallowed.
 *
 * Pure module — no Electron, no IO.
 */

export interface AgentTabUserInputTakeoverHandlers {
  onKeyboardInput(event: unknown, input: { type?: string; key?: string }): void
  onMouseInput(event: unknown, input: { type?: string }): void
}

export function beginAgentTabUserTakeover(options: {
  isTakenOver: () => boolean
  fenceGroundedTasks: () => void
  recordLeaseTakeover: () => void
}): boolean {
  if (options.isTakenOver()) return false
  options.recordLeaseTakeover()
  options.fenceGroundedTasks()
  return true
}

export async function persistAgentTabUserTakeover(options: {
  persist: () => Promise<void>
  onPersisted: () => void
  onPersistenceFailure: (error: unknown) => void
}): Promise<boolean> {
  try {
    await options.persist()
  } catch (error) {
    // The physical user signal has already reached the page. Persistence
    // failure must keep the synchronous lease fence in place; rollback would
    // give the old agent write ownership over a page the user just changed.
    options.onPersistenceFailure(error)
    return false
  }
  options.onPersisted()
  return true
}

export function isAgentNavigationEcho(input: {
  signalSource: 'keyboard' | 'pointer' | 'navigation' | 'explicit-button'
  hasActiveAgentAction: boolean
}): boolean {
  return input.signalSource === 'navigation' && input.hasActiveAgentAction
}

/**
 * Shared by the real Electron before-input/before-mouse listeners and behavior
 * tests. The Electron event stays opaque and is never invoked, so the takeover
 * route cannot cancel the user's physical input.
 */
export function createAgentTabUserInputTakeoverHandlers(options: {
  isActivelyDriven: () => boolean
  isFrozen: () => boolean
  isAgentKey: (key: string) => boolean
  isAgentMouse: () => boolean
  takeOver: () => void
}): AgentTabUserInputTakeoverHandlers {
  const takeOver = (): void => {
    if (!options.isActivelyDriven() || options.isFrozen()) return
    options.takeOver()
  }
  return {
    onKeyboardInput: (_event, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp' && input.type !== 'char') return
      if (options.isAgentKey(input.key || '')) return
      takeOver()
    },
    onMouseInput: (_event, input) => {
      if (
        input.type !== 'mouseDown'
        && input.type !== 'mouseUp'
        && input.type !== 'mouseWheel'
        && input.type !== 'contextMenu'
      ) return
      if (options.isAgentMouse()) return
      takeOver()
    },
  }
}
