import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { READY_BROWSER_BLANK_URL } from '../shared/browser-defaults'
import { decidePopupPolicy, isAllowedBrowserURL, shouldAllowBrowserPermission } from '../main/modules/browser-engine/popup-policy'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

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

  it('should convert about:blank child popups to tabs when they navigate to regular websites', () => {
    const manager = readWorkspaceFile('src/main/modules/browser-engine/auth-popup-manager.ts')
    const childNavigateBlock = manager.slice(
      manager.indexOf("contents.on('will-navigate'"),
      manager.indexOf("if (!/^https?:/i.test(url))"),
    )

    assert.match(childNavigateBlock, /decidePopupPolicy\(\{ url \}\)/)
    assert.match(childNavigateBlock, /decision\.mode !== 'allow-popup'/)
    assert.match(childNavigateBlock, /this\.openInTab\(url\)/)
    assert.match(childNavigateBlock, /BrowserWindow\.fromWebContents\(contents\)/)
    assert.match(childNavigateBlock, /owner\.close\(\)/)
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

  it('should allow local HTML only for explicit top-level browser navigation', () => {
    assert.strictEqual(isAllowedBrowserURL('file:///tmp/demo.html'), false)
    assert.strictEqual(isAllowedBrowserURL('file:///tmp/demo.html', { allowLocalHtml: true }), true)
    assert.strictEqual(isAllowedBrowserURL('local-file:///tmp/demo.htm', { allowLocalHtml: true }), true)
    assert.strictEqual(isAllowedBrowserURL('file:///tmp/demo.pdf', { allowLocalHtml: true }), false)
  })

  it('should keep local HTML popups inside Ready when opened from local HTML', () => {
    const decision = decidePopupPolicy({
      url: 'file:///tmp/popup.html',
      referrer: 'file:///tmp/page-one.html',
      disposition: 'foreground-tab',
    })
    assert.strictEqual(decision.mode, 'open-tab')
    assert.strictEqual(decision.reason, 'regular-local-html')
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
