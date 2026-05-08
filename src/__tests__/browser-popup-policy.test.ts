import { describe, it } from 'node:test'
import assert from 'node:assert'
import { READY_BROWSER_BLANK_URL } from '../shared/browser-defaults'
import { decidePopupPolicy, isAllowedBrowserURL, shouldAllowBrowserPermission } from '../main/modules/browser-engine/popup-policy'

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

  it('should allow only the Ready blank data page as an internal browser URL', () => {
    assert.strictEqual(isAllowedBrowserURL(READY_BROWSER_BLANK_URL), true)
    assert.strictEqual(isAllowedBrowserURL('data:text/html,external'), false)
  })

  it('should enforce media permission only on secure origin', () => {
    assert.strictEqual(shouldAllowBrowserPermission('camera', 'http://example.com'), false)
    assert.strictEqual(shouldAllowBrowserPermission('camera', 'https://example.com'), false)
  })

  it('should only auto-grant low-risk browser permissions', () => {
    assert.strictEqual(shouldAllowBrowserPermission('fullscreen', 'https://example.com'), true)
    assert.strictEqual(shouldAllowBrowserPermission('notifications', 'https://example.com'), false)
    assert.strictEqual(shouldAllowBrowserPermission('serial', 'https://example.com'), false)
  })
})
