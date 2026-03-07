import { describe, it } from 'node:test'
import assert from 'node:assert'
import { decidePopupPolicy, shouldAllowBrowserPermission } from '../main/modules/browser-engine/popup-policy'

describe('browser popup policy', () => {
  it('should allow auth bootstrap popup', () => {
    const decision = decidePopupPolicy({ url: 'about:blank', disposition: 'new-window' })
    assert.strictEqual(decision.mode, 'allow-popup')
    assert.strictEqual(decision.authLike, true)
  })

  it('should allow auth host popup', () => {
    const decision = decidePopupPolicy({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      disposition: 'new-window',
      features: 'width=520,height=720',
    })
    assert.strictEqual(decision.mode, 'allow-popup')
  })

  it('should open regular web links in new tab', () => {
    const decision = decidePopupPolicy({
      url: 'https://example.com/docs',
      disposition: 'foreground-tab',
    })
    assert.strictEqual(decision.mode, 'open-tab')
  })

  it('should deny unsafe protocol and route external', () => {
    const decision = decidePopupPolicy({
      url: 'javascript:alert(1)',
      disposition: 'new-window',
    })
    assert.strictEqual(decision.mode, 'external')
  })

  it('should enforce media permission only on secure origin', () => {
    assert.strictEqual(shouldAllowBrowserPermission('camera', 'http://example.com'), false)
    assert.strictEqual(shouldAllowBrowserPermission('camera', 'https://example.com'), true)
  })
})
