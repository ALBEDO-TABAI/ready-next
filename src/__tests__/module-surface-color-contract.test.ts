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
  const documentEnterOverlay = readWorkspaceFile('src/renderer/components/document/DocumentEnterOverlay.tsx')
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')

  assert.match(styles, /--workbench-module-surface-bg:/)
  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*?--workbench-module-surface-bg:\s*var\(--lg-material-panel\);/,
  )

  assert.match(documentMode, /background: 'var\(--workbench-module-surface-bg\)'/)
  assert.match(markdownEditor, /background: 'var\(--workbench-module-surface-bg\)'/)
  assert.match(documentEnterOverlay, /background: 'var\(--workbench-module-surface-bg\)'/)
  assert.match(rssMode, /background: 'var\(--workbench-module-surface-bg\)'/)
})
