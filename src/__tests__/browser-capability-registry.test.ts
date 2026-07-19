import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_OPERATION_IDS,
  BROWSER_PUBLIC_TOOL_NAMES,
  browserOperationCapability,
  resolveBrowserCapability,
} from '../shared/browser-capability-registry'

test('every declared Browser operation resolves to one complete mechanical boundary', () => {
  for (const operationId of BROWSER_OPERATION_IDS) {
    const capability = browserOperationCapability(operationId)
    assert.equal(capability.operationId, operationId)
    assert.ok(['control', 'observe', 'mutate'].includes(capability.mode))
    assert.ok(capability.handlerGroup)
  }
  assert.equal(new Set(BROWSER_PUBLIC_TOOL_NAMES).size, BROWSER_PUBLIC_TOOL_NAMES.length)
  assert.equal(resolveBrowserCapability('browser_unknown'), null)
})

test('tab management is workflow-bound without borrowing an unrelated page lease', () => {
  for (const [action, operationId] of [
    ['open', 'tabs_open'],
    ['switch', 'tabs_switch'],
    ['close', 'tabs_close'],
  ] as const) {
    const capability = resolveBrowserCapability('browser_tabs', { action })
    assert.equal(capability?.operationId, operationId)
    assert.equal(capability?.requiresWorkflowRoute, true)
    assert.equal(capability?.requiresDocument, false)
    assert.equal(capability?.requiresPageLease, false)
  }
})
