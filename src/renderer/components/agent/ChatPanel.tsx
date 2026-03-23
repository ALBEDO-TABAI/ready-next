import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { X, FileText, Image, Film, Table, Globe, Puzzle, Pen, MessageSquareQuote, Folder, ChevronDown, PanelLeftClose, History, Plus } from 'lucide-react'
import { useAgent, initAgentListeners, ChatAttachment, ConversationScope } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import { useSettings } from '../../stores/useSettings'
import { READY_FOCUS_CHAT_INPUT_EVENT } from '../../modules/agent/chat-input-bridge'
import { revealDocumentQuoteAttachment } from '../../modules/agent/document-quote-navigation'
import { toLocalFileUrl } from '../../utils/dragDrop'
import { WORKBENCH_EDGE_RAIL_SIZE, WORKBENCH_TOPBAR_HEIGHT } from '../../modules/workbench/chrome'
import { LIQUID_INACTIVE_CHROME_STYLE } from '../ui/LiquidGlassScene'
import { IconButton } from '../ui/IconButton'
import ChatHeader from './ChatHeader'
import ChatMessages from './ChatMessages'
import ChatInput, { ChatInputHandle } from './ChatInput'
import ChatAttachments from './ChatAttachments'

// ---------------------------------------------------------------------------
// Lightweight Markdown renderer (no external deps)
// Supports: **bold**, *italic*, `inline code`, ```code blocks```,
//           # headers, bullet lists (- / *), numbered lists, line breaks
// ---------------------------------------------------------------------------

interface MarkdownNode {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock' | 'header' | 'bullet' | 'numbered' | 'br'
  content: string
  level?: number // header level 1-3
  lang?: string  // code block language
}

function parseMarkdown(raw: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  const lines = raw.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      nodes.push({ type: 'codeblock', content: codeLines.join('\n'), lang })
      i++ // skip closing ```
      continue
    }

    // Header (# ## ###)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headerMatch) {
      nodes.push({ type: 'header', content: headerMatch[2], level: headerMatch[1].length })
      i++
      continue
    }

    // Bullet list (- or *)
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/)
    if (bulletMatch) {
      nodes.push({ type: 'bullet', content: bulletMatch[1] })
      i++
      continue
    }

    // Numbered list
    const numMatch = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (numMatch) {
      nodes.push({ type: 'numbered', content: numMatch[1] })
      i++
      continue
    }

    // Empty line -> line break
    if (line.trim() === '') {
      nodes.push({ type: 'br', content: '' })
      i++
      continue
    }

    // Regular text line
    nodes.push({ type: 'text', content: line })
    i++
  }

  return nodes
}

/** Parse inline formatting: **bold**, *italic*, `code` */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // Combined regex for inline code, bold, italic
  const regex = /(`([^`]+)`)|(\*\*(.+?)\*\*)|(\*(.+?)\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    if (match[1]) {
      // inline code
      parts.push(
        <code
          key={`ic-${key++}`}
          style={{
            background: 'var(--bg-code)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: '0.9em',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
          }}
        >
          {match[2]}
        </code>
      )
    } else if (match[3]) {
      // bold
      parts.push(<strong key={`b-${key++}`}>{match[4]}</strong>)
    } else if (match[5]) {
      // italic
      parts.push(<em key={`i-${key++}`}>{match[6]}</em>)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

function MarkdownContent({ content }: { content: string }) {
  const nodes = useMemo(() => parseMarkdown(content), [content])

  return (
    <div className="markdown-content" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {nodes.map((node, idx) => {
        switch (node.type) {
          case 'header': {
            const fontSize = node.level === 1 ? 16 : node.level === 2 ? 14.5 : 13.5
            return (
              <div key={idx} style={{ fontSize, fontWeight: 700, marginTop: 6, marginBottom: 2 }}>
                {renderInline(node.content)}
              </div>
            )
          }
          case 'codeblock':
            return (
              <pre
                key={idx}
                style={{
                  background: 'var(--bg-code)',
                  padding: '10px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: '4px 0',
                  lineHeight: 1.5
                }}
              >
                {node.content}
              </pre>
            )
          case 'bullet':
            return (
              <div key={idx} style={{ display: 'flex', gap: 6, paddingLeft: 4 }}>
                <span style={{ flexShrink: 0, color: 'var(--text-gray)' }}>&bull;</span>
                <span>{renderInline(node.content)}</span>
              </div>
            )
          case 'numbered':
            return (
              <div key={idx} style={{ display: 'flex', gap: 6, paddingLeft: 4 }}>
                <span style={{ flexShrink: 0, color: 'var(--text-gray)', minWidth: 14, textAlign: 'right' }}>
                  {idx + 1}.
                </span>
                <span>{renderInline(node.content)}</span>
              </div>
            )
          case 'br':
            return <div key={idx} style={{ height: 6 }} />
          default:
            return <div key={idx}>{renderInline(node.content)}</div>
        }
      })}
    </div>
  )
}

function CollapsedChatRail({
  onTogglePanel,
  onHistoryOpen,
  onNewSession,
}: {
  onTogglePanel: () => void
  onHistoryOpen: () => void
  onNewSession: () => void
}) {
  return (
    <div
      className="flex h-full flex-col items-center"
      style={{
        width: WORKBENCH_EDGE_RAIL_SIZE,
        minWidth: WORKBENCH_EDGE_RAIL_SIZE,
        background: 'transparent',
      }}
    >
      <div
        className="flex w-full items-center justify-center"
        style={{
          height: WORKBENCH_TOPBAR_HEIGHT,
          borderBottom: '1px solid transparent',
        }}
      >
        <IconButton
          icon={<PanelLeftClose style={{ width: 15, height: 15 }} strokeWidth={2} />}
          onClick={onTogglePanel}
          title="展开聊天面板"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
      </div>

      <div className="flex flex-col items-center gap-2 pt-3">
        <IconButton
          icon={<History style={{ width: 14, height: 14 }} strokeWidth={2} />}
          onClick={onHistoryOpen}
          title="打开历史对话"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
        <IconButton
          icon={<Plus style={{ width: 14, height: 14 }} strokeWidth={2} />}
          onClick={onNewSession}
          title="新建对话"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model Selector (wired to useSettings store)
// ---------------------------------------------------------------------------

function ModelSelector() {
  const { config, loaded, loadConfig, getShortModelLabel, getShortProviderLabel } = useSettings()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!loaded) loadConfig()
  }, [loaded, loadConfig])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const hasKey = !!config.apiKey
  const label = config.displayName || getShortProviderLabel()

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center active:scale-[0.98] transition-all duration-200 ease-out"
        style={{
          padding: '3px 8px',
          borderRadius: 8,
          border: '1px solid transparent',
          background: 'transparent',
          gap: 4,
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: hasKey ? 'var(--color-green)' : 'var(--color-red)' }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>{label}</span>
        <ChevronDown
          style={{
            width: 10, height: 10,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms ease'
          }}
          className="text-[var(--text-light)]"
        />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 4,
            minWidth: 200,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-default)',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: 8,
            zIndex: 100
          }}
        >
          <div style={{ fontSize: 10, color: 'var(--text-light)', padding: '2px 8px', marginBottom: 4 }}>
            当前模型
          </div>
          <div
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              background: 'var(--bg-hover)',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>
              {getShortModelLabel()}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
              {config.baseUrl ? new URL(config.baseUrl).hostname : '未配置'}
            </div>
          </div>
          {!hasKey && (
            <div style={{ fontSize: 10, color: 'var(--color-red)', padding: '4px 8px', marginTop: 4 }}>
              未配置 API Key，请前往设置页配置
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Attachment icon helper
// ---------------------------------------------------------------------------

function AttachmentIcon({ attachment, size = 16 }: { attachment: ChatAttachment; size?: number }) {
  const style = { width: size, height: size }
  const cls = "text-[var(--text-gray)]"
  if (attachment.isDirectory) {
    return <Folder style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'browser-tab') {
    return <Globe style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'document-quote') {
    return <MessageSquareQuote style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'design-project') {
    return <Pen style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'skill-folder') {
    return <Puzzle style={style} className={cls} strokeWidth={2} />
  }
  switch (attachment.type) {
    case 'image': return <Image style={style} className={cls} strokeWidth={2} />
    case 'video': return <Film style={style} className={cls} strokeWidth={2} />
    case 'spreadsheet': return <Table style={style} className={cls} strokeWidth={2} />
    default: return <FileText style={style} className={cls} strokeWidth={2} />
  }
}

function getAttachmentPreviewSrc(attachment: ChatAttachment): string | null {
  if (attachment.type !== 'image') return null
  if (!attachment.path || !attachment.path.startsWith('/')) return null
  return `file://${encodeURI(attachment.path)}`
}

function formatDesignAttachmentSummary(attachment: ChatAttachment): string {
  return [
    '### 设计项目引用',
    `- 项目: ${attachment.name}`,
    attachment.path && attachment.path.startsWith('/') ? `- 文件: ${attachment.path}` : '- 文件: (未保存草稿)',
    attachment.dirty ? '- 状态: 有未保存更改' : attachment.saveStatus ? `- 状态: ${attachment.saveStatus}` : null,
    attachment.selectionSummary ? `- 选择状态: ${attachment.selectionSummary}` : null,
    attachment.currentToolContext ? `- 当前工具: ${attachment.currentToolContext}` : null,
    attachment.snapshotHash ? `- 快照哈希: ${attachment.snapshotHash}` : null,
  ].filter(Boolean).join('\n')
}

function formatDocumentQuoteAttachmentSummary(attachment: ChatAttachment): string {
  const lineLabel = attachment.lineStart && attachment.lineEnd
    ? attachment.lineStart === attachment.lineEnd
      ? `第 ${attachment.lineStart} 行`
      : `第 ${attachment.lineStart}-${attachment.lineEnd} 行`
    : null

  return [
    '### 文档引用',
    `- 文档: ${attachment.title || attachment.name}`,
    `- 路径: ${attachment.path}`,
    attachment.sectionTitle ? `- 章节: ${attachment.sectionTitle}` : null,
    lineLabel ? `- 位置: ${lineLabel}` : null,
    attachment.selection ? '' : null,
    attachment.selection ? '```quote' : null,
    attachment.selection || null,
    attachment.selection ? '```' : null,
  ].filter(Boolean).join('\n')
}

function formatDocumentWidgetTargetSummary(attachment: ChatAttachment): string {
  return [
    '### Widget 更新目标',
    `- 文档: ${attachment.documentTitle || '(未保存草稿)'}`,
    `- 目标 widget: ${attachment.widgetTitle || attachment.title || attachment.name}`,
    `- 路径: ${attachment.path}`,
    attachment.widgetMode ? `- 当前模式: ${attachment.widgetMode}` : null,
    '',
    '```show-widget',
    JSON.stringify({
      title: attachment.widgetTitle || attachment.title || attachment.name,
      widget_code: attachment.widgetCode || '',
    }),
    '```',
  ].filter(Boolean).join('\n')
}

function getDocumentQuoteTooltip(attachment: ChatAttachment): string {
  return [
    attachment.title || attachment.name,
    attachment.sectionTitle ? `章节: ${attachment.sectionTitle}` : null,
    attachment.lineStart && attachment.lineEnd
      ? attachment.lineStart === attachment.lineEnd
        ? `第 ${attachment.lineStart} 行`
        : `第 ${attachment.lineStart}-${attachment.lineEnd} 行`
      : null,
    attachment.selection ? attachment.selection.slice(0, 200) : null,
  ].filter(Boolean).join('\n')
}

function getAttachmentMetaSummary(attachment: ChatAttachment): string | null {
  if (attachment.isDirectory) {
    return '文件夹'
  }

  if (attachment.source === 'document-quote') {
    const lineLabel = attachment.lineStart && attachment.lineEnd
      ? attachment.lineStart === attachment.lineEnd
        ? `L${attachment.lineStart}`
        : `L${attachment.lineStart}-${attachment.lineEnd}`
      : null
    return [attachment.sectionTitle, lineLabel].filter(Boolean).join(' · ') || '文档引用'
  }

  if (attachment.source === 'skill-folder') {
    return attachment.skillId ? `skill · ${attachment.skillId}` : 'skill'
  }

  if (attachment.source === 'browser-tab') {
    return '网页引用'
  }

  if (attachment.source === 'document-widget-target') {
    return [
      attachment.widgetTitle || attachment.title || attachment.name,
      attachment.documentTitle ? `文档: ${attachment.documentTitle}` : null,
      attachment.widgetMode || 'widget 更新',
    ].filter(Boolean).join('\n')
  }

  return null
}

interface ConversationChannelOption {
  key: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  label: string
  caption: string
}

const IMAGE_ATTACHMENT_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff'])
const VIDEO_ATTACHMENT_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi'])
const TEXT_ATTACHMENT_EXTS = new Set(['txt', 'md', 'csv', 'pdf', 'json', 'html', 'docx', 'doc', 'rtf', 'odt'])
const SPREADSHEET_ATTACHMENT_EXTS = new Set(['xlsx', 'xls', 'tsv'])

function getAttachmentTypeFromExt(ext?: string, isDirectory = false): ChatAttachment['type'] {
  if (isDirectory) return 'other'
  const normalizedExt = String(ext || '').toLowerCase().replace(/^\./, '')
  if (IMAGE_ATTACHMENT_EXTS.has(normalizedExt)) return 'image'
  if (VIDEO_ATTACHMENT_EXTS.has(normalizedExt)) return 'video'
  if (TEXT_ATTACHMENT_EXTS.has(normalizedExt)) return 'text'
  if (SPREADSHEET_ATTACHMENT_EXTS.has(normalizedExt)) return 'spreadsheet'
  return 'other'
}

function getPathBasename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function createLocalPathAttachment(params: {
  name?: string
  path: string
  ext?: string
  size?: number
  isDirectory?: boolean
}): ChatAttachment {
  const isDirectory = Boolean(params.isDirectory)
  const normalizedExt = isDirectory
    ? ''
    : String(params.ext || getPathBasename(params.path).split('.').pop() || '')
      .toLowerCase()
      .replace(/^\./, '')

  return {
    id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: params.name || getPathBasename(params.path),
    path: params.path,
    type: getAttachmentTypeFromExt(normalizedExt, isDirectory),
    isDirectory,
    size: params.size || 0,
    ext: normalizedExt ? `.${normalizedExt}` : '',
    source: 'file',
  }
}

function formatFolderAttachmentSummary(attachment: ChatAttachment): string {
  return [
    '### 文件夹引用',
    `- 名称: ${attachment.name}`,
    `- 路径: ${attachment.path}`,
    '- 用途: 可让 agent 直接基于这个目录继续定位文件、生成结果或说明目标落点。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// ChatPanel Component
// ---------------------------------------------------------------------------

export default function ChatPanel() {
  const {
    agents,
    messages,
    currentAgent,
    currentScope,
    inputValue,
    isStreaming,
    streamingMessageId,
    selectAgent,
    setInputValue,
    sendMessage,
    stopStreaming,
    undoLastMessage,
    newSession,
    // W2
    scopes,
    loadScopes,
    loadConversation,
    deleteConversation,
    toolTrace,
    toolTraceStatus,
    // W3
    attachments,
    removeAttachment,
    pickFiles,
    addAttachments,
    // W4
    filePool,
    activeAttachmentPreview,
    setActiveAttachmentPreview,
    pendingSendCount,
    pendingSendFlushAt,
    loadSendPreferences,
  } = useAgent()

  const { chatPanelVisible, chatPanelWidth, toggleChatPanel } = useWorkspace()

  const [toolTraceExpanded, setToolTraceExpanded] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [selectedChannelKey, setSelectedChannelKey] = useState('local:app')
  const [pendingSendCountdown, setPendingSendCountdown] = useState(0)
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)

  const currentAgentData = agents.find(a => a.name === currentAgent)
  const getScopeChannelKey = useCallback((scope: ConversationScope) => {
    const sourceId = scope.sourceKind === 'local' ? 'app' : scope.sourceId
    return `${scope.sourceKind}:${sourceId}`
  }, [])
  const channelOptions = useMemo<ConversationChannelOption[]>(() => {
    const options = new Map<string, ConversationChannelOption>()
    options.set('local:app', {
      key: 'local:app',
      sourceKind: 'local',
      sourceId: 'app',
      label: '应用内',
      caption: '本地会话',
    })

    for (const scope of scopes) {
      const key = getScopeChannelKey(scope)
      if (options.has(key)) continue

      const channelType = String(scope.meta?.channelType || '')
      const sourceLabel = String(scope.meta?.sourceLabel || '')
      let label = sourceLabel || '远程会话'
      let caption = sourceLabel || '频道会话'

      if (channelType === 'feishu-app' || channelType === 'feishu-bot' || /飞书/.test(sourceLabel)) {
        label = '飞书会话'
        caption = sourceLabel || '飞书频道'
      } else if (channelType === 'telegram-bot' || /telegram/i.test(sourceLabel)) {
        label = 'Telegram'
        caption = sourceLabel || 'Telegram 频道'
      }

      options.set(key, {
        key,
        sourceKind: scope.sourceKind,
        sourceId: scope.sourceId,
        label,
        caption,
      })
    }

    return Array.from(options.values())
  }, [getScopeChannelKey, scopes])
  const currentChannel = useMemo<ConversationChannelOption>(() => {
    return channelOptions.find((option) => option.key === selectedChannelKey) || channelOptions[0] || {
      key: 'local:app',
      sourceKind: 'local',
      sourceId: 'app',
      label: '应用内',
      caption: '本地会话',
    }
  }, [channelOptions, selectedChannelKey])
  const filteredScopes = useMemo(() => {
    return scopes
      .filter((scope) => getScopeChannelKey(scope) === selectedChannelKey)
      .sort((a, b) => {
        const aTime = new Date(a.lastMessageAt || a.updatedAt).getTime()
        const bTime = new Date(b.lastMessageAt || b.updatedAt).getTime()
        return bTime - aTime
      })
  }, [getScopeChannelKey, scopes, selectedChannelKey])

  const showToolTraceCapsule = toolTrace.length > 0 || isStreaming || toolTraceStatus === 'error' || toolTraceStatus === 'cancelled'

  useEffect(() => {
    void loadSendPreferences()
  }, [loadSendPreferences])

  useEffect(() => {
    if (!pendingSendCount || !pendingSendFlushAt) {
      setPendingSendCountdown(0)
      return
    }
    const update = () => {
      setPendingSendCountdown(Math.max(0, pendingSendFlushAt - Date.now()))
    }
    update()
    const timer = window.setInterval(update, 100)
    return () => window.clearInterval(timer)
  }, [pendingSendCount, pendingSendFlushAt])

  const handleCopyAgentMessage = useCallback(async (messageId: string, content: string) => {
    if (!content?.trim()) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = content
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }

      setCopiedMessageId(messageId)
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
      copyFeedbackTimerRef.current = setTimeout(() => {
        setCopiedMessageId((current) => (current === messageId ? null : current))
        copyFeedbackTimerRef.current = null
      }, 1500)
    } catch {
      // Keep silent; copy failure shouldn't break chat interactions.
    }
  }, [])

  const handleAttachmentPreview = useCallback(async (attachment: ChatAttachment) => {
    if (!attachment.path) return
    if (attachment.source === 'document-quote') {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatDocumentQuoteAttachmentSummary(attachment),
      })
      return
    }
    if (attachment.source === 'document-widget-target') {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatDocumentWidgetTargetSummary(attachment),
      })
      return
    }
    if (attachment.source === 'design-project') {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatDesignAttachmentSummary(attachment),
      })
      return
    }
    if (attachment.isDirectory) {
      setActiveAttachmentPreview({
        attachment,
        mode: 'text',
        content: formatFolderAttachmentSummary(attachment),
      })
      return
    }
    if (attachment.type === 'image') {
      setActiveAttachmentPreview({ attachment, mode: 'image' })
      return
    }
    if (attachment.type === 'video') {
      setActiveAttachmentPreview({ attachment, mode: 'video' })
      return
    }
    if (attachment.type === 'text') {
      setAttachmentPreviewLoading(true)
      try {
        const result = await window.electronAPI.chat.readFileForAI(attachment.path)
        if (result.success && result.data?.type === 'text') {
          setActiveAttachmentPreview({
            attachment,
            mode: 'text',
            content: result.data.content || '',
          })
        } else {
          setActiveAttachmentPreview({
            attachment,
            mode: 'file',
            error: result.error || '无法读取附件内容',
          })
        }
      } finally {
        setAttachmentPreviewLoading(false)
      }
      return
    }
    setActiveAttachmentPreview({ attachment, mode: 'file' })
  }, [setActiveAttachmentPreview])

  const handleOpenAttachment = useCallback(async (attachment: ChatAttachment) => {
    if (attachment.source === 'document-quote') {
      revealDocumentQuoteAttachment(attachment)
      return
    }
    if (!attachment.path || !attachment.path.startsWith('/')) return
    await window.electronAPI.document.openPath(attachment.path).catch(() => undefined)
  }, [])

  const handleRevealAttachment = useCallback(async (attachment: ChatAttachment) => {
    if (!attachment.path || !attachment.path.startsWith('/')) return
    await window.electronAPI.document.showInFolder(attachment.path).catch(() => undefined)
  }, [])

  // Initialize agent stream listeners (once)
  useEffect(() => {
    const cleanup = initAgentListeners()
    return cleanup
  }, [])

  useEffect(() => {
    void loadScopes().then(() => {
      if (useAgent.getState().scopes.length === 0) {
        useAgent.getState().newSession()
      }
    })
  }, [currentAgent, loadScopes])

  useEffect(() => {
    if (!currentScope) return
    setSelectedChannelKey(getScopeChannelKey(currentScope))
  }, [currentScope, getScopeChannelKey])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    }
  }, [])

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if (sendingRef.current) return
    const content = inputValue.trim()
    if (!content && attachments.length === 0) return
    sendingRef.current = true
    setInputValue('')
    chatInputRef.current?.resetHeight()
    try {
      await sendMessage(content)
    } finally {
      sendingRef.current = false
    }
  }, [attachments.length, inputValue, setInputValue, sendMessage])

  const handleAgentSelect = useCallback((name: string) => {
    if (currentScope?.sourceKind === 'channel') return
    selectAgent(name)
    void loadScopes()
  }, [currentScope?.sourceKind, loadScopes, selectAgent])

  const handleNewSession = useCallback(() => {
    newSession()
  }, [newSession])

  const handleLoadConversation = useCallback((convId: string) => {
    loadConversation(convId)
  }, [loadConversation])

  const handleChannelSelect = useCallback((channel: ConversationChannelOption) => {
    setSelectedChannelKey(channel.key)

    const latestScope = scopes
      .filter((scope) => getScopeChannelKey(scope) === channel.key)
      .sort((a, b) => {
        const aTime = new Date(a.lastMessageAt || a.updatedAt).getTime()
        const bTime = new Date(b.lastMessageAt || b.updatedAt).getTime()
        return bTime - aTime
      })[0]

    if (latestScope) {
      loadConversation(latestScope.id)
      return
    }

    if (channel.sourceKind === 'local') {
      newSession()
    }
  }, [getScopeChannelKey, loadConversation, newSession, scopes])

  const handleDeleteConversation = useCallback((convId: string) => {
    deleteConversation(convId)
  }, [deleteConversation])

  // W3: Drag & drop support (app-internal + OS files)
  const [isDragOver, setIsDragOver] = useState(false)

  const focusInputWithResize = useCallback(() => {
    chatInputRef.current?.focusWithResize()
  }, [])

  useEffect(() => {
    const handler = () => {
      focusInputWithResize()
    }
    window.addEventListener(READY_FOCUS_CHAT_INPUT_EVENT, handler as EventListener)
    return () => window.removeEventListener(READY_FOCUS_CHAT_INPUT_EVENT, handler as EventListener)
  }, [focusInputWithResize])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    // 1. Check for app-internal ready-drag data first
    const readyRaw = e.dataTransfer.getData('application/x-ready-drag')
    if (readyRaw) {
      try {
        const data = JSON.parse(readyRaw) as {
          type:
            | 'file'
            | 'folder'
            | 'browser-tab'
            | 'doc-tab'
            | 'design-project'
            | 'video-project'
            | 'calendar-event'
            | 'skill-folder'
          path?: string
          name: string
          url?: string
          tabId?: string
          ext?: string
          size?: number
          title?: string
          heading?: string
          selection?: string
          excerpt?: string
          eventId?: string
          startTime?: string
          endTime?: string
          calendarId?: string
          description?: string
          projectId?: string
          duration?: number
          videoClipCount?: number
          subtitleClipCount?: number
          audioClipCount?: number
          dirty?: boolean
          saveStatus?: string
          snapshotHash?: string
          selectionSummary?: string
          currentToolContext?: string
          layoutDigest?: unknown
          source?: 'system' | 'imported'
          skillId?: string
          defaultCommand?: string
        }

        if (data.type === 'skill-folder' && data.path) {
          const inferredSkillId = data.skillId

          addAttachments([{
            id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: data.name,
            path: data.path,
            type: 'text',
            size: 0,
            ext: '.skill',
            source: 'skill-folder',
            skillId: inferredSkillId,
            skillFolderPath: data.path,
          }])

          const command = data.defaultCommand || (inferredSkillId ? `/skill ${inferredSkillId}` : '')
          const currentInput = useAgent.getState().inputValue.trim()
          if (command) {
            setInputValue(currentInput ? `${currentInput}\n${command}` : command)
          } else {
            const snippet = `### 技能目录引用\n- 名称: ${data.name}\n- 路径: ${data.path}`
            setInputValue(currentInput ? `${currentInput}\n${snippet}` : snippet)
          }
          focusInputWithResize()
        } else if (data.type === 'browser-tab' && data.url) {
          void (async () => {
            const fallbackTitle = data.title || data.name || '网页标签'
            let snapshot = {
              title: fallbackTitle,
              url: data.url,
              heading: data.heading || '',
              selection: data.selection || '',
              excerpt: data.excerpt || '',
              capturedAt: Date.now(),
            }
            try {
              if (window.electronAPI?.browser?.getTabContext && data.tabId) {
                const ctx = await window.electronAPI.browser.getTabContext(data.tabId)
                if (ctx.success && ctx.data) {
                  snapshot = {
                    title: ctx.data.title || snapshot.title,
                    url: ctx.data.url || snapshot.url,
                    heading: ctx.data.heading || snapshot.heading,
                    selection: ctx.data.selection || snapshot.selection,
                    excerpt: ctx.data.excerpt || snapshot.excerpt,
                    capturedAt: ctx.data.capturedAt || snapshot.capturedAt,
                  }
                }
              }
            } catch {
              // keep fallback snapshot
            }

            const fallbackPath = data.tabId ? `browser-tab://${data.tabId}` : `browser-tab://${Date.now()}`
            addAttachments([{
              id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: snapshot.title || fallbackTitle,
              path: snapshot.url || fallbackPath,
              type: 'text',
              size: snapshot.excerpt.length,
              ext: '.url',
              source: 'browser-tab',
              browserTabId: data.tabId,
              url: snapshot.url || data.url,
              title: snapshot.title || fallbackTitle,
              heading: snapshot.heading,
              selection: snapshot.selection,
              excerpt: snapshot.excerpt,
              capturedAt: snapshot.capturedAt,
            }])
            focusInputWithResize()
          })()
        } else if (data.type === 'design-project') {
          const designData = data as typeof data & {
            selectedElementCount?: number
            selectionBounds?: { x: number; y: number; w: number; h: number }
            latestReviewSummary?: string
            repairScope?: string
          }
          const fallbackPath = data.path && data.path.startsWith('/')
            ? data.path
            : `design-project://${encodeURIComponent(data.name || 'draft')}#${encodeURIComponent(String(data.snapshotHash || Date.now()))}`
          addAttachments([{
            id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: data.name || '设计草稿',
            path: fallbackPath,
            type: 'text',
            size: 0,
            ext: '.tldr',
            source: 'design-project',
            dirty: typeof data.dirty === 'boolean' ? data.dirty : undefined,
            saveStatus: typeof data.saveStatus === 'string' ? data.saveStatus : undefined,
            snapshotHash: typeof data.snapshotHash === 'string' ? data.snapshotHash : undefined,
            selectionSummary: typeof data.selectionSummary === 'string' ? data.selectionSummary : undefined,
            selectedElementCount: typeof designData.selectedElementCount === 'number' ? designData.selectedElementCount : undefined,
            selectionBounds: designData.selectionBounds && typeof designData.selectionBounds === 'object'
              ? designData.selectionBounds as { x: number; y: number; w: number; h: number }
              : undefined,
            currentToolContext: typeof data.currentToolContext === 'string' ? data.currentToolContext : undefined,
            latestReviewSummary: typeof designData.latestReviewSummary === 'string' ? designData.latestReviewSummary : undefined,
            repairScope: designData.repairScope === 'run-owned' || designData.repairScope === 'selected'
              ? designData.repairScope
              : undefined,
          }])
          focusInputWithResize()
        } else if (data.type === 'video-project') {
          const lines = [
            '### 剪辑项目引用',
            `- 项目: ${data.name}`,
            data.path ? `- 关联文件: ${data.path}` : null,
            typeof data.duration === 'number' ? `- 时长: ${data.duration.toFixed(1)} 秒` : null,
            typeof data.videoClipCount === 'number' ? `- 视频轨片段: ${data.videoClipCount}` : null,
            typeof data.subtitleClipCount === 'number' ? `- 字幕轨片段: ${data.subtitleClipCount}` : null,
            typeof data.audioClipCount === 'number' ? `- 音频轨片段: ${data.audioClipCount}` : null,
          ].filter(Boolean)
          const currentInput = useAgent.getState().inputValue
          const snippet = lines.join('\n')
          setInputValue(currentInput ? `${currentInput}\n${snippet}` : snippet)
          focusInputWithResize()
        } else if (data.type === 'calendar-event') {
          const start = data.startTime ? new Date(data.startTime) : null
          const end = data.endTime ? new Date(data.endTime) : null
          const hasValidTime =
            !!start &&
            !!end &&
            !Number.isNaN(start.getTime()) &&
            !Number.isNaN(end.getTime())
          const lines = [
            '### 日程事件引用',
            `- 标题: ${data.title || data.name}`,
            hasValidTime
              ? `- 时间: ${start.toLocaleString()} - ${end.toLocaleString()}`
              : null,
            data.calendarId ? `- 日历: ${data.calendarId}` : null,
            data.description ? `- 备注: ${data.description.slice(0, 600)}` : null,
          ].filter(Boolean)
          const currentInput = useAgent.getState().inputValue
          const snippet = lines.join('\n')
          setInputValue(currentInput ? `${currentInput}\n${snippet}` : snippet)
          focusInputWithResize()
        } else if ((data.type === 'file' || data.type === 'doc-tab' || data.type === 'folder') && data.path) {
          addAttachments([createLocalPathAttachment({
            name: data.name,
            path: data.path,
            ext: data.ext,
            size: data.size,
            isDirectory: data.type === 'folder',
          })])
          focusInputWithResize()
        }
      } catch { /* ignore malformed data */ }
      return
    }

    // 2. Fallback: OS file drop
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    const newAttachments = await Promise.all(files.map(async (file) => {
      const path = (typeof window !== 'undefined' && window.electronAPI)
        ? window.electronAPI.getFilePathFromDrop(file)
        : file.name
      if (!path) return null

      let isDirectory = false
      if (window.electronAPI?.document?.stat) {
        const statResult = await window.electronAPI.document.stat(path).catch(() => null)
        isDirectory = statResult?.data?.isDirectory ?? statResult?.stat?.isDirectory ?? false
      }

      return createLocalPathAttachment({
        name: file.name || getPathBasename(path),
        path,
        ext: file.name.split('.').pop(),
        size: file.size,
        isDirectory,
      })
    }))
    addAttachments(newAttachments.filter(Boolean) as ChatAttachment[])
    focusInputWithResize()
  }, [addAttachments, focusInputWithResize, setInputValue])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const composerShellStyle = {
    ...LIQUID_INACTIVE_CHROME_STYLE,
    borderRadius: 10,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.05) 100%)',
    border: isDragOver ? '2px solid var(--color-blue)' : '1px solid transparent',
    boxShadow: isDragOver
      ? '0 0 0 1px color-mix(in srgb, var(--color-blue) 18%, transparent), inset 0 1px 0 rgba(255,255,255,0.06)'
      : 'inset 0 0 0 1px color-mix(in srgb, var(--border-input) 72%, transparent), inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -10px 18px rgba(91, 141, 239, 0.12)',
  } as const

  // Format time for history panel
  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins}分钟前`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}小时前`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 7) return `${diffDays}天前`
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
    <div
      data-chat-panel-root="true"
      data-liquid-shell="chat-panel"
      className="workbench-panel-frame flex-shrink-0 flex flex-col overflow-hidden"
      style={{
        width: chatPanelVisible ? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE,
        minWidth: chatPanelVisible ? chatPanelWidth : WORKBENCH_EDGE_RAIL_SIZE,
        background: 'transparent',
        boxShadow: 'none',
        border: chatPanelVisible
          ? '1px solid transparent'
          : '1px solid color-mix(in srgb, var(--border-default) 72%, transparent)',
        transition: 'width 300ms ease-in-out, min-width 300ms ease-in-out',
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {chatPanelVisible ? (
        <>
          <ChatHeader
            currentChannel={currentChannel}
            channelOptions={channelOptions}
            filteredScopes={filteredScopes}
            onChannelSelect={handleChannelSelect}
            onTogglePanel={toggleChatPanel}
            onNewSession={handleNewSession}
            onLoadConversation={handleLoadConversation}
            onDeleteConversation={handleDeleteConversation}
            onHistoryOpen={() => { void loadScopes() }}
            formatTime={formatTime}
          />

          <ChatMessages
            messages={messages}
            isStreaming={isStreaming}
            streamingMessageId={streamingMessageId}
            toolTrace={toolTrace}
            toolTraceStatus={toolTraceStatus}
            toolTraceExpanded={toolTraceExpanded}
            copiedMessageId={copiedMessageId}
            showToolTraceCapsule={showToolTraceCapsule}
            onSetInputSuggestion={setInputValue}
            onToggleToolTrace={() => setToolTraceExpanded((value) => !value)}
            onCopyMessage={handleCopyAgentMessage}
            onAttachmentPreview={handleAttachmentPreview}
            onRevealDocumentQuote={revealDocumentQuoteAttachment}
            getDocumentQuoteTooltip={getDocumentQuoteTooltip}
            getAttachmentMetaSummary={getAttachmentMetaSummary}
            getAttachmentPreviewSrc={getAttachmentPreviewSrc}
            renderAttachmentIcon={(attachment, size = 16) => <AttachmentIcon attachment={attachment} size={size} />}
            renderMarkdown={(content) => <MarkdownContent content={content} />}
          />

          <div
            style={{
              padding: '10px 0 0',
              borderTop: '1px solid transparent',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'transparent',
              backdropFilter: 'none',
              WebkitBackdropFilter: 'none',
              boxShadow: 'none',
            }}
          >
            <ChatAttachments
              attachments={attachments}
              onRemove={removeAttachment}
              onPreview={handleAttachmentPreview}
              onRevealDocumentQuote={revealDocumentQuoteAttachment}
              getDocumentQuoteTooltip={getDocumentQuoteTooltip}
              getAttachmentMetaSummary={getAttachmentMetaSummary}
              renderAttachmentIcon={(attachment, size = 16) => <AttachmentIcon attachment={attachment} size={size} />}
              toLocalFileUrl={toLocalFileUrl}
            />

            <ChatInput
              ref={chatInputRef}
              inputValue={inputValue}
              isStreaming={isStreaming}
              attachmentsCount={attachments.length}
              hasUserMessages={messages.some((m) => m.type === 'user')}
              pendingSendCount={pendingSendCount}
              pendingSendCountdown={pendingSendCountdown}
              isDragOver={isDragOver}
              composerShellStyle={composerShellStyle}
              filePool={filePool}
              filePoolCount={filePool.length}
              currentAgent={currentAgent}
              currentAgentAvatar={currentAgentData?.avatar || '🤖'}
              currentAgentDisplayName={currentAgentData?.displayName || '管家'}
              agents={agents}
              isChannelScope={currentScope?.sourceKind === 'channel'}
              onInputChange={setInputValue}
              onSend={() => { void handleSend() }}
              onStop={stopStreaming}
              onUndo={undoLastMessage}
              onPickFiles={pickFiles}
              onAgentSelect={handleAgentSelect}
              renderAttachmentIcon={(attachment, size = 16) => <AttachmentIcon attachment={attachment} size={size} />}
              ModelSelector={ModelSelector}
            />
          </div>
        </>
      ) : (
        <CollapsedChatRail
          onTogglePanel={toggleChatPanel}
          onHistoryOpen={() => {
            void loadScopes()
            toggleChatPanel()
          }}
          onNewSession={() => {
            handleNewSession()
            toggleChatPanel()
          }}
        />
      )}

      {activeAttachmentPreview && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(10, 14, 22, 0.42)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: 40,
          }}
          onClick={() => setActiveAttachmentPreview(null)}
        >
          <div
            className="glass-surface-floating"
            style={{
              width: 'min(760px, 100%)',
              maxHeight: '82%',
              overflow: 'hidden',
              borderRadius: 16,
              border: '1px solid var(--border-default)',
              background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
              display: 'flex',
              flexDirection: 'column',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '14px 16px',
                borderBottom: '1px solid var(--border-default)',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
                  {activeAttachmentPreview.attachment.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-gray)', marginTop: 2 }}>
                  {activeAttachmentPreview.attachment.path}
                </div>
              </div>
              <div className="flex items-center" style={{ gap: 8 }}>
                <button
                  type="button"
                  onClick={() => { void handleRevealAttachment(activeAttachmentPreview.attachment) }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid var(--border-default)',
                    fontSize: 12,
                    color: 'var(--text-body)',
                  }}
                >
                  在 Finder 中显示
                </button>
                <button
                  type="button"
                  onClick={() => { void handleOpenAttachment(activeAttachmentPreview.attachment) }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: '1px solid var(--border-default)',
                    fontSize: 12,
                    color: 'var(--text-body)',
                  }}
                >
                  系统打开
                </button>
                <button
                  type="button"
                  onClick={() => setActiveAttachmentPreview(null)}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    border: '1px solid var(--border-default)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <X style={{ width: 14, height: 14 }} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div style={{ padding: 16, overflow: 'auto' }}>
              {attachmentPreviewLoading && (
                <div style={{ fontSize: 12, color: 'var(--text-gray)' }}>正在读取附件内容…</div>
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'image' && (
                <img
                  src={toLocalFileUrl(activeAttachmentPreview.attachment.path)}
                  alt={activeAttachmentPreview.attachment.name}
                  style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: 12 }}
                />
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'video' && (
                <video
                  src={toLocalFileUrl(activeAttachmentPreview.attachment.path)}
                  controls
                  style={{ width: '100%', maxHeight: '70vh', borderRadius: 12, background: '#000' }}
                />
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'text' && (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: 'var(--text-body)',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 12,
                    padding: 14,
                  }}
                >
                  {activeAttachmentPreview.content || '(空文本附件)'}
                </pre>
              )}

              {!attachmentPreviewLoading && activeAttachmentPreview.mode === 'file' && (
                <div
                  style={{
                    borderRadius: 12,
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-secondary)',
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--text-body)' }}>
                    该附件暂不支持内嵌预览。
                  </div>
                  {activeAttachmentPreview.error && (
                    <div style={{ fontSize: 12, color: 'var(--color-red)' }}>
                      {activeAttachmentPreview.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
