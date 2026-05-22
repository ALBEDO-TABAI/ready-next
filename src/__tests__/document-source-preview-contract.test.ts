import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document edit mode uses raw text editing while preview mode keeps rendered markdown presentation', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const notePreview = readWorkspaceFile('src/renderer/components/document/NotePreview.tsx')

  assert.match(markdownEditor, /viewMode === 'edit'/)
  assert.match(markdownEditor, /<textarea/)
  assert.match(markdownEditor, /value=\{tab\.content\}/)
  assert.match(markdownEditor, /onChange=\{handleRawEditorChange\}/)
  assert.match(markdownEditor, /viewMode === 'preview'/)
  assert.match(markdownEditor, /<NotePreview[\s\S]*content=\{tab\.content\}/)
  assert.match(notePreview, /memo,/)
  assert.match(notePreview, /export default memo\(NotePreview\)/)
  const mermaidErrorBranch = notePreview.slice(
    notePreview.indexOf('if (error)'),
    notePreview.indexOf('return (', notePreview.indexOf('if (error)') + 1),
  )
  assert.doesNotMatch(mermaidErrorBranch, /note-preview-markdown-code/)
  const mermaidLoadingBranch = notePreview.slice(
    notePreview.indexOf('note-preview-mermaid__loading'),
    notePreview.indexOf('function BrokenWidgetFallback'),
  )
  assert.doesNotMatch(mermaidLoadingBranch, /note-preview-markdown-code/)
  assert.doesNotMatch(mermaidLoadingBranch, /\{code\}/)
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
  assert.match(documentMode, /readDocumentReadingPositionMap\(\)/)
  assert.match(documentMode, /saveDocumentReadingPosition\(key, snapshot\)/)
  assert.match(documentMode, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/)
  assert.match(documentMode, /element\.addEventListener\('scroll', handler, \{ passive: true \}\)/)
  assert.match(documentMode, /restoreVisibleDocumentScrollPositions\(\)/)
  assert.match(documentMode, /useLayoutEffect\(\(\) => \{/)
  assert.match(documentMode, /onChange=\{handleEditorModeChange\}/)
  assert.match(documentMode, /\[data-ready-document-scroll-key\]/)
  assert.match(documentMode, /findCurrentScrollElement\(scope\)/)
  assert.match(documentMode, /anchorTitle: anchor\?\.anchorTitle \|\| null/)
  assert.match(documentMode, /restoreAnchorScroll\(element, snapshot, content\)/)
  assert.match(documentMode, /captureMarkdownLineAnchor\(content, lineNumber\)/)
  assert.match(documentMode, /resolveMarkdownLineFromAnchor\(content, snapshot\)/)

  const notePreview = readWorkspaceFile('src/renderer/components/document/NotePreview.tsx')
  assert.match(notePreview, /data-ready-heading-title=\{extractMarkdownText\(children\)\}/)
  assert.match(notePreview, /data-ready-mermaid="true"/)
})

test('document PDF and mark drafts keep reading context across remounts', () => {
  const pdfViewer = readWorkspaceFile('src/renderer/components/document/PdfViewer.tsx')
  const panels = readWorkspaceFile('src/renderer/components/document/DocumentFloatingPanels.tsx')
  const ebookViewer = readWorkspaceFile('src/renderer/components/document/EbookViewer.tsx')

  assert.match(pdfViewer, /data-ready-document-scroll-key=\{documentScrollKey\}/)
  assert.match(pdfViewer, /loadDocumentReadingPosition\(documentScrollKey\)/)
  assert.match(pdfViewer, /saveDocumentReadingPosition\(documentScrollKey,/)
  assert.match(pdfViewer, /onScroll=\{handleScroll\}/)

  assert.match(panels, /MARK_DRAFTS_KEY = 'ready-document-mark-drafts-v1'/)
  assert.match(panels, /readMarkDraft\(documentPath\)/)
  assert.match(panels, /saveMarkDraft\(\{/)
  assert.match(panels, /marksRequestSeqRef/)

  assert.match(ebookViewer, /latestReaderStateRef/)
  assert.match(ebookViewer, /saveReaderState\(\{ \.\.\.latestReaderStateRef\.current, updatedAt: Date\.now\(\) \}\)/)
  assert.match(ebookViewer, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/)
})

test('document preview shows repair affordances instead of raw broken visual source', () => {
  const notePreview = readWorkspaceFile('src/renderer/components/document/NotePreview.tsx')
  const parser = readWorkspaceFile('src/renderer/components/document/note-preview-parser.ts')
  const sharedParser = readWorkspaceFile('src/shared/document-widget-parse.ts')

  assert.match(sharedParser, /type: 'invalid-widget'/)
  assert.match(parser, /type: 'widget_error'/)
  assert.match(notePreview, /data-ready-widget-error="true"/)
  assert.match(notePreview, /data-ready-widget-repair="true"/)
  assert.match(notePreview, /data-ready-mermaid-render-error=\{error\}/)
  const brokenWidgetBranch = notePreview.slice(
    notePreview.indexOf('function BrokenWidgetFallback'),
    notePreview.indexOf('function isMermaidPreChildren'),
  )
  assert.doesNotMatch(brokenWidgetBranch, /note-preview-markdown-code/)
})

test('document widget update policy keeps text replacement tools out of widget-update turns', () => {
  const toolConfig = readWorkspaceFile('src/main/modules/agent-control/tool-policy/execution-tool-config.ts')
  const widgetUpdateSet = toolConfig.slice(
    toolConfig.indexOf('const DOCUMENT_WIDGET_UPDATE_TOOL_NAMES'),
    toolConfig.indexOf('const DOCUMENT_WIDGET_REMOVE_TOOL_NAMES'),
  )

  assert.match(widgetUpdateSet, /document_update_widget/)
  assert.match(widgetUpdateSet, /document_save_tab/)
  assert.doesNotMatch(widgetUpdateSet, /document_replace_text/)
  assert.doesNotMatch(widgetUpdateSet, /document_replace_exact/)
  assert.doesNotMatch(toolConfig, /document_update_section/)
  assert.doesNotMatch(toolConfig, /document_save\b/)
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
  assert.match(documentMode, /captureVisibleDocumentScrollPositions\(\{ includeAnchor: false \}\)/)
  assert.match(documentMode, /options\?\.includeAnchor === false[\s\S]*\? null[\s\S]*: captureTextareaAnchor\(element, content\) \|\| capturePreviewAnchor\(element\)/)
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
  assert.match(layoutFreeze, /frozenWidth: `\$\{Math\.ceil\(rect\.width\)\}px`/)
  assert.match(layoutFreeze, /snapshots\.forEach\(\(\{ element, frozenWidth \}\) => \{/)
  assert.match(layoutFreeze, /element\.style\.width = frozenWidth/)
  assert.match(layoutFreeze, /element\.style\.minWidth = frozenWidth/)
  assert.match(layoutFreeze, /element\.style\.maxWidth = 'none'/)
  assert.match(layoutFreeze, /return \(\) => \{/)
})
