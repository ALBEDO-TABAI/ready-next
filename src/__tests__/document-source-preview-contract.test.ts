import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('document edit mode uses raw text editing while preview mode keeps rendered markdown presentation', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const notePreview = readWorkspaceFile('src/renderer/components/document/NotePreview.tsx')
  const mermaidPreview = readWorkspaceFile('src/renderer/components/document/MermaidPreviewBlock.tsx')

  assert.match(markdownEditor, /viewMode === 'edit'/)
  assert.match(markdownEditor, /<textarea/)
  assert.match(markdownEditor, /value=\{tab\.content\}/)
  assert.match(markdownEditor, /onChange=\{handleRawEditorChange\}/)
  assert.match(markdownEditor, /viewMode === 'preview'/)
  assert.match(markdownEditor, /<NotePreview[\s\S]*content=\{tab\.content\}/)
  assert.match(notePreview, /memo,/)
  assert.match(notePreview, /export default memo\(NotePreview\)/)
  assert.doesNotMatch(mermaidPreview, /note-preview-markdown-code/)
  assert.match(mermaidPreview, /note-preview-mermaid__loading[^>]*>正在渲染图表…<\/div>/)
})

test('document save failures surface a visible alert and keep the tab dirty', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

  assert.match(markdownEditor, /const \[saveError, setSaveError\] = useState<string \| null>\(null\)/)
  assert.match(markdownEditor, /setSaveError\(outcome\.error\)/)
  assert.match(markdownEditor, /setSaveError\(error instanceof Error \? error\.message : String\(error\)\)/)
  assert.match(markdownEditor, /role="alert"/)
  assert.match(markdownEditor, /saveState === 'error' && saveError/)
  assert.doesNotMatch(markdownEditor, /catch \{\s*setSaveState\('error'\)\s*\}/)
})

test('document widget-only state changes enter shared tab content so clean markdown can be saved', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

  assert.match(markdownEditor, /const saveInFlightRef = useRef\(false\)/)
  assert.match(markdownEditor, /saveDocumentTabSnapshot\(\{/)
  assert.match(markdownEditor, /registerDocumentSaveHandler\(\s*tab\.id,\s*saveCurrentTab,/)
  assert.match(markdownEditor, /const widgetStatesRef = useRef\(widgetStates\)/)
  assert.match(markdownEditor, /const tabContentRef = useRef\(tab\.content\)/)
  assert.match(markdownEditor, /const nextWidgetStates = \{[\s\S]*\.\.\.widgetStatesRef\.current,[\s\S]*\[getWidgetPersistenceKey\(widgetTitle, widgetCode\)\]: widgetState,[\s\S]*\}/)
  assert.match(markdownEditor, /widgetStatesRef\.current = nextWidgetStates/)
  assert.match(markdownEditor, /const baseContent = tabContentRef\.current[\s\S]*const nextContent = mergeWidgetStateMapIntoContent\(baseContent, nextWidgetStates\)/)
  assert.match(markdownEditor, /if \(nextContent !== baseContent\) \{[\s\S]*replaceEditorContent\(nextContent\)[\s\S]*\}/)
  assert.doesNotMatch(markdownEditor, /widgetStateDirty/)
})

test('document source editor soft-wraps long markdown lines inside narrow split panes', () => {
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const styles = readRendererStyles()

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
  const scrollRuntime = readWorkspaceFile('src/renderer/modules/document/documentScrollRuntime.ts')

  assert.match(markdownEditor, /const documentScrollKey = useMemo\(\(\) => tab\.path \|\| tab\.id, \[tab\.id, tab\.path\]\)/)
  assert.match(markdownEditor, /data-ready-document-scroll-key=\{documentScrollKey\}/)

  assert.match(documentMode, /captureVisibleDocumentScrollPositions\(\)/)
  // 1e9585c3 — persisted positions are read once via a lazy useState initializer.
  assert.match(documentMode, /const \[scrollSnapshots\] = useState\(readDocumentReadingPositionMap\)/)
  assert.match(documentMode, /saveDocumentReadingPosition\(key, snapshot\)/)
  assert.match(documentMode, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/)
  // 98c06c55 — per-element scroll listening moved into the shared scroll tracker (flushed on hide/unload).
  assert.match(documentMode, /const tracker = trackDocumentScrollPosition\(element,/)
  assert.match(documentMode, /pendingScrollFlushesRef\.current\.add\(tracker\.flush\)/)
  assert.match(scrollRuntime, /element\.addEventListener\('scroll', handleScroll, \{ passive: true \}\)/)
  assert.match(documentMode, /restoreVisibleDocumentScrollPositions\(\)/)
  assert.match(documentMode, /useLayoutEffect\(\(\) => \{/)
  assert.match(documentMode, /onChange=\{handleEditorModeChange\}/)
  assert.match(documentMode, /\[data-ready-document-scroll-key\]/)
  assert.match(documentMode, /findCurrentScrollElement\(scope\)/)
  assert.match(documentMode, /captureElementScroll\(element, content, options\)/)
  assert.match(documentMode, /restoreElementScroll\(element, snapshot, content\)/)
  assert.match(scrollRuntime, /anchorTitle: anchor\?\.anchorTitle \|\| null/)
  assert.match(scrollRuntime, /restoreAnchorScroll\(element, snapshot, content\)/)
  assert.match(scrollRuntime, /captureMarkdownLineAnchor\(content, lineNumber\)/)
  assert.match(scrollRuntime, /resolveMarkdownLineFromAnchor\(content, snapshot\)/)

  const notePreview = readWorkspaceFile('src/renderer/components/document/NotePreview.tsx')
  const mermaidPreview = readWorkspaceFile('src/renderer/components/document/MermaidPreviewBlock.tsx')
  assert.match(notePreview, /data-ready-heading-title=\{extractMarkdownText\(children\)\}/)
  assert.match(mermaidPreview, /data-ready-mermaid="true"/)
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
  assert.match(ebookViewer, /readingStateWriter\.queue\(\{ \.\.\.latestReaderStateRef\.current, updatedAt: Date\.now\(\) \}\)/)
  assert.match(ebookViewer, /readingStateWriter\.flush\(\)/)
  assert.match(ebookViewer, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/)
})

test('document preview shows repair affordances instead of raw broken visual source', () => {
  const notePreview = readWorkspaceFile('src/renderer/components/document/NotePreview.tsx')
  const mermaidPreview = readWorkspaceFile('src/renderer/components/document/MermaidPreviewBlock.tsx')
  const parser = readWorkspaceFile('src/renderer/components/document/note-preview-parser.ts')
  const sharedParser = readWorkspaceFile('src/shared/document-widget-parse.ts')

  assert.match(sharedParser, /type: 'invalid-widget'/)
  assert.match(parser, /type: 'widget_error'/)
  assert.match(notePreview, /data-ready-widget-error="true"/)
  assert.match(notePreview, /data-ready-widget-repair="true"/)
  assert.match(mermaidPreview, /data-ready-mermaid-render-error=\{error\}/)
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
  const styles = readRendererStyles()

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
