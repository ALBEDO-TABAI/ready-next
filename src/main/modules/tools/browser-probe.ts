/**
 * Browser probe/target-JS builders + live-target guards — extracted verbatim
 * from browser-tools.ts (Phase B, 2026-07-03). Pure injected-page-probe JS
 * string builders + the destructive/password live-target guard helpers. No
 * dispatch state: depends only on injected constants + BrowserController.
 */
import { BrowserController } from '../browser-engine/ipc-handler'
import { ToolDomainError } from './tool-errors'
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'

export interface BrowserBlockingChallengeProbe {
  blocked: boolean
  blockerCount: number
  matchedKinds: string[]
  pageError: boolean
  emptyShell: boolean
}

export function buildBrowserBlockingChallengeProbeJs(): string {
  return `(() => {
    const __READY_BLOCKING_CHALLENGE_PROBE__ = true;
    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      const style = getComputedStyle(node);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0
        && style.pointerEvents !== 'none';
    };
    const selector = 'dialog,[role="dialog"],[aria-modal="true"]';
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const centerX = viewportWidth / 2;
    const centerY = viewportHeight / 2;
    const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => {
      if (!visible(node)) return false;
      const rect = node.getBoundingClientRect();
      const coversCenter = rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY;
      return coversCenter && rect.width * rect.height >= viewportWidth * viewportHeight * 0.2;
    });
    const bodyText = String(document.body && (document.body.innerText || document.body.textContent) || '')
      .replace(/\\s+/g, ' ').trim();
    let pageError = String(location.protocol || '').toLowerCase() === 'chrome-error:';
    if (!pageError) {
      pageError = false;
    }
    const interactiveCount = document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"]').length;
    const emptyShell = document.readyState === 'complete' && bodyText.length === 0 && interactiveCount === 0;
    return {
      blocked: false,
      blockerCount: candidates.length,
      matchedKinds: [],
      pageError,
      emptyShell
    };
  })()`
}

export function normalizeBrowserBlockingChallengeProbe(value: unknown): BrowserBlockingChallengeProbe {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const matchedKinds = Array.isArray(record.matchedKinds)
    ? Array.from(new Set(record.matchedKinds.map((kind) => String(kind)).filter(Boolean))).slice(0, 4)
    : []
  return {
    blocked: record.blocked === true && matchedKinds.length > 0,
    blockerCount: Math.max(0, Math.floor(Number(record.blockerCount || 0))),
    matchedKinds,
    pageError: record.pageError === true,
    emptyShell: record.emptyShell === true,
  }
}

function buildBrowserDomTargetLibraryJs(): string {
  return `
    const READY_TARGET_STATE_KEY = '__readyBrowserTargetIdentityV3';
    function readyTargetState() {
      let state = globalThis[READY_TARGET_STATE_KEY];
      if (!state || state.document !== document || !(state.nodesByToken instanceof Map) || !(state.tokenByNode instanceof WeakMap)) {
        const bytes = new Uint32Array(4);
        try { globalThis.crypto.getRandomValues(bytes); } catch {
          for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 0xffffffff);
        }
        const documentToken = Array.from(bytes).map((value) => value.toString(36)).join('-');
        state = {
          document,
          documentToken,
          nextTargetSequence: 1,
          nodesByToken: new Map(),
          tokenByNode: new WeakMap()
        };
        globalThis[READY_TARGET_STATE_KEY] = state;
      }
      return state;
    }
    function readyFrameDocumentToken() {
      return readyTargetState().documentToken;
    }
    function readyStableTargetToken(el) {
      if (!(el instanceof Element)) return '';
      const state = readyTargetState();
      let token = state.tokenByNode.get(el);
      if (!token) {
        token = 'h' + (state.nextTargetSequence++).toString(36);
        state.tokenByNode.set(el, token);
        state.nodesByToken.set(token, el);
      }
      return token;
    }
    function readyResolveTargetToken(nodeId, expectedDocumentToken) {
      const state = readyTargetState();
      if (expectedDocumentToken && state.documentToken !== expectedDocumentToken) return null;
      if (!/^h[0-9a-z]+$/i.test(String(nodeId || ''))) return null;
      const el = state.nodesByToken.get(String(nodeId)) || null;
      if (!(el instanceof Element) || !el.isConnected || el.ownerDocument !== document) {
        state.nodesByToken.delete(String(nodeId));
        return null;
      }
      return el;
    }
    const READY_AGENT_TARGET_SELECTOR = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role]',
      'summary',
      'canvas',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6'
    ].join(',');
    function readyCleanText(value) {
      return String(value || '').replace(/\\s+/g, ' ').trim();
    }
    function readyLabelFor(el) {
      const aria = readyCleanText(el.getAttribute('aria-label'));
      if (aria) return aria;
      const labelledBy = readyCleanText(el.getAttribute('aria-labelledby'));
      if (labelledBy) {
        const text = labelledBy.split(/\\s+/).map((id) => readyCleanText(document.getElementById(id)?.innerText)).filter(Boolean).join(' ');
        if (text) return text;
      }
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        const labelText = readyCleanText(label?.innerText || label?.textContent);
        if (labelText) return labelText;
      }
      const ownText = readyCleanText(el.innerText || el.textContent);
      if (ownText) return ownText.slice(0, 160);
      const title = readyCleanText(el.getAttribute('title'));
      if (title) return title;
      const placeholder = readyCleanText(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
      const dataPlaceholder = readyCleanText(el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder'));
      if (dataPlaceholder) return dataPlaceholder;
      const alt = readyCleanText(el.getAttribute('alt'));
      if (alt) return alt;
      const name = readyCleanText(el.getAttribute('name'));
      if (name) return name;
      if (el instanceof HTMLInputElement && el.type === 'file') return 'input:file';
      if (el.isContentEditable) return 'contenteditable';
      return '';
    }
    function readyRoleFor(el) {
      const explicit = readyCleanText(el.getAttribute('role'));
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'canvas') return 'canvas';
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
      if (tag === 'input') {
        const type = String(el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'search') return 'searchbox';
        if (type === 'file') return 'button';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return 'generic';
    }
    function readyStatesFor(el) {
      const states = {};
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) {
        if (el.disabled) states.disabled = true;
      }
      if (el.getAttribute('aria-disabled') === 'true') states.disabled = true;
      const expanded = el.getAttribute('aria-expanded');
      if (expanded) states.expanded = expanded;
      const checked = el.getAttribute('aria-checked');
      if (checked) states.checked = checked;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && el.checked) states.checked = true;
      const selected = el.getAttribute('aria-selected');
      if (selected) states.selected = selected;
      if (el instanceof HTMLInputElement && el.type === 'password') states.password = true;
      return states;
    }
    function readyVisibleFor(el) {
      try {
        if (!readyRenderedFor(el)) return false;
        const rect = el.getBoundingClientRect();
        const viewportWidth = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
        const viewportHeight = Number(window.innerHeight || document.documentElement?.clientHeight || 0);
        if (!(viewportWidth > 0 && viewportHeight > 0)) return false;
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return false;
        const style = window.getComputedStyle(el);
        return Boolean(
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0
        );
      } catch { return false; }
    }
    function readyRenderedFor(el) {
      try {
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return false;
        const style = window.getComputedStyle(el);
        return Boolean(
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0
        );
      } catch { return false; }
    }
    function readyEditableFor(el) {
      if (el instanceof HTMLInputElement) {
        const type = String(el.type || 'text').toLowerCase();
        return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'image', 'hidden'].includes(type)
          && !el.readOnly;
      }
      if (el instanceof HTMLTextAreaElement) return !el.readOnly;
      if (el.isContentEditable) return true;
      const role = String(el.getAttribute('role') || '').toLowerCase();
      return role === 'textbox' || role === 'searchbox';
    }
    function readyTargetElements() {
      return Array.from(document.querySelectorAll(READY_AGENT_TARGET_SELECTOR));
    }
    function readyTargetRecord(el, index, targetIndexByElement) {
      const rect = el.getBoundingClientRect();
      const box = rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        : undefined;
      const ancestorStableNodeTokens = [];
      let ancestor = el.parentElement;
      while (ancestor) {
        const ancestorIndex = targetIndexByElement && targetIndexByElement.get(ancestor);
        if (Number.isInteger(ancestorIndex)) ancestorStableNodeTokens.unshift(readyStableTargetToken(ancestor));
        ancestor = ancestor.parentElement;
      }
      const states = Object.assign(
        readyStatesFor(el),
        el instanceof HTMLInputElement && el.type === 'file' ? { fileInput: true } : {}
      );
      const form = el.closest && el.closest('form');
      const ancestorContext = [];
      let contextNode = el.parentElement;
      while (contextNode && ancestorContext.length < 4) {
        const role = readyRoleFor(contextNode);
        const name = readyLabelFor(contextNode);
        if (role || name) ancestorContext.unshift(role + ':' + name.slice(0, 80));
        contextNode = contextNode.parentElement;
      }
      const href = String(
        (String(el.tagName || '').toLowerCase() === 'a' && typeof el.href === 'string' ? el.href : '')
        || (el.getAttribute && el.getAttribute('href'))
        || ''
      );
      return {
        role: readyRoleFor(el),
        name: readyLabelFor(el),
        value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? readyCleanText(el.value).slice(0, 160) : undefined,
        states,
        stableNodeToken: readyStableTargetToken(el),
        parentStableNodeToken: ancestorStableNodeTokens.length > 0
          ? ancestorStableNodeTokens[ancestorStableNodeTokens.length - 1]
          : undefined,
        ancestorStableNodeTokens,
        frameId: '0',
        frameDocumentToken: readyFrameDocumentToken(),
        box,
        rendered: readyRenderedFor(el),
        visible: readyVisibleFor(el),
        enabled: !Boolean(states.disabled),
        editable: readyEditableFor(el),
        href,
        inputType: el instanceof HTMLInputElement ? String(el.type || 'text').toLowerCase() : '',
        autocomplete: String(el.getAttribute && el.getAttribute('autocomplete') || '').toLowerCase(),
        formAction: form ? String(form.getAttribute('action') || form.action || '') : '',
        ancestorContext: ancestorContext.join(' > ')
      };
    }
  `
}

export function buildBrowserPageMapProbeJs(): string {
  return `(() => {
    const __READY_AGENT_PAGE_MAP__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    const elements = readyTargetElements();
    const targetIndexByElement = new Map(elements.map((el, index) => [el, index]));
    const rawTargets = elements.map((el, index) => readyTargetRecord(el, index, targetIndexByElement));
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
    };
    const externalLinks = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
      try { return new URL(a.href, location.href).origin !== location.origin; } catch { return false; }
    }).length;
    const iframes = Array.from(document.querySelectorAll('iframe,frame')).slice(0, 20).map((frame, index) => {
      let readable = false;
      let reason = 'cross_origin_or_unavailable';
      try {
        const doc = frame.contentDocument;
        readable = Boolean(doc);
        reason = doc ? 'same_origin_readable' : 'cross_origin_or_unavailable';
      } catch {
        readable = false;
        reason = 'cross_origin_unreadable';
      }
      return {
        index,
        title: clean(frame.getAttribute('title') || frame.getAttribute('aria-label') || ''),
        src: String(frame.getAttribute('src') || ''),
        readable,
        reason,
        hidden: !visible(frame)
      };
    });
    const hiddenLoaded = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],section,article,dialog,[hidden],[aria-hidden="true"]'))
      .filter((el) => !visible(el) && clean(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder')).length > 0)
      .slice(0, 20)
      .map((el, index) => ({
        index,
        role: readyRoleFor(el),
        label: readyLabelFor(el).slice(0, 160),
        reason: el.hasAttribute('hidden') ? 'hidden_attribute' : el.getAttribute('aria-hidden') === 'true' ? 'aria_hidden' : 'css_hidden'
      }));
    return {
      identity: {
        url: String(location.href || ''),
        title: String(document.title || ''),
        frameDocumentToken: readyFrameDocumentToken()
      },
      viewport: { width: Math.round(window.innerWidth || 0), height: Math.round(window.innerHeight || 0) },
      bodyText: String(document.body?.innerText || '').slice(0, 4000),
      rawRoots: [{ role: 'generic', name: '', children: rawTargets }],
      structureHints: { iframes, hiddenLoaded },
      riskFlags: {
        fileInputCount: document.querySelectorAll('input[type="file"]').length,
        passwordInputCount: document.querySelectorAll('input[type="password"]').length,
        externalLinkCount: externalLinks,
        iframeCount: document.querySelectorAll('iframe').length,
        shadowHostCount: null
      }
    };
  })()`
}

export function buildBrowserTargetProbeJs(nodeId: string, frameDocumentToken?: string): string {
  return `(() => {
    const __READY_AGENT_TARGET_PROBE__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    const nodeId = ${JSON.stringify(nodeId)};
    const el = readyResolveTargetToken(nodeId, ${JSON.stringify(frameDocumentToken || '')});
    if (!el) return { matchCount: 0 };
    const record = readyTargetRecord(el, -1);
    const disabled = Boolean(record.states && record.states.disabled === true);
    const rect = el.getBoundingClientRect();
    return {
      matchCount: 1,
      disabled,
      target: record,
      clickPoint: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        vw: Number(window.innerWidth || 0),
        vh: Number(window.innerHeight || 0),
        hostShadow: (el.tagName && el.tagName.indexOf('-') !== -1)
          ? (el.shadowRoot ? 'open' : 'closed_or_none')
          : null,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    };
  })()`
}

/**
 * Focus an already-resolved page-map target without synthesizing a pointer
 * click. Background WebContentsViews can retain a real viewport while parked
 * outside the window, but Chromium will not deliver pointer input to them.
 * The target is resolved again from the current DOM, guarded again at the
 * moment of focus, and must become the exact active element before typing.
 */
export function buildBrowserTargetFocusJs(nodeId: string, allowPasswordFill: boolean, frameDocumentToken?: string): string {
  return `(() => {
    const __READY_AGENT_TARGET_FOCUS__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    ${buildInputGuardSnippetJs(allowPasswordFill)}
    const nodeId = ${JSON.stringify(nodeId)};
    const el = readyResolveTargetToken(nodeId, ${JSON.stringify(frameDocumentToken || '')});
    if (!el) return { ok: false, reason: 'target_not_found' };
    const guard = readyInputGuard(el);
    if (guard) return guard;
    const states = readyStatesFor(el);
    const label = readyInputSemanticsLabel(el);
    const tag = String(el.tagName || '').toLowerCase();
    if (!readyRenderedFor(el)) return { ok: false, reason: 'target_not_rendered', kind: 'none', tag, label };
    if (states.disabled === true) return { ok: false, reason: 'target_disabled', kind: 'non_editable', tag, label };
    if (!readyEditableFor(el)) return { ok: false, reason: 'target_not_editable', kind: 'non_editable', tag, label };
    try {
      el.focus({ preventScroll: true });
    } catch {
      return { ok: false, reason: 'focus_failed', kind: 'none', tag, label };
    }
    return {
      ok: document.activeElement === el,
      reason: document.activeElement === el ? null : 'focus_not_acquired',
      kind: document.activeElement === el ? 'editable' : 'none',
      tag,
      label,
    };
  })()`
}

export function buildBrowserTargetFormSubmitJs(nodeId: string, frameDocumentToken?: string): string {
  return `(() => {
    const __READY_AGENT_TARGET_SUBMIT__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    const nodeId = ${JSON.stringify(nodeId)};
    const el = readyResolveTargetToken(nodeId, ${JSON.stringify(frameDocumentToken || '')});
    if (!el) return { ok: false, reason: 'target_not_found', delivery: 'not_delivered' };
    const form = el instanceof HTMLInputElement || el instanceof HTMLButtonElement
      ? el.form
      : el.closest && el.closest('form');
    if (!(form instanceof HTMLFormElement)) return { ok: false, reason: 'form_not_found', delivery: 'not_delivered' };
    if (typeof form.requestSubmit !== 'function') return { ok: false, reason: 'request_submit_unavailable', delivery: 'not_delivered' };
    let submitCount = 0;
    let invalidCount = 0;
    let trustedSubmitCount = 0;
    const onSubmit = (event) => {
      if (event.target !== form) return;
      submitCount += 1;
      if (event.isTrusted) trustedSubmitCount += 1;
    };
    const onInvalid = (event) => {
      if (event.target instanceof Element && form.contains(event.target)) invalidCount += 1;
    };
    form.addEventListener('submit', onSubmit, true);
    form.addEventListener('invalid', onInvalid, true);
    try {
      const exactSubmitter = (
        (el instanceof HTMLButtonElement && el.type === 'submit')
        || (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image'))
      ) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
        ? el
        : null;
      const candidates = Array.from(form.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]'))
        .filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true');
      form.requestSubmit(exactSubmitter || (candidates.length === 1 ? candidates[0] : undefined));
    } catch (error) {
      return { ok: false, reason: 'request_submit_failed', message: String(error && error.message || error), delivery: 'unknown' };
    } finally {
      form.removeEventListener('submit', onSubmit, true);
      form.removeEventListener('invalid', onInvalid, true);
    }
    return {
      ok: submitCount > 0,
      submitted: submitCount > 0,
      delivery: submitCount > 0 ? 'delivered' : 'not_delivered',
      submitCount,
      trustedSubmitCount,
      invalidCount,
    };
  })()`
}

export function buildBrowserTargetReadJs(nodeId: string, frameDocumentToken?: string): string {
  return `(() => {
    const __READY_AGENT_TARGET_READ__ = true;
    ${buildBrowserDomTargetLibraryJs()}
    const nodeId = ${JSON.stringify(nodeId)};
    const el = readyResolveTargetToken(nodeId, ${JSON.stringify(frameDocumentToken || '')});
    if (!el) return { matchCount: 0, content: '' };
    const record = readyTargetRecord(el, -1);
    const chunks = [
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        ? String(el.value || '')
        : '',
      String(el.innerText || ''),
      String(el.textContent || ''),
      String(record.name || ''),
    ].map((value) => value.replace(/\\s+/g, ' ').trim()).filter(Boolean);
    return {
      matchCount: 1,
      content: Array.from(new Set(chunks)).join('\\n'),
      target: record,
    };
  })()`
}

const BROWSER_BACKEND_TARGET_FUNCTION = `function(operation, allowPasswordFill, roleHint) {
  const __READY_AGENT_BACKEND_TARGET__ = true;
  const __READY_AGENT_TARGET_FOCUS__ = operation === 'focus';
  const __READY_AGENT_TARGET_SELECT_ALL__ = operation === 'select_all';
  const __READY_AGENT_TARGET_SUBMIT__ = operation === 'submit';
  const el = this;
  if (!(el instanceof Element) || !el.isConnected) return { matchCount: 0 };
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const label = (() => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledBy = clean(el.getAttribute('aria-labelledby'));
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
      if (text) return text;
    }
    const id = clean(el.getAttribute('id'));
    if (id) {
      const owner = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      const text = clean(owner?.textContent);
      if (text) return text;
    }
    return clean(el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name')).slice(0, 160);
  })();
  const tag = String(el.tagName || '').toLowerCase();
  const explicitRole = clean(el.getAttribute('role')).toLowerCase();
  const role = explicitRole
    || (tag === 'a' ? 'link'
      : tag === 'button' || tag === 'summary' ? 'button'
        : tag === 'textarea' ? 'textbox'
          : tag === 'select' ? 'combobox'
            : /^h[1-6]$/.test(tag) ? 'heading'
              : tag === 'input'
                ? (String(el.getAttribute('type') || 'text').toLowerCase() === 'search' ? 'searchbox' : 'textbox')
                : el.isContentEditable ? 'textbox' : clean(roleHint) || 'generic');
  const inputType = el instanceof HTMLInputElement ? String(el.type || 'text').toLowerCase() : '';
  const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
  const password = inputType === 'password';
  const fileInput = inputType === 'file';
  const editable = el instanceof HTMLTextAreaElement
    ? !el.readOnly && !disabled
    : el instanceof HTMLInputElement
      ? !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'image', 'hidden'].includes(inputType) && !el.readOnly && !disabled
      : el.isContentEditable === true || role === 'textbox' || role === 'searchbox';
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const rendered = rect.width > 0 && rect.height > 0
    && !el.hidden && el.getAttribute('aria-hidden') !== 'true'
    && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
  const visible = rendered
    && rect.right > 0 && rect.bottom > 0
    && rect.left < Math.max(1, window.innerWidth || 1)
    && rect.top < Math.max(1, window.innerHeight || 1);
  const states = {};
  if (disabled) states.disabled = true;
  if (password) states.password = true;
  if (fileInput) states.fileInput = true;
  for (const key of ['expanded', 'checked', 'selected']) {
    const value = el.getAttribute('aria-' + key);
    if (value !== null) states[key] = value;
  }
  const form = el.closest && el.closest('form');
  const ancestorContext = [];
  let ancestor = el.parentElement;
  while (ancestor && ancestorContext.length < 4) {
    const ancestorRole = clean(ancestor.getAttribute('role'));
    const ancestorName = clean(ancestor.getAttribute('aria-label') || ancestor.getAttribute('title'));
    if (ancestorRole || ancestorName) ancestorContext.unshift(ancestorRole + ':' + ancestorName.slice(0, 80));
    ancestor = ancestor.parentElement;
  }
  const target = {
    role,
    name: label,
    value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? clean(el.value).slice(0, 160) : undefined,
    states,
    frameId: '0',
    box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    rendered,
    visible,
    enabled: !disabled,
    editable,
    href: el instanceof HTMLAnchorElement ? String(el.href || '') : String(el.getAttribute('href') || ''),
    inputType,
    autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase(),
    formAction: form ? String(form.getAttribute('action') || form.action || '') : '',
    ancestorContext: ancestorContext.join(' > '),
  };
  if (operation === 'focus') {
    if (fileInput) return { ok: false, errorKind: 'file_input_requires_upload', liveTargetKind: 'file' };
    if (password && !allowPasswordFill) return { ok: false, errorKind: 'credential_confirmation_required', liveTargetKind: 'password' };
    if (!rendered) return { ok: false, reason: 'target_not_rendered', kind: 'none', tag, label };
    if (disabled) return { ok: false, reason: 'target_disabled', kind: 'non_editable', tag, label };
    if (!editable) return { ok: false, reason: 'target_not_editable', kind: 'non_editable', tag, label };
    try { el.focus({ preventScroll: true }); } catch { return { ok: false, reason: 'focus_failed', kind: 'none', tag, label }; }
    const focused = document.activeElement === el;
    return { ok: focused, reason: focused ? null : 'focus_not_acquired', kind: focused ? 'editable' : 'none', tag, label };
  }
  if (operation === 'select_all') {
    if (document.activeElement !== el) return { ok: false, reason: 'focus_not_acquired' };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      try {
        el.setSelectionRange(0, String(el.value || '').length);
        return { ok: true, kind: 'text_control' };
      } catch {
        return { ok: false, reason: 'selection_failed' };
      }
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selected = window.getSelection();
        if (!selected) return { ok: false, reason: 'selection_unavailable' };
        selected.removeAllRanges();
        selected.addRange(range);
        return { ok: true, kind: 'contenteditable' };
      } catch {
        return { ok: false, reason: 'selection_failed' };
      }
    }
    return { ok: false, reason: 'exact_editable_selection_unavailable' };
  }
  if (operation === 'read') {
    const chunks = [target.value || '', String(el.innerText || ''), String(el.textContent || ''), label]
      .map(clean).filter(Boolean);
    return { matchCount: 1, content: Array.from(new Set(chunks)).join('\\n'), target };
  }
  if (operation === 'submit') {
    const submitForm = el instanceof HTMLInputElement || el instanceof HTMLButtonElement
      ? el.form
      : el.closest && el.closest('form');
    if (!(submitForm instanceof HTMLFormElement)) return { ok: false, reason: 'form_not_found', delivery: 'not_delivered' };
    if (typeof submitForm.requestSubmit !== 'function') return { ok: false, reason: 'request_submit_unavailable', delivery: 'not_delivered' };
    let submitCount = 0;
    let invalidCount = 0;
    let trustedSubmitCount = 0;
    const onSubmit = (event) => {
      if (event.target !== submitForm) return;
      submitCount += 1;
      if (event.isTrusted) trustedSubmitCount += 1;
    };
    const onInvalid = (event) => {
      if (event.target instanceof Element && submitForm.contains(event.target)) invalidCount += 1;
    };
    submitForm.addEventListener('submit', onSubmit, true);
    submitForm.addEventListener('invalid', onInvalid, true);
    try {
      const exactSubmitter = (
        (el instanceof HTMLButtonElement && el.type === 'submit')
        || (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image'))
      ) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
        ? el
        : null;
      const candidates = Array.from(submitForm.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]'))
        .filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true');
      submitForm.requestSubmit(exactSubmitter || (candidates.length === 1 ? candidates[0] : undefined));
    } catch (error) {
      return { ok: false, reason: 'request_submit_failed', message: String(error && error.message || error), delivery: 'unknown' };
    } finally {
      submitForm.removeEventListener('submit', onSubmit, true);
      submitForm.removeEventListener('invalid', onInvalid, true);
    }
    return {
      ok: submitCount > 0,
      submitted: submitCount > 0,
      delivery: submitCount > 0 ? 'delivered' : 'not_delivered',
      submitCount,
      trustedSubmitCount,
      invalidCount,
    };
  }
  return {
    matchCount: 1,
    disabled,
    target,
    clickPoint: {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      vw: Number(window.innerWidth || 0),
      vh: Number(window.innerHeight || 0),
      hostShadow: el.shadowRoot ? 'open' : null,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    },
  };
}`

export async function callBrowserBackendTarget(
  controller: BrowserController,
  tabId: string | null,
  backendDOMNodeId: number,
  operation: 'probe' | 'focus' | 'select_all' | 'read' | 'submit',
  options: { allowPasswordFill?: boolean; roleHint?: string } = {},
): Promise<unknown> {
  return controller.callFunctionOnBackendNode(
    tabId,
    backendDOMNodeId,
    BROWSER_BACKEND_TARGET_FUNCTION,
    [operation, options.allowPasswordFill === true, options.roleHint || ''],
  )
}

/** Shared structural target helpers used by selector, coordinate and focused
 * input probes. Labels are returned for grounding only; policy never branches
 * on their language or wording. Defines:
 *
 *   readyAriaLabelledbyText(el) — resolves aria-labelledby references
 *   readyInputSemanticsLabel(el) — what the FIELD IS: placeholder /
 *     aria-label / aria-labelledby / name / id / title / associated <label>.
 *     Deliberately NOT value/textContent, so current user text cannot change
 *     the structural classification of an input.
 *   readyClickSemanticsLabel(el) — what the CLICK will press: climbs to the
 *     nearest clickable owner and reads its accessible description.
 */
export function buildTargetSemanticsLibraryJs(): string {
  return `
    function readyAriaLabelledbyText(el) {
      try {
        const ref = el && el.getAttribute ? el.getAttribute('aria-labelledby') : null;
        if (!ref) return '';
        const parts = [];
        for (const id of ref.split(/\\s+/)) {
          const node = document.getElementById(id);
          if (node) parts.push(node.textContent);
        }
        return parts.filter(Boolean).join(' ');
      } catch { return ''; }
    }
    function readyInputSemanticsLabel(el) {
      if (!el || !el.getAttribute) return '';
      const parts = [
        el.getAttribute('placeholder'), el.getAttribute('aria-label'), readyAriaLabelledbyText(el),
        el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('title'), el.getAttribute('data-placeholder'),
      ];
      try {
        const id = el.getAttribute('id');
        if (id) {
          const owner = document.querySelector('label[for="' + CSS.escape(id) + '"]');
          if (owner) parts.push(owner.textContent);
        }
        const wrap = el.closest && el.closest('label');
        if (wrap) parts.push(wrap.textContent);
      } catch { /* label association is best-effort */ }
      return parts.filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    function readyClickableOwner(el) {
      if (!el) return el;
      return (el.closest && el.closest('button, a, [role="button"], [role="link"], input, textarea, select, summary, [onclick], label')) || el;
    }
    function readyClickSemanticsLabel(el) {
      if (!el) return '';
      const owner = readyClickableOwner(el);
      const parts = [owner.textContent, owner.getAttribute && owner.getAttribute('aria-label'), readyAriaLabelledbyText(owner), owner.value, owner.title];
      if (owner !== el && el.getAttribute) {
        parts.push(el.getAttribute('aria-label'));
        parts.push(readyAriaLabelledbyText(el));
      }
      return parts.filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    function readyIsPasswordField(el) {
      return el instanceof HTMLInputElement && el.type === 'password';
    }
    function readyIsEditableField(el) {
      if (el instanceof HTMLInputElement) {
        const t = (el.type || 'text').toLowerCase();
        return !['button','submit','reset','checkbox','radio','file','range','color','image','hidden'].includes(t);
      }
      if (el instanceof HTMLTextAreaElement) return true;
      if (el.isContentEditable) return true;
      const role = (el.getAttribute && (el.getAttribute('role') || '').toLowerCase()) || '';
      return role === 'textbox' || role === 'searchbox' || role === 'combobox';
    }
  `
}

/**
 * In-page guard for typing scripts (browser_type / browser_type /
 * browser_type). Returns a blocked-marker object or null.
 */
export function buildInputGuardSnippetJs(allowPasswordFill: boolean): string {
  return `
    const __READY_LIVE_TARGET_GUARD__ = true;
    ${buildTargetSemanticsLibraryJs()}
    function readyInputGuard(el) {
      if (el instanceof HTMLInputElement && String(el.type || '').toLowerCase() === 'file') {
        return { ok: false, errorKind: 'file_input_requires_upload', liveTargetKind: 'file' };
      }
      if (readyIsPasswordField(el) && !${JSON.stringify(allowPasswordFill)}) {
        return { ok: false, errorKind: 'credential_confirmation_required', liveTargetKind: 'password' };
      }
      return null;
    }
  `
}

/** Best-effort structural target probe for coordinate actions. A visual click
 * remains usable when the probe is unavailable; coordinate typing still fails
 * closed because its text destination cannot then be verified. */
function buildClickPointLabelProbeJs(cssX: number, cssY: number): string {
  return `(() => {
    const __READY_CLICK_POINT_LABEL_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const start = document.elementFromPoint(${JSON.stringify(Math.round(cssX))}, ${JSON.stringify(Math.round(cssY))});
    if (!start) return { label: '', inputLabel: '', password: false, editable: false, tag: '' };
    const owner = readyClickableOwner(start);
    return {
      label: readyClickSemanticsLabel(start),
      inputLabel: readyInputSemanticsLabel(owner),
      password: readyIsPasswordField(owner),
      fileInput: owner instanceof HTMLInputElement && String(owner.type || '').toLowerCase() === 'file',
      inputType: owner instanceof HTMLInputElement ? String(owner.type || 'text').toLowerCase() : '',
      // editable → the click only FOCUSES a field (judge by field semantics,
      // which exclude the current value); non-editable → the click is an
      // action (judge by the click/caption label, value included).
      editable: readyIsEditableField(owner),
      // D18-c：label 为空时模型分不清"点到空白容器"和"点到无名编辑器"——
      // 回传命中元素 tag 供闭环自纠（第十四轮实锚：click_at 命中 tiptap
      // 编辑器返回空 label，模型误判脱靶反复重点）。
      tag: String((start.tagName || '')).toLowerCase(),
      // R18（第十七轮实锚）：dash-tag host 命中时调用方要对 host rect 做
      // 组合树扫描，把 rect 一并回传省一次探测。
      rect: (() => {
        try {
          const r = start.getBoundingClientRect();
          return r && r.width > 0 && r.height > 0
            ? { left: r.left, top: r.top, width: r.width, height: r.height }
            : null;
        } catch (e) { return null; }
      })(),
      // R19：点击前 URL——取证层以"点击后 URL 未变"为同页判据，成功跳转
      // （如发布成功页）不再对陈旧 rect 做无谓扫描。
      url: String(location.href || ''),
    };
  })()`
}

/**
 * R18（真机第十七轮实锚）：点击"生效但无 map 变化"的第三种真相是页面弹了
 * 瞬时校验 toast——delta 的 bodyText 只取前 1000 字符，挂在 body 末尾的
 * toast 完全落在窗口外，changed=false 掩盖了页面已给出的拒绝理由。此探针
 * 收集当前可见的 toast/alert 类轻量提示文本（fixed/absolute 定位 + 短文本
 * + 非零尺寸），机械采集不判断语义。
 */
export function buildTransientNoticeProbeJs(): string {
  return `(() => {
    const out = [];
    const seen = new Set();
    const selector = '[class*="toast" i],[class*="notice" i],[class*="alert" i],[class*="tips" i],[class*="tip-" i],[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]';
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) {}
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      let cs = null;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || '1') <= 0.02) continue;
      const pos = cs.position;
      // toast 层几乎总是 fixed；absolute 需要高 z-index 才算（避免误收正文区块）
      if (pos !== 'fixed' && !(pos === 'absolute' && Number(cs.zIndex) >= 100)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.height > 220) continue;
      const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length < 2 || t.length > 140) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 5) break;
    }
    return out;
  })()`
}

export async function probeCoordinateTargetOrThrow(
  controller: BrowserController,
  tabId: string | null,
  point: { cssX: number; cssY: number },
  detail: { x: number; y: number; action: 'click' | 'type' },
): Promise<unknown> {
  try {
    return await controller.executeJS(tabId, buildClickPointLabelProbeJs(point.cssX, point.cssY))
  } catch (error) {
    if (detail.action === 'click') return null
    const message = error instanceof Error ? error.message : String(error)
    throw new ToolDomainError(
      ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code,
      `无法确认坐标输入目标是否安全，已拒绝执行。请改用明确 selector/target_id，或引导用户亲自完成。`,
      {
        x: detail.x,
        y: detail.y,
        reason: 'coordinate_target_probe_failed',
        probeError: message,
      },
    )
  }
}

/** Probe of the currently focused field. Printable keystrokes land in the
 * existing focus owner, so password inputs remain a structural special case. */
export function buildFocusedFieldProbeJs(): string {
  return `(() => {
    const __READY_FOCUSED_FIELD_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const el = document.activeElement;
    if (!el || el === document.body) return { inputLabel: '', password: false };
    return {
      inputLabel: readyInputSemanticsLabel(el),
      password: readyIsPasswordField(el),
    };
  })()`
}

/**
 * D18-c（真机第十四轮实锚）：type_at 的聚焦点击落在不可聚焦位置时，焦点
 * 滞留在上一个控件，导致正文打进错误字段且模型无法感知。
 * 4 分钟。打字前探测点击后的真实焦点：kind=none（焦点回落 body）必须
 * 响亮拒绝打字；kind=frame（跨帧编辑器）无法验证放行；kind=editable /
 * non_editable 按可编辑性裁决。
 */
export function buildFocusedEditableProbeJs(): string {
  return `(() => {
    const __READY_FOCUSED_EDITABLE_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const el = document.activeElement;
    const documentFocused = document.hasFocus();
    const documentReady = document.readyState === 'interactive' || document.readyState === 'complete';
    if (!el || el === document.body || el === document.documentElement) {
      return { kind: 'none', tag: el === document.body ? 'body' : 'html', label: '', password: false, documentFocused, documentReady };
    }
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'iframe' || tag === 'frame' || tag === 'webview' || tag === 'object' || tag === 'embed') {
      return { kind: 'frame', tag, label: '', password: false, documentFocused, documentReady };
    }
    const editable = readyIsEditableField(el);
    // D18-d：容量与形态信号——maxLength 装不下长文本的字段（标题框）与
    // 单行 input 必须能被工具层机械识别并拒打（第十六轮实锚：typedInto
    // 如实报告"输入标题"三次，模型三次无视继续灌——只报不拒救不了循环）。
    const rawMax = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? Number(el.maxLength) : -1;
    return {
      kind: editable ? 'editable' : 'non_editable',
      tag,
      label: editable ? readyInputSemanticsLabel(el) : readyClickSemanticsLabel(el),
      password: readyIsPasswordField(el),
      maxLength: rawMax > 0 ? rawMax : null,
      singleLine: el instanceof HTMLInputElement,
      documentFocused,
      documentReady,
    };
  })()`
}

/**
 * D18-c：打完字回读文本真实落点（焦点元素身份 + 内容头部），让"打进了
 * 哪个框"在同一次工具结果里可见。密码框不回显内容。
 */
export function buildTypedIntoProbeJs(expectedText?: string): string {
  return `(() => {
    const __READY_TYPED_INTO_PROBE__ = true;
    ${buildTargetSemanticsLibraryJs()}
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const tag = String(el.tagName || '').toLowerCase();
    const password = readyIsPasswordField(el);
    let text = '';
    if (!password) {
      if ('value' in el && typeof el.value === 'string') text = el.value;
      else text = String(el.innerText || el.textContent || '');
    }
    const expected = ${expectedText === undefined ? 'null' : JSON.stringify(expectedText)};
    const normalizeExact = (value) => String(value ?? '')
      .normalize('NFC')
      .replace(/\\r\\n?/g, '\\n')
      .trim();
    return {
      tag,
      label: readyInputSemanticsLabel(el),
      password,
      textHead: password ? '' : text.replace(/\\s+/g, ' ').trim().slice(0, 80),
      textLength: password ? 0 : text.length,
      textMatchesExpected: password || expected === null ? null : normalizeExact(text) === normalizeExact(expected),
    };
  })()`
}

/**
 * Convert an in-page guard marker into the structured domain refusal
 * (ToolDomainError flows through the browser catch to the dispatcher).
 */
export function throwIfLiveTargetGuardBlocked(result: unknown, detail: Record<string, unknown>): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return
  const record = result as Record<string, unknown>
  const errorKind = String(record.errorKind || '')
  if (errorKind !== 'credential_confirmation_required' && errorKind !== 'file_input_requires_upload') return
  throw new ToolDomainError(
    errorKind,
    errorKind === 'credential_confirmation_required'
      ? 'The live target is a password field and requires a one-shot typed confirmation.'
      : 'The live target is a file input; use browser_upload with a bound attachment.',
    { ...detail, liveTargetKind: record.liveTargetKind || null },
  )
}

export function buildBrowserActionDeltaJs(): string {
  return `(() => ({
    url: String(location.href || ''),
    title: String(document.title || ''),
    bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000)
  }))()`
}
