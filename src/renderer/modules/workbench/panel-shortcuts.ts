export type WorkbenchPanelShortcutAction = 'toggle-sidebar' | 'toggle-chat'

interface ShortcutTargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
  getAttribute?: (name: string) => string | null
}

interface ResolveWorkbenchPanelShortcutActionOptions {
  key: string
  code?: string
  keyCode?: number
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  target?: EventTarget | null
  selectionText?: string | null
  renamingPath?: string | null
  creatingType?: 'file' | 'folder' | null
}

function getShortcutTarget(target: EventTarget | null | undefined): ShortcutTargetLike | null {
  if (!target || typeof target !== 'object') return null
  return target as ShortcutTargetLike
}

function isEditableTarget(target: EventTarget | null | undefined): boolean {
  const element = getShortcutTarget(target)
  if (!element) return false

  const tagName = String(element.tagName || '').toUpperCase()
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName)) return true
  if (element.isContentEditable) return true

  const role = typeof element.getAttribute === 'function'
    ? String(element.getAttribute('role') || '').toLowerCase()
    : ''
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true

  if (typeof element.closest === 'function') {
    return Boolean(
      element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]'),
    )
  }

  return false
}

export function resolveWorkbenchPanelShortcutAction({
  key,
  code,
  keyCode,
  shiftKey,
  metaKey,
  ctrlKey,
  altKey,
  isComposing,
  target,
  selectionText: rawSelectionText,
  renamingPath,
  creatingType,
}: ResolveWorkbenchPanelShortcutActionOptions): WorkbenchPanelShortcutAction | null {
  const selectionText = String(rawSelectionText || '')
  if (isComposing || keyCode === 229) return null
  if (renamingPath || creatingType) return null

  if (metaKey || ctrlKey || altKey) return null
  if (selectionText.trim()) return null
  if (isEditableTarget(target)) return null

  if (!shiftKey && key === 'Tab') {
    return 'toggle-chat'
  }

  if (!shiftKey && (key === '·' || key === '`' || code === 'Backquote')) {
    return 'toggle-sidebar'
  }

  return null
}
