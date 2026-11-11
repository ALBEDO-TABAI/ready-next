import type { ReadyRef } from '../../../../shared/ready-ref'

export const SHELL_ACTION_EVENT = 'ready:shell-action'
// Existing rail/document-sidebar event; the ObjectUIHost remains its sole owner.
export const OPEN_QUICK_SWITCHER_EVENT = 'ready:open-quick-switcher'
// Quick look of one reference (W6 §2.1): reference capsules ask the one ObjectUIHost to show it.
export const OPEN_QUICK_LOOK_EVENT = 'ready:open-quick-look'

export type ShellAction =
  | 'toggle-theme' | 'toggle-sidebar' | 'toggle-assistant'
  | 'open-today' | 'open-skills' | 'open-graph' | 'open-find-replace'
  | 'open-settings' | 'open-fastcard' | 'new-page' | 'new-database'
export interface ShellActionDetail { action: ShellAction }

declare global {
  interface WindowEventMap {
    'ready:shell-action': CustomEvent<ShellActionDetail>
    'ready:open-quick-look': CustomEvent<{ ref: ReadyRef }>
  }
}

export function requestShellAction(action: ShellAction): void {
  window.dispatchEvent(new window.CustomEvent<ShellActionDetail>(SHELL_ACTION_EVENT, { detail: { action } }))
}

export function requestQuickLook(ref: ReadyRef): void {
  window.dispatchEvent(new window.CustomEvent(OPEN_QUICK_LOOK_EVENT, { detail: { ref } }))
}
