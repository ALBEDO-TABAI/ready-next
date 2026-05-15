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

test('document source editor soft-wraps long markdown lines inside narrow split panes', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(markdownEditor, /className="document-source-textarea /)
  assert.match(markdownEditor, /whiteSpace:\s*'pre-wrap'/)
  assert.match(markdownEditor, /overflowWrap:\s*'anywhere'/)
  assert.match(markdownEditor, /wordBreak:\s*'break-word'/)
  assert.doesNotMatch(markdownEditor, /whiteSpace:\s*'pre',/)
  assert.match(styles, /body\.resizing \.document-source-textarea\s*\{[\s\S]*white-space:\s*pre !important;/)
  assert.match(styles, /body\.resizing \.document-source-textarea\s*\{[\s\S]*overflow-wrap:\s*normal !important;/)
  assert.match(styles, /body\.resizing \.document-source-textarea\s*\{[\s\S]*word-break:\s*normal !important;/)
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
  assert.match(documentMode, /anchorTitle: captureTextareaAnchor\(element, content\) \|\| capturePreviewAnchor\(element\)/)
  assert.match(documentMode, /restoreAnchorScroll\(element, snapshot, content\)/)
  assert.match(documentMode, /findNearestHeadingTitle\(content, lineNumber\)/)
  assert.match(documentMode, /findHeadingLine\(content, snapshot\.anchorTitle\)/)

  const notePreview = readWorkspaceFile('src/renderer/components/document/NotePreview.tsx')
  assert.match(notePreview, /data-ready-heading-title=\{extractMarkdownText\(children\)\}/)
  assert.match(notePreview, /data-ready-mermaid="true"/)
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
  assert.match(documentMode, /const restoreDocumentLayoutFreezeRef = useRef<\(\(\) => void\) \| null>\(null\)/)
  assert.match(documentMode, /freezeVisibleDocumentLayoutWidths\(\)/)
  assert.match(documentMode, /primarySplitPaneRef\.current\.style\.flexBasis = `\$\{nextRatio\}%`/)
  assert.match(documentMode, /onResizeStateChange=\{handleSplitResizeStateChange\}/)
  assert.match(documentMode, /setDocumentSplitRatio\(nextRatio\)/)
  assert.doesNotMatch(documentMode, /setDocumentSplitRatio\(documentSplitRatio \+ deltaPercent\)/)
})

test('document resize freezes heavy content layout only while dragging', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const ebookViewer = readWorkspaceFile('src/renderer/components/document/EbookViewer.tsx')
  const layoutFreeze = readWorkspaceFile('src/renderer/modules/document/documentLayoutFreeze.ts')

  assert.match(markdownEditor, /className="document-editor-layout"/)
  assert.match(markdownEditor, /className="document-preview-layout"/)
  assert.match(ebookViewer, /className="ebook-viewer-layout h-full min-h-0"/)

  assert.match(layoutFreeze, /\.document-editor-layout/)
  assert.match(layoutFreeze, /\.document-preview-layout/)
  assert.match(layoutFreeze, /\.ebook-viewer-layout/)
  assert.match(layoutFreeze, /getBoundingClientRect\(\)/)
  assert.match(layoutFreeze, /element\.style\.width = frozenWidth/)
  assert.match(layoutFreeze, /element\.style\.minWidth = frozenWidth/)
  assert.match(layoutFreeze, /element\.style\.maxWidth = 'none'/)
  assert.match(layoutFreeze, /return \(\) => \{/)
})
