import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import TiptapEditor, { type TiptapEditorRef } from './TiptapEditor'
import EditorFloatingToolbar from './EditorFloatingToolbar'
import EditorContextMenu from './EditorContextMenu'
import NotePreview from './NotePreview'
import { addDocumentQuoteReference, appendToAgentInput } from '../../modules/agent/chat-input-bridge'
import {
  getDroppedFileKind,
  getDroppedFilesFromDataTransfer,
  toFileUrl,
} from '../../utils/dragDrop'
import { convertDocxHtmlToMarkdownText } from '../../utils/docx-format'
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
  onRequestPreview?: (title: string) => void
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
  onRequestPreview,
  previewFocusWidgetTitle,
}: MarkdownEditorProps) {
  const { updateTabContent, markTabSaved, pendingReveal, setPendingReveal } = useDocTabs()
  const [isLoading, setIsLoading] = useState(!!tab.path)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [contentReady, setContentReady] = useState(!tab.path || !!tab.content)

  // TiptapEditor ref
  const tiptapRef = useRef<TiptapEditorRef>(null)

  // Editor container ref for positioning floating toolbar
  const editorContainerRef = useRef<HTMLDivElement>(null)

  // Floating toolbar state
  const [hasSelection, setHasSelection] = useState(false)
  const [floatingToolbarPos, setFloatingToolbarPos] = useState({ x: 0, y: 0 })

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
  }>({ visible: false, x: 0, y: 0 })
  const [contextSelection, setContextSelection] = useState<string>('')

  const currentExt = useMemo(() => getFileExt(tab.path), [tab.path])
  const canSave = !!tab.path
  const activeRevealTarget = useMemo(() => {
    if (!tab.path || !pendingReveal || pendingReveal.path !== tab.path) return null
    return pendingReveal
  }, [pendingReveal, tab.path])

  const showFloatingToolbar =
    hasSelection && viewMode === 'edit'

  // ─── File loading ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!tab.path) {
        if (!tab.content && !tab.isDirty) {
          updateTabContent(tab.id, DEFAULT_CONTENT)
        }
        return
      }

      // Avoid clobbering content that has already been loaded by tool actions.
      if (tab.content.length > 0 && !tab.isDirty) {
        setIsLoading(false)
        setContentReady(true)
        return
      }

      if (typeof window === 'undefined' || !window.electronAPI) return

      setIsLoading(true)
      try {
        const ext = getFileExt(tab.path)
        if (['md', 'txt', 'json', 'ts', 'tsx', 'js', 'css', 'html'].includes(ext)) {
          const result = (await window.electronAPI.document.readFile(tab.path)) as ReadResult
          if (!result.success) throw new Error(result.error || '文件读取失败')
          if (!cancelled) {
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
            updateTabContent(tab.id, markdownish)
            markTabSaved(tab.id)
          }
        } else {
          if (!cancelled) {
            updateTabContent(tab.id, `# 暂不支持该格式\n\n文件: ${tab.path}`)
            markTabSaved(tab.id)
          }
        }
      } catch (error) {
        if (!cancelled) {
          updateTabContent(tab.id, `# 文件读取失败\n\n${error instanceof Error ? error.message : String(error)}`)
          markTabSaved(tab.id)
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

  // ─── Save logic ─────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!tab.path || !canSave || !tab.isDirty) return
    if (typeof window === 'undefined' || !window.electronAPI) return
    setSaveState('saving')
    try {
      const result = (await window.electronAPI.document.writeFile(tab.path, tab.content)) as ReadResult
      if (!result.success) throw new Error(result.error || '保存失败')
      setSaveState('saved')
      markTabSaved(tab.id)
    } catch {
      setSaveState('error')
    }
  }, [tab.path, tab.content, canSave, tab.id, markTabSaved])

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

  // ─── TiptapEditor callbacks ─────────────────────────────────
  const handleEditorChange = useCallback(
    (markdown: string) => {
      updateTabContent(tab.id, markdown)
      setSaveState('idle')
    },
    [tab.id, updateTabContent]
  )

  const handleSelectionChange = useCallback(
    (selected: boolean) => {
      setHasSelection(selected)
      if (selected && tiptapRef.current?.editor && editorContainerRef.current) {
        const editor = tiptapRef.current.editor
        const { from, to } = editor.state.selection
        const startCoords = editor.view.coordsAtPos(from)
        const endCoords = editor.view.coordsAtPos(to)
        const containerRect = editorContainerRef.current.getBoundingClientRect()

        setFloatingToolbarPos({
          x: (startCoords.left + endCoords.right) / 2 - containerRect.left,
          y: startCoords.top - containerRect.top - 50,
        })
      }
    },
    []
  )

  // ─── Context menu handler ──────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const selectedText = window.getSelection?.()?.toString() || ''
    setContextSelection(selectedText)
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [])

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

    const prefix = tab.content.trim().length === 0
      ? ''
      : tab.content.endsWith('\n') ? '\n' : '\n\n'
    updateTabContent(tab.id, `${tab.content}${prefix}${snippet}\n`)
    setSaveState('idle')
  }, [currentExt, tab.content, tab.id, updateTabContent])

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

  const requestAgentUpdateWidget = useCallback((widgetTitle: string, widgetCode: string) => {
    const snippet = [
      `请直接更新当前文档中的 widget，不要新增第二个。`,
      `目标 widget: ${widgetTitle}`,
      `文档: ${tab.title}`,
      `路径: ${tab.path || '(未保存草稿)'}`,
      '',
      '当前 widget 源码如下：',
      '```show-widget',
      JSON.stringify({
        title: widgetTitle,
        widget_code: widgetCode,
      }),
      '```',
      '',
      '请优先使用 document_update_widget 完成更新，并在修改后保存文档。',
    ].join('\n')

    appendToAgentInput(snippet)
  }, [tab.path, tab.title])

  // ─── View mode buttons ─────────────────────────────────────
  // (Moved to DocumentMode header — no longer rendered here)

  // Resolve TiptapEditor editor instance for context menu / toolbar
  const editorInstance = tiptapRef.current?.editor ?? null

  return (
    <div className="flex flex-col h-full">
      {/* ── Content area ──────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex" style={{ background: 'var(--bg-content)' }}>
        <>
          {/* ── Edit pane: TiptapEditor ── */}
          {viewMode === 'edit' && (
            <div
              ref={editorContainerRef}
              className="flex-1 overflow-auto"
              style={{ position: 'relative' }}
              onContextMenu={handleContextMenu}
              onDragOver={handleEditorDragOver}
              onDrop={handleEditorDrop}
            >
              <div style={{ padding: '12px 40px 24px', maxWidth: 800, margin: '0 auto' }}>
                {contentReady ? (
                  <TiptapEditor
                    ref={tiptapRef}
                    content={tab.content}
                    onChange={handleEditorChange}
                    onSelectionChange={handleSelectionChange}
                    onRequestPreview={onRequestPreview}
                    onRequestAgentUpdate={requestAgentUpdateWidget}
                    editable={!isLoading}
                    revealTarget={activeRevealTarget}
                    onRevealHandled={() => {
                      if (activeRevealTarget) {
                        setPendingReveal(null)
                      }
                    }}
                  />
                ) : (
                  <div className="flex items-center justify-center py-10">
                    <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载中...</span>
                  </div>
                )}
              </div>

              {/* ── Floating Toolbar (above selection) ── */}
              <EditorFloatingToolbar
                editor={editorInstance}
                visible={showFloatingToolbar}
                position={floatingToolbarPos}
              />
            </div>
          )}

          {/* ── Preview pane ──────────── */}
          {viewMode === 'preview' && (
            <div
              className="flex-1 overflow-auto"
              style={{ background: 'var(--bg-content)' }}
              onContextMenu={handleContextMenu}
            >
              <div style={{ padding: '12px 40px 24px', maxWidth: 800, margin: '0 auto' }}>
                <NotePreview content={tab.content} notePath={tab.path} focusWidgetTitle={previewFocusWidgetTitle} />
              </div>
            </div>
          )}
        </>
      </div>

      {/* ── Editor Context Menu (fixed position, portal-like) ── */}
      <EditorContextMenu
        editor={editorInstance}
        visible={contextMenu.visible}
        position={{ x: contextMenu.x, y: contextMenu.y }}
        onClose={closeContextMenu}
        canQuote={contextSelection.trim().length > 0}
        onQuoteToAgent={quoteSelectionToAgent}
      />
    </div>
  )
}
