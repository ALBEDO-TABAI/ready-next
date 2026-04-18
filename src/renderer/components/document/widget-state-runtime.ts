export type {
  WidgetPersistedControlState,
  WidgetPersistedActiveTargetState,
  DocumentWidgetPersistedState,
} from '../../../shared/document-widget-parse'

import type {
  WidgetPersistedControlState,
  WidgetPersistedActiveTargetState,
  DocumentWidgetPersistedState,
} from '../../../shared/document-widget-parse'

export function collectWidgetPersistedState(root: ParentNode): DocumentWidgetPersistedState {
  const controls = Array.from(root.querySelectorAll('input, textarea, select'))
    .map((element, index): WidgetPersistedControlState | null => {
      if (element instanceof HTMLInputElement) {
        return {
          index,
          tag: 'input',
          type: element.type || 'text',
          value: element.value,
          checked: element.checked,
        }
      }
      if (element instanceof HTMLTextAreaElement) {
        return {
          index,
          tag: 'textarea',
          value: element.value,
        }
      }
      if (element instanceof HTMLSelectElement) {
        return {
          index,
          tag: 'select',
          value: element.value,
        }
      }
      return null
    })
    .filter((value): value is WidgetPersistedControlState => Boolean(value))

  const activeTargets = Array.from(root.querySelectorAll('[data-tab-target].is-active, [data-focus-target].is-active'))
    .map((element): WidgetPersistedActiveTargetState | null => {
      if (!(element instanceof HTMLElement)) return null
      const tabTarget = element.getAttribute('data-tab-target')
      if (tabTarget) {
        return { attr: 'data-tab-target', value: tabTarget }
      }
      const focusTarget = element.getAttribute('data-focus-target')
      if (focusTarget) {
        return { attr: 'data-focus-target', value: focusTarget }
      }
      return null
    })
    .filter((value): value is WidgetPersistedActiveTargetState => Boolean(value))

  return { controls, activeTargets }
}

function dispatchStateEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

export function applyWidgetPersistedState(
  root: ParentNode,
  state?: DocumentWidgetPersistedState | null,
): void {
  if (!state) return

  const controls = Array.from(root.querySelectorAll('input, textarea, select'))
  for (const controlState of state.controls || []) {
    const element = controls[controlState.index]
    if (!element) continue

    if (element instanceof HTMLInputElement) {
      if (typeof controlState.checked === 'boolean' && ['checkbox', 'radio'].includes(controlState.type || element.type)) {
        element.checked = controlState.checked
      }
      if (typeof controlState.value === 'string') {
        element.value = controlState.value
      }
      dispatchStateEvents(element)
      continue
    }

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (typeof controlState.value === 'string') {
        element.value = controlState.value
      }
      dispatchStateEvents(element)
    }
  }

  for (const activeTarget of state.activeTargets || []) {
    const selector = `[${activeTarget.attr}="${CSS.escape(activeTarget.value)}"]`
    const element = root.querySelector(selector)
    if (element instanceof HTMLElement && !element.classList.contains('is-active')) {
      element.click()
    }
  }
}
