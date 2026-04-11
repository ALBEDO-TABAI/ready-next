interface ShortcutTargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
  getAttribute?: (name: string) => string | null
}

interface ShortcutGuardOptions {
  target?: EventTarget | null
  activeElement?: Element | null
  isComposing?: boolean
  keyCode?: number
}

function getShortcutTarget(target: EventTarget | Element | null | undefined): ShortcutTargetLike | null {
  if (!target || typeof target !== 'object') return null
  return target as ShortcutTargetLike
}

function isEditableTarget(target: EventTarget | Element | null | undefined): boolean {
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
      element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"]'),
    )
  }

  return false
}

export function shouldIgnoreGlobalKeyboardShortcut({
  target,
  activeElement,
  isComposing,
  keyCode,
}: ShortcutGuardOptions): boolean {
  if (isComposing || keyCode === 229) return true
  if (isEditableTarget(target)) return true
  if (!target && isEditableTarget(activeElement)) return true
  return false
}
