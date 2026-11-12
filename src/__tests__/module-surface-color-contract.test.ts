import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readRendererStyles } from './utils/read-renderer-styles'

// Apply the shipped styles to the two surface hierarchies. JSDOM reports CSS
// variable references, not painted pixels; real-window acceptance owns the latter.
test('Inkwell pages sit on paper panels straight on the workspace while RSS retains its module surface', () => {
  const dom = new JSDOM(`<html data-theme="dark" data-skin="liquid-glass"><head></head><body>
    <div class="ink-scope ink-doc-app"><main class="ink-main"><div class="document-content-frame"><div class="document-preview-surface"></div></div></main></div>
    <div class="rss-mode-shell"><div class="rss-feed-sheet"><div class="rss-feed-list"></div></div></div>
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
    assert.equal(computed('html').getPropertyValue('--workbench-module-surface-bg'), 'var(--lg-material-panel)')
    // Like the calendar, the document workspace has no stage layer of its own: the panels touch the workspace edges.
    assert.equal(computed('.ink-doc-app').backgroundColor, 'rgba(0, 0, 0, 0)')
    // The page is the paper material (.rn-sheet in materials.css, a cascade layer JSDOM skips): ink.css paints no surface of its own.
    assert.equal(computed('.ink-main').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.ink-doc-app').display, 'flex')
    assert.equal(computed('.ink-main').display, 'flex')
    assert.equal(computed('.document-content-frame').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.document-preview-surface').backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computed('.rss-feed-sheet').background, 'var(--workbench-module-surface-bg)')
    assert.equal(computed('.rss-feed-list').backgroundColor, 'rgba(0, 0, 0, 0)')
  } finally { dom.window.close() }
})
