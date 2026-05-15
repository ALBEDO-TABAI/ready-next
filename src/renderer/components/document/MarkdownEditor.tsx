import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import EditorContextMenu from './EditorContextMenu'
import NotePreview from './NotePreview'
import { addDocumentQuoteReference, addDocumentWidgetTargetReference } from '../../modules/agent/chat-input-bridge'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import {
  exportWidgetCardSnapshot,
  extractWidgetStateMapFromContent,
  getWidgetModeLabel,
  getWidgetPersistenceKey,
  mergeWidgetStateMapIntoContent,
  renameWidgetFenceTitleInContent,
} from './widget-card-helpers'
import { collectDocumentWidgets } from '../../../shared/document-widget-parse'
import {
  getDroppedFileKind,
  getDroppedFilesFromDataTransfer,
  toFileUrl,
} from '../../utils/dragDrop'
import { convertDocxHtmlToMarkdownText } from '../../utils/docx-format'
import { shouldApplyAsyncDocumentLoad } from './documentLoadGuard'
import '../../styles/tiptap.css'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const DEFAULT_CONTENT = `# 欢迎使用 Ready 文档编辑器

这是一个支持 Markdown 的文档编辑器，支持**实时预览**。

## 功能特点

- **编辑模式**：直接编写 Markdown 原文
- **预览模式**：实时渲染 Markdown 为富文本
- **分栏模式**：左侧编辑，右侧预览
- 支持文件读取和保存（Electron 环境）

## Markdown 语法示例

### 文本格式
**粗体** / *斜体* / ~~删除线~~ / \`行内代码\`

### 列表
1. 有序列表第一项
2. 有序列表第二项

- 无序列表项
- 另一个无序列表项

### 代码块
\`\`\`javascript
function hello() {
  console.log("Hello, Ready!");
}
\`\`\`

### 引用
> 这是一段引用文字。
> Ready 让自媒体创作更高效。

---

*按 Cmd+S 保存文档*
`

interface ReadResult {
  success?: boolean
  content?: string
  html?: string
  data?: Record<string, unknown>
  error?: string
}

const getFileExt = (path: string | null): string => {
  if (!path) return ''
  return (path.split('/').pop() || '').split('.').pop()?.toLowerCase() || ''
}

interface MarkdownEditorProps {
  tab: DocTab
  viewMode?: 'edit' | 'preview'
  previewFocusWidgetTitle?: string | null
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeDocText(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function findDocumentSelectionLocation(
  content: string,
  selection: string,
): { lineStart: number | null; lineEnd: number | null; sectionTitle: string | null } {
  const normalizedContent = normalizeDocText(content)
  const normalizedSelection = normalizeDocText(selection).trim()
  if (!normalizedSelection) {
    return { lineStart: null, lineEnd: null, sectionTitle: null }
  }

  const index = normalizedContent.indexOf(normalizedSelection)
  if (index < 0) {
    return { lineStart: null, lineEnd: null, sectionTitle: null }
  }

  const before = normalizedContent.slice(0, index)
  const selected = normalizedContent.slice(index, index + normalizedSelection.length)
  const lineStart = before.split('\n').length
  const lineEnd = lineStart + selected.split('\n').length - 1

  const lines = normalizedContent.split('\n')
  let sectionTitle: string | null = null
  for (let currentLine = Math.min(lineStart - 1, lines.length - 1); currentLine >= 0; currentLine -= 1) {
    const trimmed = lines[currentLine].trim()
    if (!trimmed) continue
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      sectionTitle = headingMatch[2].trim()
      break
    }
  }

  return { lineStart, lineEnd, sectionTitle }
}

function getMarkdownForDroppedFiles(
  files: ReturnType<typeof getDroppedFilesFromDataTransfer>,
  targetExt: string
): string {
  const isDocx = targetExt === 'docx'
  const lines: string[] = []
  for (const file of files) {
    const url = toFileUrl(file.path)
    const kind = getDroppedFileKind(file)

    if (isDocx) {
      if (kind === 'image') {
        lines.push(`<img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(file.name)}" style="max-width:100%" />`)
        continue
      }
      if (kind === 'video') {
        lines.push(`<video controls src="${escapeHtmlAttr(url)}" style="max-width:100%"></video>`)
        continue
      }
      if (kind === 'audio') {
        lines.push(`<audio controls src="${escapeHtmlAttr(url)}"></audio>`)
        continue
      }
      lines.push(`<a href="${escapeHtmlAttr(url)}">${escapeHtmlText(file.name)}</a>`)
      continue
    }

    if (kind === 'image') {
      lines.push(`![${file.name}](${url})`)
      continue
    }
    if (kind === 'video') {
      lines.push(`<video controls src="${escapeHtmlAttr(url)}" style="max-width:100%"></video>`)
      continue
    }
    if (kind === 'audio') {
      lines.push(`<audio controls src="${escapeHtmlAttr(url)}"></audio>`)
      continue
    }
    lines.push(`- [${file.name}](${url})`)
  }
  return lines.join('\n')
}

export default function MarkdownEditor({
  tab,
  viewMode = 'edit',
  previewFocusWidgetTitle,
}: MarkdownEditorProps) {
  const { updateTabContent, markTabSaved, pendingReveal, setPendingReveal } = useDocTabs()
  const [isLoading, setIsLoading] = useState(!!tab.path)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [contentReady, setContentReady] = useState(!tab.path || !!tab.content)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [widgetStates, setWidgetStates] = useState<Record<string, DocumentWidgetPersistedState>>(() => (
    extractWidgetStateMapFromContent(tab.content)
  ))
  const rawEditorRef = useRef<HTMLTextAreaElement>(null)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
  }>({ visible: false, x: 0, y: 0 })
  const [contextSelection, setContextSelection] = useState<string>('')

  const currentExt = useMemo(() => getFileExt(tab.path), [tab.path])
  const documentScrollKey = useMemo(() => tab.path || tab.id, [tab.id, tab.path])
  const canSave = !!tab.path
  const activeRevealTarget = useMemo(() => {
    if (!tab.path || !pendingReveal || pendingReveal.path !== tab.path) return null
    return pendingReveal
  }, [pendingReveal, tab.path])

  // ─── File loading ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const initialLoadSnapshot = {
      id: tab.id,
      path: tab.path || null,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
    }
    const canCommitLoadedContent = () => {
      const current = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
      return shouldApplyAsyncDocumentLoad(initialLoadSnapshot, current || null)
    }
    const load = async () => {
      if (!tab.path) {
        if (!tab.content && !tab.isDirty) {
          updateTabContent(tab.id, DEFAULT_CONTENT)
        }
        setLoadError(null)
        setContentReady(true)
        setIsLoading(false)
        return
      }

      // Avoid clobbering content that has already been loaded by tool actions.
      if (tab.content.length > 0 && !tab.isDirty) {
        setLoadError(null)
        setIsLoading(false)
        setContentReady(true)
        return
      }

      if (typeof window === 'undefined' || !window.electronAPI) {
        setLoadError('文档加载失败：当前环境未提供 Electron 文件系统能力。')
        setIsLoading(false)
        setContentReady(true)
        return
      }

      setIsLoading(true)
      setLoadError(null)
      try {
        const ext = getFileExt(tab.path)
        if (['md', 'txt', 'json', 'ts', 'tsx', 'js', 'css', 'html'].includes(ext)) {
          const result = (await window.electronAPI.document.readFile(tab.path)) as ReadResult
          if (!result.success) throw new Error(result.error || '文件读取失败')
          if (!cancelled && canCommitLoadedContent()) {
            updateTabContent(tab.id, result.content || '')
            markTabSaved(tab.id)
          }
        } else if (ext === 'docx') {
          const result = (await window.electronAPI.document.parseDocx(tab.path)) as ReadResult
          if (!result.success) throw new Error(result.error || 'DOCX 解析失败')
          if (!cancelled) {
            const rawText = typeof result.data?.rawText === 'string' ? result.data.rawText : ''
            const html = typeof result.data?.html === 'string'
              ? result.data.html
              : typeof result.html === 'string'
                ? result.html
                : ''
            const markdownish = convertDocxHtmlToMarkdownText(
              html,
              rawText || result.content || result.html || '',
            )
            if (canCommitLoadedContent()) {
              updateTabContent(tab.id, markdownish)
              markTabSaved(tab.id)
            }
          }
        } else {
          if (!cancelled) {
            setLoadError(`文件暂不支持直接编辑：${tab.path}`)
          }
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(`文档加载失败：${error instanceof Error ? error.message : String(error)}`)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
          setContentReady(true)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [tab.path]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setWidgetStates((prev) => ({
      ...extractWidgetStateMapFromContent(tab.content),
      ...prev,
    }))
  }, [tab.content])

  // ─── Save logic ─────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!tab.path || !canSave || !tab.isDirty) return
    if (typeof window === 'undefined' || !window.electronAPI) return
    setSaveState('saving')
    try {
      const nextContent = mergeWidgetStateMapIntoContent(tab.content, widgetStates)
      const result = (await window.electronAPI.document.writeFile(tab.path, nextContent)) as ReadResult
      if (!result.success) throw new Error(result.error || '保存失败')
      if (nextContent !== tab.content) {
        updateTabContent(tab.id, nextContent)
      }
      setSaveState('saved')
      markTabSaved(tab.id)
    } catch {
      setSaveState('error')
    }
  }, [tab.path, tab.content, canSave, markTabSaved, tab.id, updateTabContent, widgetStates])

  // Cmd+S keyboard shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSave])

  const handleRawEditorChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateTabContent(tab.id, e.target.value)
    setSaveState('idle')
  }, [tab.id, updateTabContent])

  // ─── Context menu handler ──────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rawEditor = rawEditorRef.current
    const selectedText = viewMode === 'edit' && rawEditor
      ? rawEditor.value.slice(rawEditor.selectionStart, rawEditor.selectionEnd)
      : window.getSelection?.()?.toString() || ''
    setContextSelection(selectedText)
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [viewMode])

  const handleEditorDragOver = useCallback((e: React.DragEvent) => {
    const types = new Set(Array.from(e.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleEditorDrop = useCallback((e: React.DragEvent) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    if (droppedFiles.length === 0) return

    e.preventDefault()

    const snippet = getMarkdownForDroppedFiles(droppedFiles, currentExt)
    if (!snippet) return

    const rawEditor = rawEditorRef.current
    if (viewMode === 'edit' && rawEditor) {
      const selectionStart = rawEditor.selectionStart
      const selectionEnd = rawEditor.selectionEnd
      const before = tab.content.slice(0, selectionStart)
      const after = tab.content.slice(selectionEnd)
      const needsLeadingBreak = before.length > 0 && !before.endsWith('\n')
      const needsTrailingBreak = after.length > 0 && !snippet.endsWith('\n')
      const insertion = `${needsLeadingBreak ? '\n\n' : ''}${snippet}${needsTrailingBreak ? '\n' : ''}`
      updateTabContent(tab.id, `${before}${insertion}${after}`)
      requestAnimationFrame(() => {
        const nextCursor = before.length + insertion.length
        rawEditor.focus()
        rawEditor.setSelectionRange(nextCursor, nextCursor)
      })
    } else {
      const prefix = tab.content.trim().length === 0
        ? ''
        : tab.content.endsWith('\n') ? '\n' : '\n\n'
      updateTabContent(tab.id, `${tab.content}${prefix}${snippet}\n`)
    }
    setSaveState('idle')
  }, [currentExt, tab.content, tab.id, updateTabContent, viewMode])

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

  const quoteSelectionToAgent = useCallback(() => {
    const selection = contextSelection.trim()
    if (!selection) return

    const location = findDocumentSelectionLocation(tab.content, selection)
    addDocumentQuoteReference({
      title: tab.title,
      path: tab.path,
      selection,
      sectionTitle: location.sectionTitle,
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
    })
  }, [contextSelection, tab.content, tab.path, tab.title])

  const handleWidgetRename = useCallback((currentTitle: string, widgetCode: string, nextTitle: string) => {
    const nextContent = renameWidgetFenceTitleInContent(tab.content, currentTitle, widgetCode, nextTitle)
    if (nextContent === tab.content) return
    setWidgetStates((prev) => {
      const next = { ...prev }
      const currentKey = getWidgetPersistenceKey(currentTitle, widgetCode)
      const nextKey = getWidgetPersistenceKey(nextTitle, widgetCode)
      if (prev[currentKey]) {
        next[nextKey] = prev[currentKey]
        delete next[currentKey]
      }
      return next
    })
    updateTabContent(tab.id, nextContent)
    setSaveState('idle')
  }, [tab.content, tab.id, updateTabContent])

  const handleWidgetQuoteToAgent = useCallback((widgetTitle: string, widgetCode: string) => {
    const targetWidget = collectDocumentWidgets(tab.content).find((widget) => (
      widget.title === widgetTitle && widget.widgetCode.trim() === widgetCode.trim()
    )) || null
    addDocumentWidgetTargetReference({
      documentTitle: tab.title,
      documentPath: tab.path,
      tabId: tab.id,
      widgetTitle,
      widgetId: targetWidget?.id || null,
      widgetCode,
      widgetMode: getWidgetModeLabel(widgetCode),
    })
  }, [tab.content, tab.id, tab.path, tab.title])

  const handleWidgetExport = useCallback((widgetTitle: string, widgetCode: string, widgetState?: DocumentWidgetPersistedState | null) => {
    void exportWidgetCardSnapshot(widgetCode, widgetTitle, widgetState, tab.path)
  }, [tab.path])

  const handleWidgetStateChange = useCallback((widgetTitle: string, widgetCode: string, widgetState: DocumentWidgetPersistedState) => {
    setWidgetStates((prev) => ({
      ...prev,
      [getWidgetPersistenceKey(widgetTitle, widgetCode)]: widgetState,
    }))
  }, [])

  useEffect(() => {
    if (viewMode !== 'edit' || !activeRevealTarget) return
    const rawEditor = rawEditorRef.current
    if (!rawEditor) return

    let start = 0
    let end = 0
    const normalizedContent = normalizeDocText(tab.content)

    if (activeRevealTarget.selection) {
      const targetSelection = normalizeDocText(activeRevealTarget.selection).trim()
      const index = targetSelection ? normalizedContent.indexOf(targetSelection) : -1
      if (index >= 0) {
        start = index
        end = index + targetSelection.length
      }
    } else if (activeRevealTarget.lineStart) {
      const lines = normalizedContent.split('\n')
      const safeLineStart = Math.max(1, activeRevealTarget.lineStart)
      const safeLineEnd = Math.max(safeLineStart, activeRevealTarget.lineEnd ?? safeLineStart)
      start = lines.slice(0, safeLineStart - 1).join('\n').length + (safeLineStart > 1 ? 1 : 0)
      end = lines.slice(0, safeLineEnd).join('\n').length
    }

    requestAnimationFrame(() => {
      rawEditor.focus()
      rawEditor.setSelectionRange(start, end || start)
      rawEditor.scrollTop = rawEditor.scrollHeight * (start / Math.max(normalizedContent.length, 1))
      setPendingReveal(null)
    })
  }, [activeRevealTarget, setPendingReveal, tab.content, viewMode])

  const renderLoadState = () => {
    if (loadError) {
      return (
        <div className="flex items-center justify-center py-10">
          <div className="max-w-[520px] rounded-[12px] border border-[var(--color-orange)] px-4 py-3 text-[13px] text-[var(--text-secondary)]">
            {loadError}
          </div>
        </div>
      )
    }

    return (
      <div className="flex items-center justify-center py-10">
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载中...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-ready-document-scroll-key={documentScrollKey}>
      {/* ── Content area ──────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex" style={{ background: 'var(--workbench-module-surface-bg)' }}>
        <>
          {/* ── Edit pane: TiptapEditor ── */}
          {viewMode === 'edit' && (
            <div
              className="panel-hover-scrollbar document-editor-surface flex-1 overflow-auto"
              style={{ position: 'relative' }}
              onContextMenu={handleContextMenu}
              onDragOver={handleEditorDragOver}
              onDrop={handleEditorDrop}
            >
              <div className="document-editor-layout" style={{ padding: '12px 40px 24px', maxWidth: 800, margin: '0 auto' }}>
                {contentReady ? (
                  loadError ? (
                    renderLoadState()
                  ) : (
                    <textarea
                      ref={rawEditorRef}
                      value={tab.content}
                      onChange={handleRawEditorChange}
                      spellCheck={false}
                      aria-label="Markdown source editor"
                      className="document-source-textarea w-full min-h-full resize-none border-0 bg-transparent outline-none ready-input-slot-inner"
                      style={{
                        minHeight: 'calc(100vh - 220px)',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
                        fontSize: 14,
                        lineHeight: 1.7,
                        color: 'var(--text-primary)',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                        tabSize: 2,
                      }}
                    />
                  )
                ) : (
                  renderLoadState()
                )}
              </div>
            </div>
          )}

          {/* ── Preview pane ──────────── */}
          {viewMode === 'preview' && (
            <div
              className="panel-hover-scrollbar document-preview-surface flex-1 overflow-auto"
              style={{ background: 'var(--workbench-module-surface-bg)' }}
              onContextMenu={handleContextMenu}
            >
              <div className="document-preview-layout" style={{ padding: '12px 40px 24px', maxWidth: 800, margin: '0 auto' }}>
                {loadError ? (
                  renderLoadState()
                ) : (
                  <NotePreview
                    content={tab.content}
                    notePath={tab.path}
                    focusWidgetTitle={previewFocusWidgetTitle}
                    onWidgetRename={handleWidgetRename}
                    onWidgetQuote={handleWidgetQuoteToAgent}
                    onWidgetExport={handleWidgetExport}
                    onWidgetStateChange={handleWidgetStateChange}
                    widgetStates={widgetStates}
                  />
                )}
              </div>
            </div>
          )}
        </>
      </div>

      {/* ── Editor Context Menu (fixed position, portal-like) ── */}
      <EditorContextMenu
        editor={null}
        visible={contextMenu.visible}
        position={{ x: contextMenu.x, y: contextMenu.y }}
        onClose={closeContextMenu}
        canQuote={contextSelection.trim().length > 0}
        onQuoteToAgent={quoteSelectionToAgent}
      />
    </div>
  )
}
