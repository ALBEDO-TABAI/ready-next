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

  it('opens an ordinary page as a tab even on a site that also offers sign-in', () => {
    for (const url of [
      'https://x.com/Kling_ai/status/2122183574308700468',
      'https://github.com/electron/electron',
      'https://www.instagram.com/p/abc/',
      'https://example.com/blog/verifying-claims?next=/login',
    ]) {
      for (const disposition of ['foreground-tab', 'new-window']) {
        assert.strictEqual(decidePopupPolicy({ url, disposition }).mode, 'open-tab', `${url} ${disposition}`)
      }
    }
  })

  it('keeps a sign-in flow in a small window', () => {
    // third-party authorization, however it was opened
    assert.strictEqual(decidePopupPolicy({ url: 'https://x.com/i/oauth2/authorize?client_id=1', disposition: 'foreground-tab' }).mode, 'allow-popup')
    assert.strictEqual(decidePopupPolicy({ url: 'https://github.com/login/oauth/authorize', disposition: 'foreground-tab' }).mode, 'allow-popup')
    // a site's own sign-in page, only when the site asked for a window
    assert.strictEqual(decidePopupPolicy({ url: 'https://example.com/login', features: 'width=500,height=600' }).mode, 'allow-popup')
    assert.strictEqual(decidePopupPolicy({ url: 'https://example.com/login', disposition: 'foreground-tab' }).mode, 'open-tab')
    // the return leg inside an open sign-in window stays there
    assert.strictEqual(decidePopupPolicy({ url: 'https://example.com/auth/callback?code=1', insidePopup: true }).mode, 'allow-popup')
    assert.strictEqual(decidePopupPolicy({ url: 'https://example.com/home', insidePopup: true }).mode, 'open-tab')
  })

  it('should pass source lane context when window-open falls back to a tab', () => {
    const service = readWorkspaceFile('src/main/modules/browser-engine/window-open-service.ts')
    assert.match(service, /interface WindowOpenLaneContext/)
    assert.match(service, /openInTab: \(url: string, context: WindowOpenLaneContext\) => void/)
    assert.match(service, /this\.openInTab\(details\.url, context\)/)
  })

  it('should convert about:blank child popups to tabs when they navigate to regular websites', () => {
    const manager = readWorkspaceFile('src/main/modules/browser-engine/auth-popup-manager.ts')
    const childNavigateBlock = manager.slice(
      manager.indexOf("contents.on('will-navigate'"),
      manager.indexOf("if (!/^https?:/i.test(url))"),
    )

    assert.match(childNavigateBlock, /decidePopupPolicy\(\{ url, insidePopup: true \}\)/)
    assert.match(childNavigateBlock, /decision\.mode !== 'allow-popup'/)
    assert.match(childNavigateBlock, /this\.openInTab\(url, this\.contentContexts\.get\(contents\.id\) \?\? \{\}\)/)
    assert.match(childNavigateBlock, /BrowserWindow\.fromWebContents\(contents\)/)
    assert.match(childNavigateBlock, /owner\.close\(\)/)
  })

  it('should preserve source lane context through auth popup fallback', () => {
    const manager = readWorkspaceFile('src/main/modules/browser-engine/auth-popup-manager.ts')
    assert.match(manager, /interface PopupOpenInTabContext/)
    assert.match(manager, /contentContexts = new Map/)
    assert.match(manager, /pendingPopupFallbacks = new Map<number, \{ timer: NodeJS\.Timeout; url: string; context: PopupOpenInTabContext \}>/)
    assert.match(manager, /this\.openInTab\(pending\.url, pending\.context\)/)
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
