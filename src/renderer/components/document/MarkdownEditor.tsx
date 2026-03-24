import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDocTabs, type DocTab, type PendingDocReveal } from '../../stores/useDocTabs'
import EditorContextMenu from './EditorContextMenu'
import DocumentWidgetBlockCard from './DocumentWidgetBlockCard'
import RichDocumentView from './RichDocumentView'
import { addDocumentQuoteReference, addDocumentWidgetTargetReference } from '../../modules/agent/chat-input-bridge'
import {
  getDroppedFileKind,
  getDroppedFilesFromDataTransfer,
  toFileUrl,
} from '../../utils/dragDrop'
import { convertDocxHtmlToMarkdownText } from '../../utils/docx-format'
import { type DocumentViewMode } from './document-view-modes'
import { tryParseWidgetPayload } from './widget-fence-parser'
import '../../styles/tiptap.css'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const DEFAULT_CONTENT = `# 欢迎使用 Ready 文档编辑器

现在文档模式分成两层：

- **排版**：查看最终成品效果
- **源码**：直接编辑 Markdown 原文和生成式内容

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
> Ready 让创作更高效。
`

const SOURCE_WIDGET_FENCE_REGEX = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g

interface ReadResult {
  success?: boolean
  content?: string
  html?: string
  data?: Record<string, unknown>
  error?: string
}

interface SourceWidgetCard {
  key: string
  title: string
  widgetCode: string
  rawFence: string
  start: number
  end: number
  modeLabel: string
}

const getFileExt = (path: string | null): string => {
  if (!path) return ''
  return (path.split('/').pop() || '').split('.').pop()?.toLowerCase() || ''
}

interface MarkdownEditorProps {
  tab: DocTab
  viewMode?: DocumentViewMode
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

function getWidgetModeLabel(widgetCode: string): string {
  if (/<script\b/i.test(widgetCode)) return '脚本交互'
  if (/<svg\b/i.test(widgetCode)) return 'SVG widget'
  return 'HTML widget'
}

function collectSourceWidgets(content: string): SourceWidgetCard[] {
  const widgets: SourceWidgetCard[] = []

  for (const match of content.matchAll(SOURCE_WIDGET_FENCE_REGEX)) {
    const rawFence = match[0]
    const rawBody = match[1] || ''
    const start = match.index ?? 0
    const widget = tryParseWidgetPayload(rawBody, rawFence)
    if (!widget) continue

    const title = widget.title || `widget_${widgets.length + 1}`
    widgets.push({
      key: `${title}-${start}`,
      title,
      widgetCode: widget.widgetCode,
      rawFence,
      start,
      end: start + rawFence.length,
      modeLabel: getWidgetModeLabel(widget.widgetCode),
    })
  }

  return widgets
}

function removeWidgetFromSourceContent(content: string, widget: SourceWidgetCard): string {
  const before = content.slice(0, widget.start).replace(/[ \t]*\n?$/, '')
  const after = content.slice(widget.end).replace(/^\n+/, '')
  const merged = [before, after].filter(Boolean).join('\n\n')
  return merged.replace(/\n{3,}/g, '\n\n')
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
  targetExt: string,
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

function findSourceRevealRange(
  content: string,
  revealTarget: PendingDocReveal | null,
): { start: number; end: number } | null {
  if (!revealTarget) return null

  const normalizedContent = normalizeDocText(content)
  const selection = normalizeDocText(revealTarget.selection || '').trim()

  if (selection) {
    const index = normalizedContent.indexOf(selection)
    if (index >= 0) {
      return {
        start: index,
        end: index + selection.length,
      }
    }
  }

  if (revealTarget.lineStart && revealTarget.lineStart > 0) {
    const lines = normalizedContent.split('\n')
    if (lines.length === 0) return null

    const startLine = Math.min(revealTarget.lineStart - 1, lines.length - 1)
    const endLine = Math.min(
      Math.max(startLine, (revealTarget.lineEnd || revealTarget.lineStart) - 1),
      lines.length - 1,
    )
    const start = lines.slice(0, startLine).reduce((sum, line) => sum + line.length + 1, 0)
    const selectedBlock = lines.slice(startLine, endLine + 1).join('\n')

    return {
      start,
      end: start + selectedBlock.length,
    }
  }

  return null
}

function buildSourceModeMeta(currentExt: string): { badge: string; hint: string } {
  if (currentExt === 'docx') {
    return {
      badge: 'DOCX 文本',
      hint: '这里编辑正文原文，生成式内容的更新、查看源码和删除也都在这里完成。',
    }
  }

  if (currentExt && !['md', 'markdown', 'txt'].includes(currentExt)) {
    return {
      badge: `${currentExt.toUpperCase()} 原文`,
      hint: '这里直接显示文件原文，不做提前渲染。',
    }
  }

  return {
    badge: 'Markdown 原文',
    hint: '这里直接编辑原始 Markdown；生成式内容的管理动作也只放在这里。',
  }
}

export default function MarkdownEditor({
  tab,
  viewMode = 'rich',
}: MarkdownEditorProps) {
  const { updateTabContent, markTabSaved, pendingReveal, setPendingReveal } = useDocTabs()
  const [isLoading, setIsLoading] = useState(!!tab.path)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [contentReady, setContentReady] = useState(!tab.path || !!tab.content)
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean
    x: number
    y: number
  }>({ visible: false, x: 0, y: 0 })
  const [contextSelection, setContextSelection] = useState<string>('')
  const [focusedWidgetKey, setFocusedWidgetKey] = useState<string | null>(null)

  const sourceEditorRef = useRef<HTMLTextAreaElement>(null)

  const currentExt = useMemo(() => getFileExt(tab.path), [tab.path])
  const canSave = !!tab.path
  const sourceModeMeta = useMemo(() => buildSourceModeMeta(currentExt), [currentExt])
  const sourceWidgets = useMemo(() => collectSourceWidgets(tab.content), [tab.content])
  const activeRevealTarget = useMemo(() => {
    if (!tab.path || !pendingReveal || pendingReveal.path !== tab.path) return null
    return pendingReveal
  }, [pendingReveal, tab.path])

  const isSourceMode = viewMode === 'source'

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!tab.path) {
        if (!tab.content && !tab.isDirty) {
          updateTabContent(tab.id, DEFAULT_CONTENT)
        }
        return
      }

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

  const handleSourceChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateTabContent(tab.id, e.target.value)
    setSaveState('idle')
  }, [tab.id, updateTabContent])

  const handleSourceSelection = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget
    setContextSelection(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd))
  }, [])

  const getCurrentSelectionText = useCallback(() => {
    if (isSourceMode && sourceEditorRef.current) {
      const textarea = sourceEditorRef.current
      return textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
    }

    return window.getSelection?.()?.toString() || ''
  }, [isSourceMode])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextSelection(getCurrentSelectionText())
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [getCurrentSelectionText])

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

  const insertSnippetAtSourceSelection = useCallback((snippet: string) => {
    const textarea = sourceEditorRef.current
    if (!textarea) {
      updateTabContent(tab.id, `${tab.content}${snippet}`)
      setSaveState('idle')
      return
    }

    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const nextContent = `${tab.content.slice(0, start)}${snippet}${tab.content.slice(end)}`
    updateTabContent(tab.id, nextContent)
    setSaveState('idle')

    requestAnimationFrame(() => {
      const nextTextarea = sourceEditorRef.current
      if (!nextTextarea) return
      const cursor = start + snippet.length
      nextTextarea.focus()
      nextTextarea.setSelectionRange(cursor, cursor)
    })
  }, [tab.content, tab.id, updateTabContent])

  const handleEditorDrop = useCallback((e: React.DragEvent) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    if (droppedFiles.length === 0) return

    e.preventDefault()
    const snippet = getMarkdownForDroppedFiles(droppedFiles, currentExt)
    if (!snippet) return
    insertSnippetAtSourceSelection(snippet)
  }, [currentExt, insertSnippetAtSourceSelection])

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
    addDocumentWidgetTargetReference({
      documentTitle: tab.title,
      documentPath: tab.path,
      widgetTitle,
      widgetCode,
      widgetMode: /<script\b/i.test(widgetCode)
        ? 'scripted'
        : /<svg\b/i.test(widgetCode)
          ? 'static-svg'
          : 'static-html',
    })
  }, [tab.path, tab.title])

  const focusSourceRange = useCallback((start: number, end: number, widgetKey?: string | null) => {
    const textarea = sourceEditorRef.current
    if (!textarea) return

    requestAnimationFrame(() => {
      const nextTextarea = sourceEditorRef.current
      if (!nextTextarea) return
      nextTextarea.focus()
      nextTextarea.setSelectionRange(start, end)
      const lineHeight = Number.parseFloat(window.getComputedStyle(nextTextarea).lineHeight || '22') || 22
      const before = tab.content.slice(0, start)
      const lineIndex = Math.max(0, before.split('\n').length - 1)
      nextTextarea.scrollTop = Math.max(0, lineIndex * lineHeight - nextTextarea.clientHeight / 3)
      setContextSelection(nextTextarea.value.slice(start, end))
      setFocusedWidgetKey(widgetKey || null)
    })
  }, [tab.content])

  const handleToggleWidgetSource = useCallback((widget: SourceWidgetCard) => {
    const textarea = sourceEditorRef.current
    if (!textarea) return

    if (focusedWidgetKey === widget.key) {
      textarea.focus()
      textarea.setSelectionRange(widget.end, widget.end)
      setFocusedWidgetKey(null)
      setContextSelection('')
      return
    }

    focusSourceRange(widget.start, widget.end, widget.key)
  }, [focusSourceRange, focusedWidgetKey])

  const handleDeleteWidget = useCallback((widget: SourceWidgetCard) => {
    const nextContent = removeWidgetFromSourceContent(tab.content, widget)
    updateTabContent(tab.id, nextContent)
    setSaveState('idle')
    if (focusedWidgetKey === widget.key) {
      setFocusedWidgetKey(null)
      setContextSelection('')
    }
  }, [focusedWidgetKey, tab.content, tab.id, updateTabContent])

  useEffect(() => {
    if (!isSourceMode || !activeRevealTarget) return

    const range = findSourceRevealRange(tab.content, activeRevealTarget)
    if (!range) {
      setPendingReveal(null)
      return
    }

    focusSourceRange(range.start, range.end)
    setPendingReveal(null)
  }, [activeRevealTarget, focusSourceRange, isSourceMode, setPendingReveal, tab.content])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden flex" style={{ background: 'var(--bg-content)' }}>
        {isSourceMode ? (
          <div
            className="flex-1 overflow-auto"
            style={{ position: 'relative' }}
            onContextMenu={handleContextMenu}
            onDragOver={handleEditorDragOver}
            onDrop={handleEditorDrop}
          >
            <div className="document-source-shell">
              <div className="document-source-header">
                <div className="document-source-badge">{sourceModeMeta.badge}</div>
                <div className="document-source-hint">{sourceModeMeta.hint}</div>
              </div>

              {contentReady ? (
                <textarea
                  ref={sourceEditorRef}
                  className="document-source-textarea"
                  value={tab.content}
                  onChange={handleSourceChange}
                  onSelect={handleSourceSelection}
                  readOnly={isLoading}
                  spellCheck={false}
                  placeholder="开始输入 Markdown 原文..."
                />
              ) : (
                <div className="flex items-center justify-center py-10">
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载中...</span>
                </div>
              )}

              {sourceWidgets.length > 0 ? (
                <div className="document-source-widgets">
                  <div className="document-source-widgets-header">
                    <div className="document-source-widgets-title">生成式内容</div>
                    <div className="document-source-widgets-hint">这里保留更新、查看源码、复制源码和删除等管理动作。</div>
                  </div>
                  <div className="document-source-widgets-list">
                    {sourceWidgets.map((widget) => (
                      <DocumentWidgetBlockCard
                        key={widget.key}
                        title={widget.title}
                        modeLabel={widget.modeLabel}
                        widgetCode={widget.widgetCode}
                        sourceVisible={focusedWidgetKey === widget.key}
                        onRequestAgentUpdate={(title, widgetCode) => requestAgentUpdateWidget(title, widgetCode)}
                        onToggleSource={() => handleToggleWidgetSource(widget)}
                        onCopySource={() => {
                          void navigator.clipboard?.writeText(widget.rawFence)
                        }}
                        onDelete={() => handleDeleteWidget(widget)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div
            className="flex-1 overflow-auto"
            style={{ background: 'var(--bg-content)' }}
            onContextMenu={handleContextMenu}
          >
            <div style={{ padding: '16px 40px 28px', maxWidth: 860, margin: '0 auto' }}>
              <RichDocumentView content={tab.content} notePath={tab.path} />
            </div>
          </div>
        )}
      </div>

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
