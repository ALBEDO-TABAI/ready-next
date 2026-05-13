import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document edit mode uses raw text editing while preview mode keeps rendered markdown presentation', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

  assert.match(markdownEditor, /viewMode === 'edit'/)
  assert.match(markdownEditor, /<textarea/)
  assert.match(markdownEditor, /value=\{tab\.content\}/)
  assert.match(markdownEditor, /onChange=\{handleRawEditorChange\}/)
  assert.match(markdownEditor, /viewMode === 'preview'/)
  assert.match(markdownEditor, /<NotePreview[\s\S]*content=\{tab\.content\}/)
})

test('document edit and preview modes share reading scroll position when remounted', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')

  assert.match(markdownEditor, /const documentScrollKey = useMemo\(\(\) => tab\.path \|\| tab\.id, \[tab\.id, tab\.path\]\)/)
  assert.match(markdownEditor, /data-ready-document-scroll-key=\{documentScrollKey\}/)

  assert.match(documentMode, /captureVisibleDocumentScrollPositions\(\)/)
  assert.match(documentMode, /restoreVisibleDocumentScrollPositions\(\)/)
  assert.match(documentMode, /useLayoutEffect\(\(\) => \{/)
  assert.match(documentMode, /onChange=\{handleEditorModeChange\}/)
  assert.match(documentMode, /\[data-ready-document-scroll-key\]/)
  assert.match(documentMode, /findCurrentScrollElement\(scope\)/)
})

test('document split divider keeps a transparent drag target with a hairline visual', () => {
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(documentMode, /className="document-split-resize-handle"/)
  assert.match(documentMode, /className="document-split-resize-handle__grip"/)
  assert.match(documentMode, /style=\{\{ gap: 0 \}\}/)

  assert.match(styles, /\.document-split-resize-handle\s*\{[\s\S]*width:\s*12px;/)
  assert.match(styles, /\.document-split-resize-handle\s*\{[\s\S]*margin:\s*0 -6px;/)
  assert.match(styles, /\.document-split-resize-handle\s*\{[\s\S]*background:\s*transparent;/)
  assert.match(styles, /\.document-split-resize-handle::before\s*\{[\s\S]*width:\s*1px;/)
  assert.match(styles, /\.document-split-resize-handle__grip\s*\{[\s\S]*opacity:\s*0;/)
})

test('document split resize applies live width without rerendering document panes on every drag frame', () => {
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')

  assert.match(documentMode, /const primarySplitPaneRef = useRef<HTMLDivElement>\(null\)/)
  assert.match(documentMode, /const liveDocumentSplitRatioRef = useRef\(documentSplitRatio\)/)
  assert.match(documentMode, /primarySplitPaneRef\.current\.style\.flexBasis = `\$\{nextRatio\}%`/)
  assert.match(documentMode, /onResizeStateChange=\{handleSplitResizeStateChange\}/)
  assert.match(documentMode, /setDocumentSplitRatio\(nextRatio\)/)
  assert.doesNotMatch(documentMode, /setDocumentSplitRatio\(documentSplitRatio \+ deltaPercent\)/)
})
