import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readRendererStyles } from './utils/read-renderer-styles'

// Apply the shipped styles to the two surface hierarchies. JSDOM reports CSS
// variable references, not painted pixels; real-window acceptance owns the latter.
test('Inkwell pages and 资讯 sit on paper straight on the workspace (W1 DL2)', () => {
  const dom = new JSDOM(`<html data-theme="dark" data-skin="liquid-glass"><head></head><body>
    <div class="ink-scope ink-doc-app"><div class="ink-column rn-panel"><div class="ink-tabbar rn-panel__head"></div><main class="ink-main rn-panel__body"><div class="document-content-frame"><div class="document-preview-surface"></div></div></main></div></div>
    <div class="rss-mode-shell"><div class="rss-feed-sheet rn-panel"><div class="rss-feed-list"></div></div></div>
  </body></html>`, { url: 'http://localhost' })
  try {
    const style = dom.window.document.createElement('style')
    style.textContent = [readRendererStyles(), ...[
      'src/renderer/styles/rss-workspace.css',
      'src/renderer/components/document/documentFloatingPanels.css',
      'src/renderer/modules/document/ink/ink.css',
    ].map(path => readFileSync(path, 'utf8'))].join('\n')
    dom.window.document.head.append(style)
    const computed = (selector: string) => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!)
    // Like the calendar, the document workspace has no stage layer of its own: the panels touch the workspace edges.
    assert.equal(computed('.ink-doc-app').backgroundColor, 'rgba(0, 0, 0, 0)')
    // V11: the panel (.rn-panel in materials.css, a cascade layer JSDOM skips) is the one glass; ink.css paints no
    // surface of its own on the panel, its head row or the page that is its body (no panel on a panel).
    assert.equal(computed('.ink-column').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.ink-tabbar').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.ink-main').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.ink-doc-app').display, 'flex')
    assert.equal(computed('.ink-main').display, 'flex')
    assert.equal(computed('.document-content-frame').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.document-preview-surface').backgroundColor, 'rgba(0, 0, 0, 0)')
    // V11: 资讯's panel (head row and content) is one sheet, painted by .rn-panel alone (materials.css, checked by its
    // source below); the module styles paint nothing on it, so there is no panel on a panel.
    assert.equal(computed('.rss-feed-sheet').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.rss-feed-sheet').boxShadow, '')
    assert.match(readFileSync('src/renderer/design/next/materials.css', 'utf8'), /\.rn-panel \{[^}]*background: var\(--rn-sheet\);[^}]*box-shadow: var\(--rn-sheet-shadow\);/)
    assert.equal(computed('.rss-feed-list').backgroundColor, 'rgba(0, 0, 0, 0)')
  } finally { dom.window.close() }
})
