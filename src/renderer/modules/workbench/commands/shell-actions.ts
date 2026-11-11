export const SHELL_ACTION_EVENT = 'ready:shell-action'
// Existing rail/document-sidebar event; the ObjectUIHost remains its sole owner.
export const OPEN_QUICK_SWITCHER_EVENT = 'ready:open-quick-switcher'

export type ShellAction =
  | 'toggle-theme' | 'toggle-sidebar' | 'toggle-assistant'
  | 'open-today' | 'open-skills' | 'open-graph' | 'open-find-replace'
  | 'open-settings' | 'open-fastcard' | 'new-page'
export interface ShellActionDetail { action: ShellAction }

declare global {
  interface WindowEventMap {
    'ready:shell-action': CustomEvent<ShellActionDetail>
  }
}

export function requestShellAction(action: ShellAction): void {
  window.dispatchEvent(new window.CustomEvent<ShellActionDetail>(SHELL_ACTION_EVENT, { detail: { action } }))
}
