/**
 * Phase 3 — deriveAgentErrorContract() mapping tests.
 *
 * Covers every error shape we expect to hit the runtime-error emit boundary
 * and pins recoverable/errorKind outputs. Pure unit test — no electron.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ToolAbortError,
  ToolDomainError,
  ToolHostUnavailableError,
} from '../main/modules/tools/tool-errors'
import { deriveAgentErrorContract } from '../main/modules/claude-bridge/error-contract'

test('ToolDomainError maps to custom errorKind + recoverable=true', () => {
  const error = new ToolDomainError('widget_not_found', 'Widget w-1 missing', { widgetId: 'w-1' })
  const contract = deriveAgentErrorContract(error)
  assert.equal(contract.errorKind, 'widget_not_found')
  assert.equal(contract.recoverable, true)
  assert.equal(contract.toolName, undefined)
})

test('ToolHostUnavailableError maps to host_unavailable + terminal + carries toolName', () => {
  const error = new ToolHostUnavailableError('browser_click', 'browser controller is not available')
  const contract = deriveAgentErrorContract(error)
  assert.equal(contract.errorKind, 'host_unavailable')
  assert.equal(contract.recoverable, false)
  assert.equal(contract.toolName, 'browser_click')
})

test('ToolAbortError maps to aborted + terminal', () => {
  const contract = deriveAgentErrorContract(new ToolAbortError())
  assert.equal(contract.errorKind, 'aborted')
  assert.equal(contract.recoverable, false)
})

test('Legacy-shaped AbortError (name-only) still maps to aborted + terminal', () => {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  const contract = deriveAgentErrorContract(error)
  assert.equal(contract.errorKind, 'aborted')
  assert.equal(contract.recoverable, false)
})

test('HTTP 429 → rate_limit + recoverable', () => {
  const contract = deriveAgentErrorContract(new Error('HTTP 429 too many requests'))
  assert.equal(contract.errorKind, 'rate_limit')
  assert.equal(contract.recoverable, true)
})

test('Invalid api key → auth + terminal', () => {
  const contract = deriveAgentErrorContract(new Error('invalid api key'))
  assert.equal(contract.errorKind, 'auth')
  assert.equal(contract.recoverable, false)
})

test('Context overflow → terminal', () => {
  const contract = deriveAgentErrorContract(new Error('prompt is too long'))
  assert.equal(contract.errorKind, 'context_overflow')
  assert.equal(contract.recoverable, false)
})

test('Transient network error → recoverable', () => {
  const contract = deriveAgentErrorContract(new Error('socket hang up'))
  assert.equal(contract.errorKind, 'transient')
  assert.equal(contract.recoverable, true)
})

test('Timeout → recoverable (timeout_model by default)', () => {
  const contract = deriveAgentErrorContract(new Error('请求超时'))
  assert.equal(contract.errorKind, 'timeout_model')
  assert.equal(contract.recoverable, true)
})

test('Unclassifiable Error → unknown + terminal', () => {
  const contract = deriveAgentErrorContract(new Error('something weird just happened'))
  assert.equal(contract.errorKind, 'unknown')
  assert.equal(contract.recoverable, false)
})

test('String throw → unknown + terminal', () => {
  const contract = deriveAgentErrorContract('x')
  assert.equal(contract.errorKind, 'unknown')
  assert.equal(contract.recoverable, false)
})

test('null / undefined throws → unknown + terminal without crashing', () => {
  const nullContract = deriveAgentErrorContract(null)
  assert.equal(nullContract.errorKind, 'unknown')
  assert.equal(nullContract.recoverable, false)
  const undefinedContract = deriveAgentErrorContract(undefined)
  assert.equal(undefinedContract.errorKind, 'unknown')
  assert.equal(undefinedContract.recoverable, false)
})

test('options.toolName is preserved and overrides any toolName on the error', () => {
  const error = new ToolHostUnavailableError('browser_click', 'offline')
  const contract = deriveAgentErrorContract(error, { toolName: 'override_tool' })
  assert.equal(contract.toolName, 'override_tool')
})

test('Plain object with toolName field surfaces toolName', () => {
  const contract = deriveAgentErrorContract({ toolName: 'skill_get_state', message: 'x' } as unknown as Error)
  assert.equal(contract.toolName, 'skill_get_state')
})

test('Domain error with a kind that the classifier does NOT recognize stays recoverable=true', () => {
  // Defensive: any user-defined errorKind should be treated as recoverable
  // (the model sees structured detail and decides what to do next).
  const contract = deriveAgentErrorContract(new ToolDomainError('custom_domain_kind', 'x'))
  assert.equal(contract.errorKind, 'custom_domain_kind')
  assert.equal(contract.recoverable, true)
})
