/**
 * P1.5 contract tests for the privacy sanitizer bundle.
 *
 * We don't execute the bundle inside a real Chrome (that would need a live
 * BrowserView). Instead we validate:
 *   - `buildSanitizerBundle()` returns a non-empty IIFE string of bounded size.
 *   - The script source mentions every required strip target (inputs,
 *     textareas, contenteditable, csrf meta, iframes) AND does NOT mention
 *     any forbidden API (localStorage, sessionStorage, indexedDB, cookie,
 *     password autofill).
 *   - `decodeSanitizerResult()` validates expected shapes and rejects
 *     malformed input.
 *
 * This is a structure test — the actual DOM behavior is verified separately
 * by Phase 1 fixtures (P1.9, captured against a real BrowserView).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  buildSanitizerBundle,
  decodeSanitizerResult,
} from '../main/modules/clipping/privacy-sanitizer'

describe('privacy-sanitizer · bundle source', () => {
  it('returns a bounded IIFE source', () => {
    const source = buildSanitizerBundle()
    assert.ok(source.startsWith('(() => {'))
    assert.ok(source.length > 500 && source.length < 10_000, `bundle size ${source.length} out of expected bounds`)
  })

  it('strips all required form-control kinds', () => {
    const source = buildSanitizerBundle()
    assert.match(source, /querySelectorAll\('input'\)/)
    assert.match(source, /querySelectorAll\('textarea'\)/)
    assert.match(source, /querySelectorAll\('select'\)/)
    assert.match(source, /querySelectorAll\('\[contenteditable\]'\)/)
    assert.match(source, /querySelectorAll\('iframe'\)/)
  })

  it('strips CSRF / authenticity meta names', () => {
    const source = buildSanitizerBundle()
    // Look for the regex SOURCE inside the bundle (it builds an in-page RegExp).
    assert.match(source, /csrf/)
    assert.match(source, /authenticity/)
    // The bundle embeds the literal regex source `set[-_]?cookie`.
    assert.ok(source.includes('set[-_]?cookie'), 'bundle missing set-cookie regex source')
  })

  it('never references storage APIs or cookies', () => {
    const source = buildSanitizerBundle()
    // The sanitizer's prohibition is structural: the bundle must not even
    // mention these APIs. If a future change adds them, this test fails.
    assert.equal(/localStorage/.test(source), false, 'localStorage reference forbidden')
    assert.equal(/sessionStorage/.test(source), false, 'sessionStorage reference forbidden')
    assert.equal(/indexedDB/.test(source), false, 'indexedDB reference forbidden')
    assert.equal(/document\.cookie/.test(source), false, 'document.cookie reference forbidden')
    assert.equal(/password\b/.test(source), true, 'password type recognition kept (strips type=password inputs)')
  })

  it('refuses non-http(s) protocols', () => {
    const source = buildSanitizerBundle()
    assert.match(source, /protocol !== 'http:' && protocol !== 'https:'/)
    assert.match(source, /unsupported_protocol/)
  })

  it('preservePagination flag is wired', () => {
    const withFlag = buildSanitizerBundle({ preservePagination: true })
    const withoutFlag = buildSanitizerBundle({ preservePagination: false })
    assert.notEqual(withFlag, withoutFlag)
  })
})

describe('privacy-sanitizer · decodeSanitizerResult', () => {
  it('throws on null / non-object input', () => {
    assert.throws(() => decodeSanitizerResult(null))
    assert.throws(() => decodeSanitizerResult('string'))
    assert.throws(() => decodeSanitizerResult(42))
  })

  it('accepts a well-formed ok result', () => {
    const decoded = decodeSanitizerResult({
      ok: true,
      html: '<html><body>hi</body></html>',
      title: 'Test',
      url: 'https://example.com/',
      finalUrl: 'https://example.com/',
      lang: 'en',
      stable: true,
      sanitizationSummary: {
        inputsStripped: 1,
        hiddenFieldsStripped: 0,
        textareasStripped: 0,
        selectsStripped: 0,
        contentEditableStripped: 0,
        checkedToggled: 0,
        csrfMetasStripped: 1,
        iframesSkipped: 0,
      },
    })
    assert.equal(decoded.result.ok, true)
    if (decoded.result.ok) {
      assert.equal(decoded.result.title, 'Test')
      assert.equal(decoded.result.sanitizationSummary.inputsStripped, 1)
    }
    assert.equal(decoded.audit.stable, true)
    assert.equal(decoded.audit.htmlBytes, '<html><body>hi</body></html>'.length)
  })

  it('accepts the unsupported_protocol error shape', () => {
    const decoded = decodeSanitizerResult({ ok: false, reason: 'unsupported_protocol' })
    assert.equal(decoded.result.ok, false)
    if (!decoded.result.ok) assert.equal(decoded.result.reason, 'unsupported_protocol')
    assert.equal(decoded.audit.rejectedReason, 'unsupported_protocol')
  })

  it('rejects unknown error reasons', () => {
    assert.throws(() => decodeSanitizerResult({ ok: false, reason: 'something-else' }))
  })
})
