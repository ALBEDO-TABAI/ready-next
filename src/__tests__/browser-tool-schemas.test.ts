import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_TOOL_SCHEMAS } from '../main/modules/tools/schemas/browser-tool-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'

test('the canonical schema map exactly matches the 31 public browser tools', () => {
  assert.deepEqual(Object.keys(BROWSER_TOOL_SCHEMAS), BROWSER_PUBLIC_TOOL_NAMES)
  assert.equal(new Set(BROWSER_PUBLIC_TOOL_NAMES).size, 31)
})

test('every public browser schema derives a model parameter list', () => {
  for (const name of BROWSER_PUBLIC_TOOL_NAMES) {
    const params = zodObjectToParamList(BROWSER_TOOL_SCHEMAS[name])
    assert.ok(Array.isArray(params), `${name} must derive parameters`)
    assert.equal(new Set(params.map((param) => param.name)).size, params.length, `${name} parameter names must be unique`)
  }
})

test('semantic action schemas accept each locator form and reject malformed enum values', () => {
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ target_id: 'ref' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ selector: '#save' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ text: 'Save' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ x: 500, y: 500 }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_type.safeParse({ target_id: 'ref', text: 'hello' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_navigate.safeParse({ action: 'sideways' }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_dialog.safeParse({ action: 'ignore' }).success, false)
})

test('removed self-authorization claims are absent from every public schema', () => {
  for (const name of BROWSER_PUBLIC_TOOL_NAMES) {
    const paramNames = zodObjectToParamList(BROWSER_TOOL_SCHEMAS[name]).map((param) => param.name)
    assert.ok(!paramNames.includes('expected_effects'), `${name} must not accept expected_effects`)
    assert.ok(!paramNames.includes('confirmed_via'), `${name} must not accept confirmed_via`)
  }
})

test('download and eval schemas expose bounded runtime controls without raw-cookie export', () => {
  const downloadParams = zodObjectToParamList(BROWSER_TOOL_SCHEMAS.browser_download).map((param) => param.name)
  assert.ok(downloadParams.includes('max_total_bytes'))
  const evalParams = zodObjectToParamList(BROWSER_TOOL_SCHEMAS.browser_eval).map((param) => param.name)
  assert.ok(evalParams.includes('timeout_ms'))
  assert.ok(evalParams.includes('max_result_bytes'))
  const sessionParams = zodObjectToParamList(BROWSER_TOOL_SCHEMAS.browser_session).map((param) => param.name)
  assert.ok(!sessionParams.some((name) => /cookie.*export|token|secret/i.test(name)))
})
