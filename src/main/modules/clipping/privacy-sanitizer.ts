/**
 * P1.5 — Privacy sanitizer for the host-IPC `browser:clipCurrentTab` path.
 *
 * This module *generates* the JavaScript string that will be passed via
 * `webContents.executeJavaScript(code, false)` into the BrowserView page
 * context. It does NOT run in main; it produces a payload to be injected.
 *
 * Sanitization contract (Codex iter-2 Q5 + iter-3 confirm):
 *   - Strip every form-control value/draft: `<input value>`, `<textarea>`
 *     textContent, `<select>` selected, checkbox/radio `checked`,
 *     `contenteditable` text.
 *   - Strip CSRF / auth meta tags by name & property.
 *   - Strip URL query string from saved frontmatter URL (caller can opt-out
 *     per-preset by setting `preservePagination: true`).
 *   - Skip iframe contents (do NOT traverse cross-origin iframes; do NOT
 *     serialize same-origin iframe innerHTML to avoid copying logged-in IM
 *     transcripts that may be embedded as iframes).
 *   - Do NOT pierce shadow DOM (we accept reduced fidelity in favour of
 *     not exposing component internal state).
 *   - NEVER query IndexedDB / localStorage / sessionStorage / cache /
 *     cookies / passwords. The injected script does not even reference
 *     these APIs.
 *   - Refuse non-http(s) protocols (file://, chrome://, devtools://, about:).
 *
 * Result shape (returned via `executeJavaScript`):
 *   {
 *     ok: true,
 *     html: string,             // cleaned outerHTML for ReadabilityJsdomAdapter
 *     title: string,
 *     url: string,              // location.href at start
 *     finalUrl: string,         // location.href at end (stability check)
 *     lang: string,
 *     stable: boolean,          // url did not change during sanitize
 *     sanitizationSummary: {
 *       inputsStripped: number,
 *       hiddenFieldsStripped: number,
 *       textareasStripped: number,
 *       selectsStripped: number,
 *       contentEditableStripped: number,
 *       checkedToggled: number,
 *       csrfMetasStripped: number,
 *       iframesSkipped: number,
 *     }
 *   }
 * | { ok: false, reason: 'unsupported_protocol' | 'document_unavailable' }
 *
 * The bundle is intentionally pure DOM JS — no Node, no imports. We embed
 * it as a Function-expression IIFE returning its result (Electron's
 * `executeJavaScript` evaluates the script and resolves with its
 * last-expression value).
 */

export interface SanitizerOptions {
  /** Preserve querystring in saved URL (per-preset opt-out for pagination). */
  preservePagination?: boolean
}

export interface SanitizerResultOk {
  ok: true
  html: string
  title: string
  url: string
  finalUrl: string
  lang: string
  stable: boolean
  sanitizationSummary: {
    inputsStripped: number
    hiddenFieldsStripped: number
    textareasStripped: number
    selectsStripped: number
    contentEditableStripped: number
    checkedToggled: number
    csrfMetasStripped: number
    iframesSkipped: number
  }
}

export interface SanitizerResultErr {
  ok: false
  reason: 'unsupported_protocol' | 'document_unavailable'
}

export type SanitizerResult = SanitizerResultOk | SanitizerResultErr

/**
 * Build the JavaScript source string to inject via
 * `webContents.executeJavaScript(buildSanitizerBundle(opts), false)`.
 */
export function buildSanitizerBundle(opts: SanitizerOptions = {}): string {
  const preservePagination = Boolean(opts.preservePagination)
  // Note: keep this string small (<10KB). Anything Node-y must be inlined.
  return `(() => {
  const summary = {
    inputsStripped: 0,
    hiddenFieldsStripped: 0,
    textareasStripped: 0,
    selectsStripped: 0,
    contentEditableStripped: 0,
    checkedToggled: 0,
    csrfMetasStripped: 0,
    iframesSkipped: 0,
  };

  if (!document || !document.documentElement) {
    return { ok: false, reason: 'document_unavailable' };
  }
  const protocol = (location && location.protocol) || '';
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_protocol' };
  }

  const startUrl = location.href;

  // Deep clone the document body so we mutate a copy, never the live page.
  const docClone = document.cloneNode(true);
  const cloneRoot = docClone.documentElement || docClone;

  // Strip input values, hidden fields, textarea content, select state.
  for (const node of Array.from(cloneRoot.querySelectorAll('input'))) {
    const type = (node.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden' || type === 'password') {
      summary.hiddenFieldsStripped++;
      node.parentNode && node.parentNode.removeChild(node);
      continue;
    }
    if (node.hasAttribute('value')) {
      node.setAttribute('value', '');
      summary.inputsStripped++;
    }
    if (type === 'checkbox' || type === 'radio') {
      if (node.hasAttribute('checked')) {
        node.removeAttribute('checked');
        summary.checkedToggled++;
      }
    }
  }
  for (const node of Array.from(cloneRoot.querySelectorAll('textarea'))) {
    if (node.textContent && node.textContent.length > 0) {
      summary.textareasStripped++;
      node.textContent = '';
    }
  }
  for (const node of Array.from(cloneRoot.querySelectorAll('select'))) {
    let touched = false;
    for (const option of Array.from(node.querySelectorAll('option'))) {
      if (option.hasAttribute('selected')) {
        option.removeAttribute('selected');
        touched = true;
      }
    }
    if (touched) summary.selectsStripped++;
  }

  // Strip contenteditable drafts (live text in editors).
  for (const node of Array.from(cloneRoot.querySelectorAll('[contenteditable]'))) {
    const flag = (node.getAttribute('contenteditable') || '').toLowerCase();
    if (flag === 'true' || flag === '' || flag === 'plaintext-only') {
      if (node.textContent && node.textContent.trim().length > 0) {
        node.textContent = '';
        summary.contentEditableStripped++;
      }
    }
  }

  // Strip CSRF / auth meta tags.
  const csrfRe = /(csrf|xsrf|authenticity[-_]?token|auth[-_]?token|set[-_]?cookie)/i;
  for (const meta of Array.from(cloneRoot.querySelectorAll('meta'))) {
    const name = (meta.getAttribute('name') || '').toLowerCase();
    const prop = (meta.getAttribute('property') || '').toLowerCase();
    const httpEquiv = (meta.getAttribute('http-equiv') || '').toLowerCase();
    if (csrfRe.test(name) || csrfRe.test(prop) || csrfRe.test(httpEquiv)) {
      meta.parentNode && meta.parentNode.removeChild(meta);
      summary.csrfMetasStripped++;
    }
  }

  // Drop iframe content entirely. We don't traverse them — privacy + cross-
  // origin reads would throw anyway.
  for (const iframe of Array.from(cloneRoot.querySelectorAll('iframe'))) {
    iframe.removeAttribute('srcdoc');
    iframe.setAttribute('data-clip-skipped', 'iframe');
    summary.iframesSkipped++;
  }

  const title = (document.title || '').trim();
  const lang = (document.documentElement.getAttribute('lang') || '').trim();
  const html = cloneRoot.outerHTML || '';

  // Strip querystring unless explicitly preserved.
  let savedUrl = startUrl;
  if (!${preservePagination ? 'true' : 'false'}) {
    try {
      const u = new URL(startUrl);
      u.search = '';
      u.hash = '';
      savedUrl = u.toString();
    } catch {
      savedUrl = startUrl;
    }
  }

  const finalUrl = location.href;
  const stable = startUrl === finalUrl;

  return {
    ok: true,
    html,
    title,
    url: savedUrl,
    finalUrl,
    lang,
    stable,
    sanitizationSummary: summary,
  };
})()`
}

export interface DecodedSanitizerResult {
  result: SanitizerResult
  /** Raw JSON for audit logging (already PII-stripped of HTML body details). */
  audit: {
    startUrl: string
    finalUrl: string
    stable: boolean
    htmlBytes: number
    summary: SanitizerResultOk['sanitizationSummary'] | null
    rejectedReason: SanitizerResultErr['reason'] | null
  }
}

/**
 * Validate executeJavaScript output shape and produce an audit payload.
 * Throws if the result is non-object or missing required fields — caller
 * maps that to `clip_active_tab_unstable` / `clip_parse_failed`.
 */
export function decodeSanitizerResult(raw: unknown): DecodedSanitizerResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('sanitizer returned non-object')
  }
  const obj = raw as Record<string, unknown>
  if (obj.ok === false) {
    const reason = obj.reason
    if (reason !== 'unsupported_protocol' && reason !== 'document_unavailable') {
      throw new Error(`sanitizer returned unknown reason: ${String(reason)}`)
    }
    return {
      result: { ok: false, reason },
      audit: {
        startUrl: '',
        finalUrl: '',
        stable: false,
        htmlBytes: 0,
        summary: null,
        rejectedReason: reason,
      },
    }
  }
  if (obj.ok !== true) throw new Error('sanitizer returned malformed result')
  const html = String(obj.html || '')
  const url = String(obj.url || '')
  const finalUrl = String(obj.finalUrl || '')
  const stable = Boolean(obj.stable)
  const summary = obj.sanitizationSummary as SanitizerResultOk['sanitizationSummary']
  const result: SanitizerResultOk = {
    ok: true,
    html,
    title: String(obj.title || ''),
    url,
    finalUrl,
    lang: String(obj.lang || ''),
    stable,
    sanitizationSummary: {
      inputsStripped: Number(summary?.inputsStripped || 0),
      hiddenFieldsStripped: Number(summary?.hiddenFieldsStripped || 0),
      textareasStripped: Number(summary?.textareasStripped || 0),
      selectsStripped: Number(summary?.selectsStripped || 0),
      contentEditableStripped: Number(summary?.contentEditableStripped || 0),
      checkedToggled: Number(summary?.checkedToggled || 0),
      csrfMetasStripped: Number(summary?.csrfMetasStripped || 0),
      iframesSkipped: Number(summary?.iframesSkipped || 0),
    },
  }
  return {
    result,
    audit: {
      startUrl: url,
      finalUrl,
      stable,
      htmlBytes: html.length,
      summary: result.sanitizationSummary,
      rejectedReason: null,
    },
  }
}
