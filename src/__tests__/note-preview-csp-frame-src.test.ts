/**
 * The renderer CSP `frame-src` directive must permit every external player
 * origin that `NotePreview` can mount as an `<iframe>`. Missing entries
 * cause the iframe to render as an empty black box without any console
 * error visible to the user — the exact failure mode we hit with B 站
 * before whitelisting `player.bilibili.com`.
 *
 * Pin the contract so a future CSP tightening can't silently break video
 * previews.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readIndexHtml(): string {
  return readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
}

function extractCspContent(html: string): string {
  // CSP values themselves embed single quotes (`'self'`, `'unsafe-inline'`,
  // `'nonce-…'`), so we need an attribute matcher that only terminates on
  // the surrounding quote character, not "either kind of quote".
  const cspMatch =
    html.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i) ||
    html.match(/<meta\s+http-equiv='Content-Security-Policy'[^>]*content='([^']+)'/i)
  assert.ok(cspMatch, 'index.html must declare a Content-Security-Policy meta tag')
  return cspMatch![1]
}

function extractDirective(csp: string, directive: string): string {
  const match = csp.match(new RegExp(`(?:^|;)\\s*${directive}\\s+([^;]+)`))
  assert.ok(match, `CSP must declare ${directive}`)
  return match![1].trim()
}

test('frame-src must permit player.bilibili.com so the b 站 embed iframe can load', () => {
  const csp = extractCspContent(readIndexHtml())
  const frameSrc = extractDirective(csp, 'frame-src')
  assert.match(
    frameSrc,
    /https:\/\/player\.bilibili\.com\b/,
    `frame-src must include https://player.bilibili.com, got: ${frameSrc}`,
  )
})

test('frame-src must permit YouTube no-cookie + main origins so YouTube embeds work', () => {
  const csp = extractCspContent(readIndexHtml())
  const frameSrc = extractDirective(csp, 'frame-src')
  assert.match(frameSrc, /https:\/\/www\.youtube\.com\b/, 'frame-src must include youtube.com')
  assert.match(frameSrc, /https:\/\/www\.youtube-nocookie\.com\b/, 'frame-src must include youtube-nocookie.com')
})

test('CSP keeps self + blob: + local-file: for local rendered embeds + previews', () => {
  const csp = extractCspContent(readIndexHtml())
  const frameSrc = extractDirective(csp, 'frame-src')
  assert.match(frameSrc, /\bself\b/, "frame-src must keep 'self' for in-app local rendering")
  assert.match(frameSrc, /\bblob:/, 'frame-src must keep blob: for renderer-side preview blobs')
  assert.match(frameSrc, /\blocal-file:/, 'frame-src must keep local-file: for ebook / media preview')
})
