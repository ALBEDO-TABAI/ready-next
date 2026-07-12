import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import EditorContextMenu from './EditorContextMenu'
import MarkdownSelectionToolbar, {
  type SelectionRange,
} from './MarkdownSelectionToolbar'
import NotePreview from './NotePreview'
import WidgetEditDrawer, { type WidgetEditDrawerSave } from './WidgetEditDrawer'
import { addDocumentQuoteReference, addDocumentWidgetTargetReference } from '../../modules/agent/chat-input-bridge'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import {
  exportWidgetCardSnapshot,
  extractWidgetStateMapFromContent,
  getWidgetModeLabel,
  getWidgetPersistenceKey,
  mergeWidgetStateMapIntoContent,
  renameWidgetFenceTitleInContent,
  replaceWidgetFenceWithSkeletonInContent,
} from './widget-card-helpers'
import { collectDocumentWidgets, type DocumentWidgetRecord } from '../../../shared/document-widget-parse'
import { buildDocumentOutline, getOutlineNodeForLine } from '../../../shared/document-side-panels'
import {
  getDroppedFileKind,
  getDroppedFilesFromDataTransfer,
  toFileUrl,
} from '../../utils/dragDrop'
import { convertDocxHtmlToMarkdownText } from '../../utils/docx-format'
import { shouldApplyAsyncDocumentLoad } from './documentLoadGuard'
import { shouldRefreshDocumentTabForDirectoryChange } from '../../modules/document/documentExternalRefresh'
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
  /** Preview-edit mode (滑块下沉态): the preview allows in-place content edits. */
  previewEditable?: boolean
  previewFocusWidgetTitle?: string | null
  onVisibleLineChange?: (line: number | null) => void
  onActivate?: () => void
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

function estimateTextareaLineHeight(element: HTMLElement): number {
  const styles = window.getComputedStyle(element)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight
  const fontSize = Number.parseFloat(styles.fontSize)
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.6 : 24
}

function findDocumentSelectionLocation(
  content: string,
  selection: string,
  selectionRange?: SelectionRange | null,
): { lineStart: number | null; lineEnd: number | null; sectionTitle: string | null } {
  const normalizedContent = normalizeDocText(content)
  const normalizedSelection = normalizeDocText(selection).trim()
  if (!normalizedSelection) {
    return { lineStart: null, lineEnd: null, sectionTitle: null }
  }

  const rangeStart = selectionRange
    ? Math.max(0, Math.min(selectionRange.start, normalizedContent.length))
    : -1
  const rangeEnd = selectionRange
    ? Math.max(rangeStart, Math.min(selectionRange.end, normalizedContent.length))
    : -1
  const rangedSelection = rangeStart >= 0 && rangeEnd > rangeStart
    ? normalizeDocText(normalizedContent.slice(rangeStart, rangeEnd)).trim()
    : ''
  const index = rangedSelection === normalizedSelection ? rangeStart : normalizedContent.indexOf(normalizedSelection)
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
  previewEditable = false,
  previewFocusWidgetTitle,
  onVisibleLineChange,
  onActivate,
}: MarkdownEditorProps) {
  const { updateTabContent, markTabSaved, pendingReveal, setPendingReveal } = useDocTabs()
  const [isLoading, setIsLoading] = useState(!!tab.path)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [contentReady, setContentReady] = useState(!tab.path || !!tab.content)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [widgetStates, setWidgetStates] = useState<Record<string, DocumentWidgetPersistedState>>(() => (
    extractWidgetStateMapFromContent(tab.content)
  ))
  const [editingWidget, setEditingWidget] = useState<DocumentWidgetRecord | null>(null)
  const widgetStatesRef = useRef(widgetStates)
  const tabContentRef = useRef(tab.content)
  const rawEditorRef = useRef<HTMLTextAreaElement>(null)
  const editorSurfaceRef = useRef<HTMLDivElement>(null)
  const previewSurfaceRef = useRef<HTMLDivElement>(null)
  const visibleLineFrameRef = useRef<number | null>(null)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
  }>({ visible: false, x: 0, y: 0 })
  const [contextSelection, setContextSelection] = useState<string>('')
  const [contextSelectionRange, setContextSelectionRange] = useState<SelectionRange | null>(null)

  // Selection toolbar state (markdown formatting on highlighted text)
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null)
  const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null)

  const currentExt = useMemo(() => getFileExt(tab.path), [tab.path])
  const documentScrollKey = useMemo(() => tab.path || tab.id, [tab.id, tab.path])
  const outlineForVisibility = useMemo(() => buildDocumentOutline(tab.content), [tab.content])
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
  }, [tab.path, reloadNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loadError || tab.content.length === 0) return
    setLoadError(null)
    setContentReady(true)
    setIsLoading(false)
  }, [loadError, tab.content])

  useEffect(() => {
    if (!window.electronAPI?.document?.onDirectoryChange) return undefined
    const unsubscribe = window.electronAPI.document.onDirectoryChange((event) => {
      const changedPaths = Array.isArray(event?.paths) ? event.paths : []
      if (!shouldRefreshDocumentTabForDirectoryChange({
        path: tab.path,
        isDirty: tab.isDirty,
      }, changedPaths)) return
      setLoadError(null)
      setContentReady(false)
      setReloadNonce((value) => value + 1)
    })
    return () => unsubscribe()
  }, [tab.path, tab.isDirty])

  useEffect(() => {
    tabContentRef.current = tab.content
    setWidgetStates((prev) => {
      const next = {
        ...extractWidgetStateMapFromContent(tab.content),
        ...prev,
      }
      widgetStatesRef.current = next
      return next
    })
  }, [tab.content])

  // ─── Save logic ─────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!tab.path || !canSave || !tab.isDirty) return
    if (typeof window === 'undefined' || !window.electronAPI) return
    setSaveState('saving')
    setSaveError(null)
    try {
      const baseContent = tabContentRef.current
      const nextContent = mergeWidgetStateMapIntoContent(baseContent, widgetStatesRef.current)
      const result = (await window.electronAPI.document.writeFile(tab.path, nextContent)) as ReadResult
      if (!result.success) throw new Error(result.error || '保存失败')
      if (nextContent !== baseContent) {
        tabContentRef.current = nextContent
        updateTabContent(tab.id, nextContent)
      }
      setSaveState('saved')
      setSaveError(null)
      markTabSaved(tab.id)
    } catch (error) {
      setSaveState('error')
      setSaveError(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [tab.path, tab.isDirty, canSave, markTabSaved, tab.id, updateTabContent])

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

  const emitVisibleLine = useCallback((line: number | null) => {
    if (!onVisibleLineChange) return
    if (visibleLineFrameRef.current !== null) {
      window.cancelAnimationFrame(visibleLineFrameRef.current)
    }
    visibleLineFrameRef.current = window.requestAnimationFrame(() => {
      visibleLineFrameRef.current = null
      onVisibleLineChange(line)
    })
  }, [onVisibleLineChange])

  const emitCaretLine = useCallback(() => {
    const rawEditor = rawEditorRef.current
    if (!rawEditor) return
    emitVisibleLine(Math.max(1, rawEditor.value.slice(0, rawEditor.selectionStart).split('\n').length))
  }, [emitVisibleLine])

  // ─── Selection tracking for floating toolbar ───────────────
  const refreshSelectionRange = useCallback(() => {
    const ta = rawEditorRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) {
      setSelectionRange(null)
      setSelectionAnchor(null)
      return
    }
    setSelectionRange({ start, end })
  }, [])

  const handleEditorKeyUp = useCallback(() => {
    onActivate?.()
    refreshSelectionRange()
    emitCaretLine()
  }, [emitCaretLine, onActivate, refreshSelectionRange])

  const handleEditorSelect = useCallback(() => {
    onActivate?.()
    refreshSelectionRange()
    emitCaretLine()
  }, [emitCaretLine, onActivate, refreshSelectionRange])

  const handleEditorFocus = useCallback(() => {
    onActivate?.()
    emitCaretLine()
  }, [emitCaretLine, onActivate])

  const handleSurfacePointerDown = useCallback(() => {
    onActivate?.()
  }, [onActivate])

  const handleEditorMouseUp = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = rawEditorRef.current
    if (!ta) return
    onActivate?.()
    emitCaretLine()
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) {
      setSelectionRange(null)
      setSelectionAnchor(null)
      return
    }
    setSelectionRange({ start, end })
    setSelectionAnchor({ x: e.clientX, y: e.clientY })
  }, [emitCaretLine, onActivate])

  const handleEditorBlur = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    const next = e.relatedTarget as HTMLElement | null
    if (next?.closest('[data-ready-md-toolbar]')) return
    setSelectionRange(null)
    setSelectionAnchor(null)
  }, [])

  const handleToolbarChange = useCallback(
    (nextContent: string, nextSelection: SelectionRange) => {
      updateTabContent(tab.id, nextContent)
      setSaveState('idle')
      // After applying a toolbar edit, the mouse anchor is no longer
      // meaningful — fall back to caret-derived placement so the bar
      // tracks the resulting selection cleanly.
      setSelectionAnchor(null)
      requestAnimationFrame(() => {
        const ta = rawEditorRef.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(nextSelection.start, nextSelection.end)
        setSelectionRange(
          nextSelection.start === nextSelection.end ? null : { ...nextSelection },
        )
      })
    },
    [tab.id, updateTabContent],
  )

  // ─── Context menu handler ──────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rawEditor = rawEditorRef.current
    const editSelectionRange = viewMode === 'edit' && rawEditor && rawEditor.selectionStart !== rawEditor.selectionEnd
      ? { start: rawEditor.selectionStart, end: rawEditor.selectionEnd }
      : null
    const selectedText = viewMode === 'edit' && rawEditor
      ? rawEditor.value.slice(rawEditor.selectionStart, rawEditor.selectionEnd)
      : window.getSelection?.()?.toString() || ''
    setContextSelection(selectedText)
    setContextSelectionRange(editSelectionRange)
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
    const droppedText = e.dataTransfer.getData('text/plain')?.trim()
    if (droppedFiles.length === 0 && !droppedText) return

    e.preventDefault()

    const snippet = droppedFiles.length > 0
      ? getMarkdownForDroppedFiles(droppedFiles, currentExt)
      : droppedText
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

    const location = findDocumentSelectionLocation(tab.content, selection, contextSelectionRange)
    addDocumentQuoteReference({
      title: tab.title,
      path: tab.path,
      selection,
      sectionTitle: location.sectionTitle,
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
    })
  }, [contextSelection, contextSelectionRange, tab.content, tab.path, tab.title])

  const pasteSelectionToStickyNote = useCallback(async () => {
    const text = contextSelection.trim()
    if (!text) return
    await window.electronAPI.pet.updateSettings({ enabled: true }).catch(() => null)
    await window.electronAPI.pet.pushStickyNote({
      title: '便利贴',
      body: text,
      tone: 'default',
    }).catch(() => null)
    await window.electronAPI.pet.show().catch(() => null)
  }, [contextSelection])

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
    const nextWidgetStates = {
      ...widgetStatesRef.current,
      [getWidgetPersistenceKey(widgetTitle, widgetCode)]: widgetState,
    }
    widgetStatesRef.current = nextWidgetStates
    setWidgetStates(nextWidgetStates)
    const baseContent = tabContentRef.current
    const nextContent = mergeWidgetStateMapIntoContent(baseContent, nextWidgetStates)
    if (nextContent !== baseContent) {
      tabContentRef.current = nextContent
      updateTabContent(tab.id, nextContent)
    }
    setSaveState('idle')
  }, [tab.id, updateTabContent])

  // Preview-edit writes land on the same tab-content channel as the source
  // textarea: dirty state + Cmd+S save semantics stay identical.
  const handlePreviewContentEdit = useCallback((nextContent: string) => {
    updateTabContent(tab.id, nextContent)
    setSaveState('idle')
  }, [tab.id, updateTabContent])

  const handleWidgetEditRequest = useCallback((widget: { id?: string; title?: string; widgetCode: string }) => {
    const current = collectDocumentWidgets(tabContentRef.current).find((record) => (
      widget.id
        ? record.id === widget.id
        : record.title === (widget.title || 'widget') && record.widgetCode.trim() === widget.widgetCode.trim()
    ))
    setEditingWidget(current || null)
  }, [])

  const handleWidgetEditSave = useCallback((result: WidgetEditDrawerSave) => {
    if (!editingWidget) return
    const baseContent = tabContentRef.current
    const nextContent = replaceWidgetFenceWithSkeletonInContent(
      baseContent,
      editingWidget.id,
      result.widgetCode,
      result.skeletonSpec,
    )
    if (nextContent !== baseContent) {
      tabContentRef.current = nextContent
      updateTabContent(tab.id, nextContent)
      setSaveState('idle')
    }
    setEditingWidget(null)
  }, [editingWidget, tab.id, updateTabContent])

  const handleEditorSurfaceScroll = useCallback(() => {
    const surface = editorSurfaceRef.current
    const rawEditor = rawEditorRef.current
    if (!surface || !rawEditor) return
    onActivate?.()
    const lineHeight = estimateTextareaLineHeight(rawEditor)
    emitVisibleLine(Math.max(1, Math.floor(surface.scrollTop / lineHeight) + 1))
  }, [emitVisibleLine, onActivate])

  const handlePreviewSurfaceScroll = useCallback(() => {
    const surface = previewSurfaceRef.current
    if (!surface) return
    onActivate?.()
    const headings = Array.from(surface.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
    if (headings.length === 0) {
      const maxScroll = Math.max(1, surface.scrollHeight - surface.clientHeight)
      const line = Math.max(1, Math.round((surface.scrollTop / maxScroll) * outlineForVisibility.lineCount))
      emitVisibleLine(line)
      return
    }

    const counts = new Map<string, number>()
    const ordinals = headings.map((heading) => {
      const title = heading.dataset.readyHeadingTitle || ''
      const ordinal = counts.get(title) || 0
      counts.set(title, ordinal + 1)
      return ordinal
    })
    const contentTop = surface.scrollTop + 12
    const containerTop = surface.getBoundingClientRect().top
    let nearestIndex = 0
    for (let index = 0; index < headings.length; index += 1) {
      const top = headings[index].getBoundingClientRect().top - containerTop + surface.scrollTop
      if (top <= contentTop + 16) {
        nearestIndex = index
        continue
      }
      break
    }
    const title = headings[nearestIndex]?.dataset.readyHeadingTitle || null
    const ordinal = ordinals[nearestIndex] || 0
    const node = outlineForVisibility.nodes.find((item) => (
      item.kind === 'heading' &&
      item.anchorTitle === title &&
      item.anchorOrdinal === ordinal
    ))
    emitVisibleLine(node?.lineStart ?? 1)
  }, [emitVisibleLine, onActivate, outlineForVisibility])

  useEffect(() => () => {
    if (visibleLineFrameRef.current !== null) {
      window.cancelAnimationFrame(visibleLineFrameRef.current)
      visibleLineFrameRef.current = null
    }
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
      const targetTop = activeRevealTarget.lineStart
        ? Math.max(0, (activeRevealTarget.lineStart - 1) * estimateTextareaLineHeight(rawEditor))
        : rawEditor.scrollHeight * (start / Math.max(normalizedContent.length, 1))
      rawEditor.scrollTop = targetTop
      if (editorSurfaceRef.current) {
        editorSurfaceRef.current.scrollTop = targetTop
      }
      setPendingReveal(null)
    })
  }, [activeRevealTarget, setPendingReveal, tab.content, viewMode])

  useEffect(() => {
    if (viewMode !== 'preview' || !activeRevealTarget) return
    const surface = previewSurfaceRef.current
    if (!surface) return

    const targetLine = activeRevealTarget.lineStart || 1
    const targetNode = getOutlineNodeForLine(outlineForVisibility, targetLine)
    const scrollToTop = (top: number) => {
      surface.scrollTop = Math.max(0, Math.min(Math.round(top), Math.max(0, surface.scrollHeight - surface.clientHeight)))
    }

    requestAnimationFrame(() => {
      if (targetNode?.anchorTitle) {
        const headings = Array.from(surface.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
        let seenOrdinal = 0
        const targetHeading = headings.find((heading) => {
          if (heading.dataset.readyHeadingTitle !== targetNode.anchorTitle) return false
          const matches = seenOrdinal === (targetNode.anchorOrdinal || 0)
          seenOrdinal += 1
          return matches
        })
        if (targetHeading) {
          const containerTop = surface.getBoundingClientRect().top
          scrollToTop(targetHeading.getBoundingClientRect().top - containerTop + surface.scrollTop - 8)
          setPendingReveal(null)
          return
        }
      }

      const ratio = Math.max(0, Math.min(1, targetLine / Math.max(1, outlineForVisibility.lineCount)))
      scrollToTop(ratio * Math.max(0, surface.scrollHeight - surface.clientHeight))
      setPendingReveal(null)
    })
  }, [activeRevealTarget, outlineForVisibility, setPendingReveal, viewMode])

  const blockingLoadError = Boolean(loadError && tab.content.length === 0)

  const renderLoadState = () => {
    if (blockingLoadError && loadError) {
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
      {saveState === 'error' && saveError ? (
        <div
          role="alert"
          className="mx-10 mt-3 rounded-[8px] border px-3 py-2 text-[13px]"
          style={{
            borderColor: 'var(--color-orange)',
            color: 'var(--text-secondary)',
            background: 'var(--workbench-module-surface-bg)',
          }}
        >
          {saveError}
        </div>
      ) : null}

      {/* ── Content area ──────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex" style={{ background: 'transparent' }}>
        <>
          {/* ── Edit pane: TiptapEditor ── */}
          {viewMode === 'edit' && (
            <div
              ref={editorSurfaceRef}
              className="panel-hover-scrollbar document-editor-surface flex-1 overflow-auto"
              style={{ position: 'relative' }}
              onContextMenu={handleContextMenu}
              onDragOver={handleEditorDragOver}
              onDrop={handleEditorDrop}
              onPointerDownCapture={handleSurfacePointerDown}
              onScroll={handleEditorSurfaceScroll}
            >
              <div className="document-editor-layout" style={{ padding: '12px 40px 24px', maxWidth: 800, margin: '0 auto' }}>
                {contentReady ? (
                  blockingLoadError ? (
                    renderLoadState()
                  ) : (
                    <textarea
                      ref={rawEditorRef}
                      value={tab.content}
                      onChange={handleRawEditorChange}
                      onMouseUp={handleEditorMouseUp}
                      onKeyUp={handleEditorKeyUp}
                      onSelect={handleEditorSelect}
                      onFocus={handleEditorFocus}
                      onBlur={handleEditorBlur}
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
              ref={previewSurfaceRef}
              className="panel-hover-scrollbar document-preview-surface flex-1 overflow-auto"
              style={{ background: 'transparent' }}
              onContextMenu={handleContextMenu}
              onPointerDownCapture={handleSurfacePointerDown}
              onScroll={handlePreviewSurfaceScroll}
            >
              <div className="document-preview-layout" style={{ padding: '12px 40px 24px', maxWidth: 800, margin: '0 auto' }}>
                {blockingLoadError ? (
                  renderLoadState()
                ) : (
                  <NotePreview
                    content={tab.content}
                    notePath={tab.path}
                    focusWidgetTitle={previewFocusWidgetTitle}
                    editable={previewEditable && !blockingLoadError}
                    onApplyContentEdit={handlePreviewContentEdit}
                    onWidgetRename={handleWidgetRename}
                    onWidgetQuote={handleWidgetQuoteToAgent}
                    onWidgetExport={handleWidgetExport}
                    onWidgetEdit={handleWidgetEditRequest}
                    onWidgetStateChange={handleWidgetStateChange}
                    widgetStates={widgetStates}
                  />
                )}
              </div>
            </div>
          )}
        </>
      </div>

      <WidgetEditDrawer
        open={editingWidget !== null}
        input={editingWidget ? {
          id: editingWidget.id,
          title: editingWidget.title,
          widgetCode: editingWidget.widgetCode,
          skeletonSpec: editingWidget.skeletonSpec,
          componentSpec: editingWidget.componentSpec,
        } : null}
        onClose={() => setEditingWidget(null)}
        onSave={handleWidgetEditSave}
      />

      {/* ── Markdown selection toolbar (only in edit mode) ───── */}
      {viewMode === 'edit' && selectionRange && (
        <MarkdownSelectionToolbar
          textareaRef={rawEditorRef}
          content={tab.content}
          selectionRange={selectionRange}
          anchor={selectionAnchor}
          onChange={handleToolbarChange}
        />
      )}

      {/* ── Editor Context Menu (fixed position, portal-like) ── */}
      <EditorContextMenu
        editor={null}
        visible={contextMenu.visible}
        position={{ x: contextMenu.x, y: contextMenu.y }}
        onClose={closeContextMenu}
        canQuote={contextSelection.trim().length > 0}
        onQuoteToAgent={quoteSelectionToAgent}
        onPasteToStickyNote={pasteSelectionToStickyNote}
      />
    </div>
  )
}
