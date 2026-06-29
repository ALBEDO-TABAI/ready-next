import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document canvas and rss canvas share one module surface background token', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const documentPanels = readWorkspaceFile('src/renderer/components/document/DocumentFloatingPanels.tsx')
  const documentPanelCss = readWorkspaceFile('src/renderer/components/document/documentFloatingPanels.css')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(styles, /--workbench-module-surface-bg:/)
  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-module-surface-bg:\s*var\(--lg-material-panel\);/,
  )

  assert.match(documentMode, /background: 'var\(--workbench-module-surface-bg\)'/)
  assert.match(documentMode, /workbench-canvas-shell document-workbench-canvas-shell/)
  assert.match(documentMode, /className="document-workbench-body flex min-h-0 flex-1"/)
  assert.match(markdownEditor, /className="flex-1 overflow-hidden flex" style=\{\{ background: 'transparent' \}\}/)
  assert.match(documentPanels, /withProjection=\{false\}/)
  assert.match(documentPanels, /blur=\{3\}/)
  assert.match(documentPanelCss, /--ready-app-panel-glass-bg:\s*rgba\(241,\s*244,\s*249,\s*0\.96\);/)
  assert.match(documentPanelCss, /\.document-floating-panel\.ready-app-liquid-panel \.ready-app-liquid-panel__lens \{[\s\S]*opacity:\s*0\.36;/)
  assert.match(rssMode, /background: 'var\(--workbench-module-surface-bg\)'/)
  assert.match(rssFeed, /background: 'transparent'/)
  assert.match(previewBrowser, /rss-preview-surface/)
  assert.match(previewBrowser, /rss-preview-content/)
  assert.match(previewBrowser, /background: 'var\(--workbench-module-surface-bg\)'/)
  assert.match(previewBrowser, /background: 'transparent'/)
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\] \.document-content-frame \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/,
  )
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\] \.document-workbench-canvas-shell \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/,
  )
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\] \.document-workbench-body \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/,
  )
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\] \.document-editor-surface,[\s\S]*\.document-preview-surface,[\s\S]*\.rss-preview-content \{[\s\S]*background:\s*transparent !important;/,
  )
  assert.match(
    styles,
    /\.rss-mode-shell \.rss-feed-sheet \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/,
  )
})
