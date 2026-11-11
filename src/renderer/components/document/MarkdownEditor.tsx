import { librarySelectionRangeFromDOM } from '../../modules/agent/libraryResourceSelection'
import { textAreaContent, textAreaOffset } from '../../modules/document/block-editor/text-edit'
import { useSourceHistory } from '../../modules/document/block-editor/use-source-history'
import { parseDocumentBlocks } from '../../../shared/document-blocks'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  reconcileWidgetStateMapFromContent,
  renameWidgetFenceTitleInContent,
  replaceWidgetFenceWithSkeletonInContent,
} from './widget-card-helpers'
import { collectDocumentWidgets, type DocumentWidgetRecord } from '../../../shared/document-widget-parse'
import {
  getDroppedFileKind,
  getDroppedFilesFromDataTransfer,
  toFileUrl,
} from '../../utils/dragDrop'
import { convertDocxHtmlToMarkdownText } from '../../utils/docx-format'
import { shouldApplyAsyncDocumentLoad } from './documentLoadGuard'
import {
  endGeneratedImageDrag,
  getGeneratedImageDragPayload,
} from '../../modules/image-generation/generatedImageDrag'
import {
  advanceWidgetFenceSignatureForTextEdit,
  buildWidgetFenceSignatureSnapshot,
} from '../../modules/document/widgetFenceSignature'
import {
  getDocumentSaveSerializationKey,
  registerDocumentSaveHandler,
} from '../../modules/document/documentSaveRegistry'
import { saveDocumentTabSnapshot } from '../../modules/document/documentSaveRuntime'
import '../../styles/tiptap.css'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'


interface ReadResult {
  success?: boolean
  content?: string
  html?: string
  data?: Record<string, unknown>
  error?: string
  errorCode?: string
}

const getFileExt = (path: string | null): string => {
  if (!path) return ''
  return (path.split('/').pop() || '').split('.').pop()?.toLowerCase() || ''
}

interface MarkdownEditorProps {
  tab: DocTab
  viewMode?: 'edit' | 'preview'
  /** Page view edits the shared tab buffer; read-only export keeps this off. */
  previewEditable?: boolean
  previewFocusWidgetTitle?: string | null
  onVisibleLineChange?: (line: number | null) => void
  onActivate?: () => void
  /** Page view: shown at the top of the preview scroll area (icon, cover, title), so it scrolls with the page. */
  previewHeader?: ReactNode
  /** Page view classes on the preview scroll area; its layout then comes from the page stylesheet. */
  previewClassName?: string
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function getPreviewHeadingSourceLine(heading: HTMLElement): number | null {
  const direct = Number(heading.dataset.readySourceLine)
  if (Number.isFinite(direct) && direct > 0) return direct
  const block = heading.closest<HTMLElement>('[data-ready-block-source-line]')
  const fromBlock = Number(block?.dataset.readyBlockSourceLine)
  return Number.isFinite(fromBlock) && fromBlock > 0 ? fromBlock : null
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
  previewHeader,
  previewClassName,
}: MarkdownEditorProps) {
  const updateTabContent = useDocTabs((state) => state.updateTabContent)
  const hydrateTabContentFromDisk = useDocTabs((state) => state.hydrateTabContentFromDisk)
  const pendingReveal = useDocTabs((state) => state.pendingReveal)
  const setPendingReveal = useDocTabs((state) => state.setPendingReveal)
  const [isLoading, setIsLoading] = useState(!!tab.path)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const sourceHistory = useSourceHistory(tab.id, message => { setSaveError(message); setSaveState('error') })
  const [contentReady, setContentReady] = useState(!tab.path || !!tab.content)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [widgetStates, setWidgetStates] = useState<Record<string, DocumentWidgetPersistedState>>(() => (
    extractWidgetStateMapFromContent(tab.content)
  ))
  const [initialWidgetFenceSnapshot] = useState(() => buildWidgetFenceSignatureSnapshot(tab.content))
  const [editingWidget, setEditingWidget] = useState<DocumentWidgetRecord | null>(null)
  const widgetStatesRef = useRef(widgetStates)
  const tabContentRef = useRef(tab.content)
  const widgetFenceSnapshotRef = useRef(initialWidgetFenceSnapshot)
  const widgetFenceSnapshotContentRef = useRef(tab.content)
  const widgetFenceSignatureRef = useRef(widgetFenceSnapshotRef.current.signature)
  const rawEditRangeRef = useRef<SelectionRange | null>(null)
  const rawEditorRef = useRef<HTMLTextAreaElement>(null)
  const editorSurfaceRef = useRef<HTMLDivElement>(null)
  const previewSurfaceRef = useRef<HTMLDivElement>(null)
  const visibleLineFrameRef = useRef<number | null>(null)
  const previewScrollFrameRef = useRef<number | null>(null)
  const saveInFlightRef = useRef(false)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
  }>({ visible: false, x: 0, y: 0 })
  const [contextSelection, setContextSelection] = useState<string>('')
  const [contextSelectionRange, setContextSelectionRange] = useState<(SelectionRange & { text: string }) | null>(null)

  // Selection toolbar state (markdown formatting on highlighted text)
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null)
  const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null)

  const currentExt = useMemo(() => getFileExt(tab.path), [tab.path])
  // The object id comes back with the tab at startup, before path-to-object lookups are known.
  const documentScrollKey = useMemo(() => tab.objectId || tab.path || tab.id, [tab.id, tab.objectId, tab.path])
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
        // A new, untitled page starts empty (W3 §4.2: no welcome document).
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
        if (['md', 'markdown', 'txt', 'json', 'ts', 'tsx', 'js', 'css', 'html'].includes(ext)) {
          const result = (await window.electronAPI.document.readFile(tab.path)) as ReadResult
          if (!result.success) {
            if (result.errorCode === 'TEXT_FILE_TOO_LARGE') {
              throw new Error(result.error || '文件过大，无法在文档编辑器中打开。')
            }
            throw new Error(result.error || '文件读取失败')
          }
          if (!cancelled && canCommitLoadedContent()) {
            hydrateTabContentFromDisk(tab.id, result.content || '')
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
              hydrateTabContentFromDisk(tab.id, markdownish)
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
    if (!loadError || tab.content.length === 0) return
    setLoadError(null)
    setContentReady(true)
    setIsLoading(false)
  }, [loadError, tab.content])

  useEffect(() => {
    tabContentRef.current = tab.content
    if (widgetFenceSnapshotContentRef.current !== tab.content) {
      widgetFenceSnapshotRef.current = buildWidgetFenceSignatureSnapshot(tab.content)
      widgetFenceSnapshotContentRef.current = tab.content
    }
    const nextSignature = widgetFenceSnapshotRef.current.signature
    if (nextSignature === widgetFenceSignatureRef.current) return
    widgetFenceSignatureRef.current = nextSignature
    if (!nextSignature) {
      widgetStatesRef.current = {}
      setWidgetStates({})
      return
    }
    setWidgetStates((prev) => {
      const next = reconcileWidgetStateMapFromContent(tab.content, prev)
      const previousEntries = Object.entries(prev)
      const unchanged = previousEntries.length === Object.keys(next).length && previousEntries.every(([key, value]) => (
        JSON.stringify(value) === JSON.stringify(next[key])
      ))
      if (unchanged) return prev
      widgetStatesRef.current = next
      return next
    })
  }, [tab.content])

  // ─── Save logic ─────────────────────────────────────────────
  // The app-level shortcut selects one pane; this mounted editor owns the
  // operation so errors and in-flight state stay with the correct document.
  const saveCurrentTab = useCallback(async () => {
    if (saveInFlightRef.current) return
    const api = window.electronAPI?.document
    try { sourceHistory.buffer.flush() } catch (error) { setSaveState('error'); setSaveError(String(error)); return }
    const currentState = useDocTabs.getState()
    const currentTab = currentState.tabs.find((item) => item.id === tab.id)
    if (!api || !currentTab) return

    saveInFlightRef.current = true
    setSaveState('saving')
    setSaveError(null)
    try {
      const outcome = await saveDocumentTabSnapshot({
        tab: currentTab,
        api,
        setTabPath: currentState.setTabPath,
        renameTab: currentState.renameTab,
        commitTabSaveSnapshot: currentState.commitTabSaveSnapshot,
      })
      if (outcome.status === 'error') {
        setSaveState('error')
        setSaveError(outcome.error)
      } else if (outcome.status === 'saved') {
        setSaveState('saved')
      } else {
        setSaveState('idle')
      }
    } catch (error) {
      setSaveState('error')
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      saveInFlightRef.current = false
    }
  }, [tab.id, sourceHistory.buffer])

  useEffect(
    () => registerDocumentSaveHandler(
      tab.id,
      saveCurrentTab,
      getDocumentSaveSerializationKey(tab.id, tab.path),
    ),
    [saveCurrentTab, tab.id, tab.path],
  )

  const replaceEditorContent = useCallback((nextContent: string) => {
    tabContentRef.current = nextContent
    widgetFenceSnapshotRef.current = buildWidgetFenceSignatureSnapshot(nextContent)
    widgetFenceSnapshotContentRef.current = nextContent
    updateTabContent(tab.id, nextContent)
  }, [tab.id, updateTabContent])

  const handleRawEditorBeforeInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    rawEditRangeRef.current = {
      start: textAreaOffset(tabContentRef.current, e.currentTarget.selectionStart),
      end: textAreaOffset(tabContentRef.current, e.currentTarget.selectionEnd),
    }
  }, [])

  const handleRawEditorChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const previousContent = tabContentRef.current
    const nextContent = textAreaContent(previousContent, e.target.value)
    const editRange = rawEditRangeRef.current
    rawEditRangeRef.current = null
    if (editRange) {
      const insertedLength = nextContent.length - (previousContent.length - (editRange.end - editRange.start))
      if (insertedLength >= 0 && editRange.start + insertedLength <= nextContent.length) {
        const advanced = advanceWidgetFenceSignatureForTextEdit(
          widgetFenceSnapshotRef.current,
          previousContent,
          {
            ...editRange,
            insertedText: nextContent.slice(editRange.start, editRange.start + insertedLength),
          },
        )
        if (advanced) {
          widgetFenceSnapshotRef.current = advanced
          widgetFenceSnapshotContentRef.current = nextContent
        }
      }
    }
    tabContentRef.current = nextContent
    sourceHistory.change(nextContent, textAreaOffset(nextContent, e.target.selectionStart))
    setSaveState('idle')
  }, [sourceHistory])

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
      replaceEditorContent(textAreaContent(tabContentRef.current, nextContent))
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
    [replaceEditorContent],
  )

  // ─── Context menu handler ──────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rawEditor = rawEditorRef.current
    const editSelectionRange = viewMode === 'edit' && rawEditor && rawEditor.selectionStart !== rawEditor.selectionEnd
      ? { start: textAreaOffset(tabContentRef.current, rawEditor.selectionStart), end: textAreaOffset(tabContentRef.current, rawEditor.selectionEnd) }
      : null
    const selectedText = viewMode === 'edit' && rawEditor
      ? rawEditor.value.slice(rawEditor.selectionStart, rawEditor.selectionEnd)
      : window.getSelection?.()?.toString() || ''
    let sourceRange = editSelectionRange
    if (!sourceRange && selectedText) {
      try {
        const selection = window.getSelection()
        if (!selection?.rangeCount) throw new Error('library_selection_ambiguous')
        sourceRange = librarySelectionRangeFromDOM(tabContentRef.current, selection.getRangeAt(0))
      } catch {
        setSaveState('error'); setSaveError('无法确定引用范围，请切换到源码视图重新选择。')
        setContextSelection(''); setContextSelectionRange(null)
        return
      }
    }
    setContextSelection(selectedText)
    setContextSelectionRange(sourceRange ? { ...sourceRange, text: tabContentRef.current.slice(sourceRange.start, sourceRange.end) } : null)
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
    const generatedImage = getGeneratedImageDragPayload(e.dataTransfer)
    if (generatedImage) {
      e.preventDefault()
      e.stopPropagation()
      endGeneratedImageDrag()
      const rawEditor = rawEditorRef.current
      const selectionStart = viewMode === 'edit' && rawEditor ? rawEditor.selectionStart : null
      const selectionEnd = viewMode === 'edit' && rawEditor ? rawEditor.selectionEnd : null
      void (async () => {
        if (!tab.path) {
          setSaveState('error')
          setSaveError('请先保存文档，再插入生成图片。')
          return
        }
        if (currentExt === 'docx') {
          setSaveState('error')
          setSaveError('生成图片请插入 Markdown 文档；DOCX 当前不会可靠保留外部 assets 图片。')
          return
        }
        const result = await window.electronAPI.imageGeneration.persistToDocument({
          sourcePath: generatedImage.path,
          documentPath: tab.path,
        })
        if (!result.success || !result.data?.relativePath) {
          setSaveState('error')
          setSaveError(result.error || '图片复制到文档 assets 失败')
          return
        }
        const alt = generatedImage.name.replace(/\.[^.]+$/, '')
        const snippet = `![${alt}](${result.data.relativePath})`
        const currentContent = tabContentRef.current
        let nextContent: string
        if (selectionStart !== null && selectionEnd !== null) {
          const start = Math.max(0, Math.min(selectionStart, currentContent.length))
          const end = Math.max(start, Math.min(selectionEnd, currentContent.length))
          const before = currentContent.slice(0, start)
          const after = currentContent.slice(end)
          const leading = before.length > 0 && !before.endsWith('\n') ? '\n\n' : ''
          const trailing = after.length > 0 && !snippet.endsWith('\n') ? '\n' : ''
          const insertion = `${leading}${snippet}${trailing}`
          nextContent = `${before}${insertion}${after}`
          requestAnimationFrame(() => {
            const editor = rawEditorRef.current
            if (!editor) return
            const cursor = before.length + insertion.length
            editor.focus()
            editor.setSelectionRange(cursor, cursor)
          })
        } else {
          const prefix = currentContent.trim().length === 0 ? '' : currentContent.endsWith('\n') ? '\n' : '\n\n'
          nextContent = `${currentContent}${prefix}${snippet}\n`
        }
        replaceEditorContent(nextContent)
        setSaveError(null)
        setSaveState('idle')
      })().catch((error) => {
        setSaveState('error')
        setSaveError(error instanceof Error ? error.message : String(error))
      })
      return
    }
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
      const currentContent = tabContentRef.current
      const before = currentContent.slice(0, selectionStart)
      const after = currentContent.slice(selectionEnd)
      const needsLeadingBreak = before.length > 0 && !before.endsWith('\n')
      const needsTrailingBreak = after.length > 0 && !snippet.endsWith('\n')
      const insertion = `${needsLeadingBreak ? '\n\n' : ''}${snippet}${needsTrailingBreak ? '\n' : ''}`
      replaceEditorContent(`${before}${insertion}${after}`)
      requestAnimationFrame(() => {
        const nextCursor = before.length + insertion.length
        rawEditor.focus()
        rawEditor.setSelectionRange(nextCursor, nextCursor)
      })
    } else {
      const currentContent = tabContentRef.current
      const prefix = currentContent.trim().length === 0
        ? ''
        : currentContent.endsWith('\n') ? '\n' : '\n\n'
      replaceEditorContent(`${currentContent}${prefix}${snippet}\n`)
    }
    setSaveState('idle')
  }, [currentExt, replaceEditorContent, tab.path, viewMode])

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

  const quoteSelectionToAgent = useCallback(async () => {
    const selection = contextSelectionRange?.text ?? contextSelection
    if (!selection.trim()) return
    const location = findDocumentSelectionLocation(tabContentRef.current, selection, contextSelectionRange)
    try {
      await addDocumentQuoteReference({
        title: tab.title,
        path: tab.path,
        selection,
        sourceRange: contextSelectionRange ?? undefined,
        sectionTitle: location.sectionTitle,
        lineStart: location.lineStart,
        lineEnd: location.lineEnd,
      })
    } catch {
      setSaveState('error'); setSaveError('引用的内容已变化或无法确定范围，请重新选择。')
    }
  }, [contextSelection, contextSelectionRange, tab.path, tab.title])

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
    const baseContent = tabContentRef.current
    const nextContent = renameWidgetFenceTitleInContent(baseContent, currentTitle, widgetCode, nextTitle)
    if (nextContent === baseContent) return
    const currentKey = getWidgetPersistenceKey(currentTitle, widgetCode)
    const nextKey = getWidgetPersistenceKey(nextTitle, widgetCode)
    if (widgetStatesRef.current[currentKey]) {
      const nextWidgetStates = { ...widgetStatesRef.current }
      nextWidgetStates[nextKey] = nextWidgetStates[currentKey]
      delete nextWidgetStates[currentKey]
      widgetStatesRef.current = nextWidgetStates
      setWidgetStates(nextWidgetStates)
    }
    replaceEditorContent(nextContent)
    setSaveState('idle')
  }, [replaceEditorContent])

  const handleWidgetQuoteToAgent = useCallback((widgetTitle: string, widgetCode: string) => {
    const targetWidget = collectDocumentWidgets(tabContentRef.current).find((widget) => (
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
  }, [tab.id, tab.path, tab.title])

  const handleWidgetExport = useCallback((widgetTitle: string, widgetCode: string, widgetState?: DocumentWidgetPersistedState | null) => {
    void exportWidgetCardSnapshot(widgetCode, widgetTitle, widgetState, tab.path)
  }, [tab.path])

  const handleWidgetStateChange = useCallback((widgetTitle: string, widgetCode: string, widgetState: DocumentWidgetPersistedState) => {
    const key = getWidgetPersistenceKey(widgetTitle, widgetCode)
    const baseContent = sourceHistory.buffer.snapshot.content
    let nextContent = baseContent
    for (const block of parseDocumentBlocks(baseContent).blocks.filter(block => block.type === 'widget').reverse()) {
      const widget = collectDocumentWidgets(block.raw)[0]
      if (!widget || getWidgetPersistenceKey(widget.title, widget.widgetCode) !== key) continue
      const previous = widget.widgetState ?? { controls: [], activeTargets: [] }
      if (JSON.stringify(previous) === JSON.stringify(widgetState)) continue
      const { start, end, raw } = block
      const updated = textAreaContent(raw, mergeWidgetStateMapIntoContent(raw, { [key]: widgetState }))
      nextContent = nextContent.slice(0, start) + updated + nextContent.slice(end)
    }
    if (nextContent === baseContent) return
    const nextWidgetStates = { ...widgetStatesRef.current, [key]: widgetState }
    widgetStatesRef.current = nextWidgetStates
    setWidgetStates(nextWidgetStates)
    replaceEditorContent(nextContent)
    setSaveState('idle')
  }, [replaceEditorContent, sourceHistory.buffer])

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
      replaceEditorContent(nextContent)
      setSaveState('idle')
    }
    setEditingWidget(null)
  }, [editingWidget, replaceEditorContent])

  const handleEditorSurfaceScroll = useCallback(() => {
    const surface = editorSurfaceRef.current
    const rawEditor = rawEditorRef.current
    if (!surface || !rawEditor) return
    onActivate?.()
    const lineHeight = estimateTextareaLineHeight(rawEditor)
    emitVisibleLine(Math.max(1, Math.floor(surface.scrollTop / lineHeight) + 1))
  }, [emitVisibleLine, onActivate])

  const handlePreviewSurfaceScroll = useCallback(() => {
    onActivate?.()
    if (previewScrollFrameRef.current !== null) return
    previewScrollFrameRef.current = window.requestAnimationFrame(() => {
      previewScrollFrameRef.current = null
      const surface = previewSurfaceRef.current
      if (!surface) return
      const headings = Array.from(surface.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
      const lineCount = Number(
        surface.querySelector<HTMLElement>('[data-ready-preview-line-count]')?.dataset.readyPreviewLineCount,
      ) || 1
      if (headings.length === 0) {
        const maxScroll = Math.max(1, surface.scrollHeight - surface.clientHeight)
        const line = Math.max(1, Math.round((surface.scrollTop / maxScroll) * lineCount))
        emitVisibleLine(line)
        return
      }
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
      const sourceLine = headings[nearestIndex] ? getPreviewHeadingSourceLine(headings[nearestIndex]) : null
      emitVisibleLine(sourceLine || 1)
    })
  }, [emitVisibleLine, onActivate])

  useEffect(() => () => {
    if (visibleLineFrameRef.current !== null) {
      window.cancelAnimationFrame(visibleLineFrameRef.current)
      visibleLineFrameRef.current = null
    }
    if (previewScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(previewScrollFrameRef.current)
      previewScrollFrameRef.current = null
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
    const scrollToTop = (top: number) => {
      surface.scrollTop = Math.max(0, Math.min(Math.round(top), Math.max(0, surface.scrollHeight - surface.clientHeight)))
    }

    // A freshly opened tab may not have its body yet; keep the reveal until there is something to land on.
    if (!tab.content) return
    requestAnimationFrame(() => {
      // The page view marks each block with its source line: land on the block that holds the target line.
      const blocks = Array.from(surface.querySelectorAll<HTMLElement>('[data-ready-block-source-line]'))
      const targetBlock = [...blocks].reverse().find((block) => Number(block.dataset.readyBlockSourceLine) <= targetLine)
      if (targetBlock) {
        const containerTop = surface.getBoundingClientRect().top
        scrollToTop(targetBlock.getBoundingClientRect().top - containerTop + surface.scrollTop - 8)
        targetBlock.animate?.([{ backgroundColor: 'var(--ready-reveal-flash, rgba(232, 64, 31, 0.12))' }, { backgroundColor: 'transparent' }], { duration: 1200, easing: 'ease-out' })
        setPendingReveal(null)
        return
      }
      const headings = Array.from(surface.querySelectorAll<HTMLElement>('[data-ready-heading-title]'))
      const targetHeading = [...headings].reverse().find((heading) => (getPreviewHeadingSourceLine(heading) || 1) <= targetLine)
        || headings[0]
      if (targetHeading) {
        const containerTop = surface.getBoundingClientRect().top
        scrollToTop(targetHeading.getBoundingClientRect().top - containerTop + surface.scrollTop - 8)
        setPendingReveal(null)
        return
      }

      const lineCount = Number(
        surface.querySelector<HTMLElement>('[data-ready-preview-line-count]')?.dataset.readyPreviewLineCount,
      ) || 1
      const ratio = Math.max(0, Math.min(1, targetLine / Math.max(1, lineCount)))
      scrollToTop(ratio * Math.max(0, surface.scrollHeight - surface.clientHeight))
      setPendingReveal(null)
    })
  }, [activeRevealTarget, setPendingReveal, tab.content, viewMode])

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
          {/* ── Edit pane: Markdown source textarea ── */}
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
                      onBeforeInput={handleRawEditorBeforeInput}
                      onKeyDown={sourceHistory.onKeyDown}
                      onCompositionStart={sourceHistory.onCompositionStart}
                      onCompositionEnd={sourceHistory.onCompositionEnd}
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
              className={`panel-hover-scrollbar document-preview-surface flex-1 overflow-auto${previewClassName ? ` ${previewClassName}` : ''}`}
              style={{ background: 'transparent' }}
              onContextMenu={handleContextMenu}
              onDragOver={handleEditorDragOver}
              onDrop={handleEditorDrop}
              onPointerDownCapture={handleSurfacePointerDown}
              onScroll={handlePreviewSurfaceScroll}
            >
              {previewHeader}
              <div className="document-preview-layout" style={previewClassName ? undefined : { padding: '56px 48px 120px', maxWidth: 816, margin: '0 auto' }}>
                {blockingLoadError ? (
                  renderLoadState()
                ) : (
                  <NotePreview
                    content={tab.content}
                    notePath={tab.path}
                    focusWidgetTitle={previewFocusWidgetTitle}
                    editorTabId={previewEditable && !blockingLoadError ? tab.id : undefined}
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
          content={tab.content.replace(/\r\n?/g, '\n')}
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
