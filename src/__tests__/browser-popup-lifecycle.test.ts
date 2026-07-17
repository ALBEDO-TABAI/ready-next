import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserPopupProtection } from '../main/modules/browser-engine/browser-popup-protection'

test('an auth popup request protects its source tab only while the flow is pending', () => {
  const changes: string[] = []
  const protection = new BrowserPopupProtection((tabId) => changes.push(tabId))

  protection.markPending(42, 'tab-42')
  assert.equal(protection.isProtected('tab-42'), true)

  protection.clearPending(42)
  assert.equal(protection.isProtected('tab-42'), false)
  assert.deepEqual(changes, ['tab-42', 'tab-42'])
})

test('an active auth popup keeps protection after the fallback timer clears', () => {
  const protection = new BrowserPopupProtection()
  protection.markPending(42, 'tab-42')
  const release = protection.beginPopup('tab-42')
  protection.clearPending(42)
  assert.equal(protection.isProtected('tab-42'), true)

  release()
  release()
  assert.equal(protection.isProtected('tab-42'), false)
})
