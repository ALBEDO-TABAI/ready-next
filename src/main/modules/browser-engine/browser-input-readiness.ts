import type { BrowserController } from './ipc-handler'
import type { BrowserHostPresentationState } from './host-layout-service'

export type BrowserInputTransport = 'trusted_pointer' | 'trusted_keyboard' | 'direct_text'

export interface BrowserInputReadiness {
  ready: boolean
  transport: BrowserInputTransport
  reason:
    | 'ready'
    | 'environment_unavailable'
    | 'physical_target_unavailable'
    | 'foreground_required'
    | 'host_not_presented'
    | 'tab_not_active'
    | 'document_unavailable'
    | 'document_not_ready'
    | 'document_focus_required'
    | 'editable_focus_required'
  physicalTargetToken: string | null
  hostPresentation: BrowserHostPresentationState | null
  documentFocused: boolean | null
  activeElementEditable: boolean | null
}

interface BrowserInputEnvironment {
  mainWindowForeground: boolean
  hostPresentation: BrowserHostPresentationState
  tabActive: boolean
}

export interface BrowserInputDocumentState {
  ready: boolean
  focused: boolean
  activeElementEditable: boolean
}

const TRANSPORT_REQUIREMENTS: Readonly<Record<BrowserInputTransport, {
  documentFocus: boolean
  editableFocus: boolean
}>> = {
  // A pointer dispatch establishes the target focus itself. Requiring an
  // already focused document would make the first real click impossible.
  trusted_pointer: { documentFocus: false, editableFocus: false },
  // Keyboard dispatch is delivered to the document's existing focus owner.
  trusted_keyboard: { documentFocus: true, editableFocus: false },
  // Input.insertText is routed to the exact WebContents target. A structurally
  // verified active editable element is sufficient; Chromium can establish
  // document focus while delivering the text even when the attached host is
  // hidden. Requiring document.hasFocus() before dispatch rejects a transport
  // that is mechanically able to produce trusted beforeinput/input events.
  direct_text: { documentFocus: false, editableFocus: true },
}

export function browserInputEnvironmentReadiness(
  controller: BrowserController,
  tabId: string | null,
  transport: BrowserInputTransport,
): BrowserInputReadiness {
  const readEnvironment = (controller as unknown as {
    getBrowserInputEnvironment?: (targetTabId: string | null) => BrowserInputEnvironment
  }).getBrowserInputEnvironment
  const unavailable = (): BrowserInputReadiness => ({
    ready: false,
    reason: 'environment_unavailable',
    transport,
    physicalTargetToken: null,
    hostPresentation: null,
    documentFocused: null,
    activeElementEditable: null,
  })
  if (typeof readEnvironment !== 'function') return unavailable()
  let environment: BrowserInputEnvironment
  try {
    environment = readEnvironment.call(controller, tabId)
  } catch {
    return unavailable()
  }
  const physicalTargetToken = typeof controller.getPhysicalTargetToken === 'function'
    ? (() => {
        try { return controller.getPhysicalTargetToken(tabId) } catch { return null }
      })()
    : null
  const base = {
    transport,
    physicalTargetToken: typeof physicalTargetToken === 'string' && physicalTargetToken ? physicalTargetToken : null,
    hostPresentation: environment.hostPresentation,
    documentFocused: null,
    activeElementEditable: null,
  }
  if (!base.physicalTargetToken) return { ...base, ready: false, reason: 'physical_target_unavailable' }
  const requiresPresentedForeground = transport === 'trusted_pointer' || transport === 'trusted_keyboard'
  if (requiresPresentedForeground && environment.hostPresentation !== 'visible') {
    return { ...base, ready: false, reason: 'host_not_presented' }
  }
  if (requiresPresentedForeground && !environment.mainWindowForeground) {
    return { ...base, ready: false, reason: 'foreground_required' }
  }
  if (requiresPresentedForeground && !environment.tabActive) {
    return { ...base, ready: false, reason: 'tab_not_active' }
  }
  return { ...base, ready: true, reason: 'ready' }
}

/**
 * Mechanical readiness for a real input transport. It never switches tabs,
 * raises Ready, clicks a surrogate target, or interprets page/site text.
 */
export async function browserInputReadiness(
  controller: BrowserController,
  tabId: string | null,
  transport: BrowserInputTransport,
  documentState?: BrowserInputDocumentState,
): Promise<BrowserInputReadiness> {
  const environmentReadiness = browserInputEnvironmentReadiness(controller, tabId, transport)
  if (!environmentReadiness.ready) return environmentReadiness
  const focus = documentState || await controller.executeJS(tabId, `(() => ({
    ready: document.readyState === 'interactive' || document.readyState === 'complete',
    focused: document.hasFocus(),
    activeElementEditable: (() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return false;
      if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
      if (el instanceof HTMLInputElement) {
        const blocked = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week']);
        return !el.disabled && !el.readOnly && !blocked.has(String(el.type || 'text').toLowerCase());
      }
      const contenteditable = String(el.getAttribute('contenteditable') || '').toLowerCase();
      return el.isContentEditable === true
        || contenteditable === '' && el.hasAttribute('contenteditable')
        || contenteditable === 'true'
        || contenteditable === 'plaintext-only'
        || ['textbox', 'searchbox'].includes(String(el.getAttribute('role') || '').toLowerCase());
    })()
  }))()`).catch(() => null) as { ready?: unknown; focused?: unknown; activeElementEditable?: unknown } | null
  const base = {
    ...environmentReadiness,
    documentFocused: typeof focus?.focused === 'boolean' ? focus.focused : null,
    activeElementEditable: typeof (focus as { activeElementEditable?: unknown } | null)?.activeElementEditable === 'boolean'
      ? (focus as { activeElementEditable: boolean }).activeElementEditable
      : null,
  }
  if (!focus || typeof focus.ready !== 'boolean') return { ...base, ready: false, reason: 'document_unavailable' }
  if (focus.ready === false) return { ...base, ready: false, reason: 'document_not_ready' }
  const requirements = TRANSPORT_REQUIREMENTS[transport]
  if (requirements.documentFocus && base.documentFocused !== true) {
    return { ...base, ready: false, reason: 'document_focus_required' }
  }
  if (requirements.editableFocus && base.activeElementEditable !== true) {
    return { ...base, ready: false, reason: 'editable_focus_required' }
  }
  return { ...base, ready: true, reason: 'ready' }
}

export async function requireBrowserInputReadiness(
  controller: BrowserController,
  tabId: string | null,
  transport: BrowserInputTransport,
  documentState?: BrowserInputDocumentState,
): Promise<BrowserInputReadiness> {
  const readiness = await browserInputReadiness(controller, tabId, transport, documentState)
  if (!readiness.ready) {
    throw Object.assign(new Error(`browser_input_not_ready:${readiness.reason}`), {
      code: readiness.reason === 'foreground_required' ? 'FOREGROUND_REQUIRED' : 'INPUT_NOT_READY',
      readiness,
    })
  }
  return readiness
}
