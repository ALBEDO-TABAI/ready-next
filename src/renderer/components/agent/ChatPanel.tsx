import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { History, Minus, AtSign, Plus, Send, ChevronDown, Maximize2, RotateCcw, Square, Undo2, X, FileText, Image, Film, Table, Globe, Puzzle, ChevronRight, Wrench, CheckCircle2, CircleDashed, Copy, Check } from 'lucide-react'
import { useAgent, initAgentListeners, ChatAttachment, AgentMessage, ConversationScope, ToolTraceEvent } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import { useSettings } from '../../stores/useSettings'
import { toLocalFileUrl } from '../../utils/dragDrop'

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
  const label = getShortProviderLabel()

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center active:scale-[0.98] transition-all duration-200 ease-out"
        style={{ padding: '3px 8px', borderRadius: 8, border: '1px solid var(--border-input)', gap: 4 }}
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
  if (attachment.source === 'browser-tab') {
    return <Globe style={style} className={cls} strokeWidth={2} />
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

interface ConversationChannelOption {
  key: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  label: string
  caption: string
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

  const { chatPanelVisible, chatPanelWidth } = useWorkspace()

  const [showAgentSelect, setShowAgentSelect] = useState(false)
  const [showScopeSelect, setShowScopeSelect] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showAtMenu, setShowAtMenu] = useState(false)
  const [atFilter, setAtFilter] = useState('')
  const [toolTraceExpanded, setToolTraceExpanded] = useState(false)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [selectedChannelKey, setSelectedChannelKey] = useState('local:app')
  const [pendingSendCountdown, setPendingSendCountdown] = useState(0)
  const [attachmentPreviewLoading, setAttachmentPreviewLoading] = useState(false)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const scopeRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const atMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  const latestToolEvent = useMemo<ToolTraceEvent | null>(() => {
    return toolTrace.length > 0 ? toolTrace[toolTrace.length - 1] : null
  }, [toolTrace])
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
    if (!attachment.path) return
    await window.electronAPI.document.openPath(attachment.path).catch(() => undefined)
  }, [])

  const handleRevealAttachment = useCallback(async (attachment: ChatAttachment) => {
    if (!attachment.path) return
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

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    }
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showAgentSelect) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAgentSelect(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showAgentSelect])

  useEffect(() => {
    if (!showScopeSelect) return
    const handleClick = (e: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) {
        setShowScopeSelect(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showScopeSelect])

  // Close history dropdown on outside click
  useEffect(() => {
    if (!showHistory) return
    const handleClick = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showHistory])

  // Close @ menu on outside click
  useEffect(() => {
    if (!showAtMenu) return
    const handleClick = (e: MouseEvent) => {
      if (atMenuRef.current && !atMenuRef.current.contains(e.target as Node)) {
        setShowAtMenu(false)
        setAtFilter('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showAtMenu])

  const sendingRef = useRef(false)
  const handleSend = useCallback(async () => {
    if (sendingRef.current) return
    const content = inputValue.trim()
    if (!content && attachments.length === 0) return
    sendingRef.current = true
    setInputValue('')
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    try {
      await sendMessage(content)
    } finally {
      sendingRef.current = false
    }
  }, [attachments.length, inputValue, setInputValue, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleAgentSelect = useCallback((name: string) => {
    if (currentScope?.sourceKind === 'channel') {
      setShowAgentSelect(false)
      return
    }
    selectAgent(name)
    void loadScopes()
    setShowAgentSelect(false)
  }, [currentScope?.sourceKind, loadScopes, selectAgent])

  const handleNewSession = useCallback(() => {
    newSession()
  }, [newSession])

  // W2: History button
  const handleHistoryToggle = useCallback(() => {
    if (!showHistory) {
      loadScopes()
    }
    setShowHistory(!showHistory)
  }, [showHistory, loadScopes])

  const handleLoadConversation = useCallback((convId: string) => {
    loadConversation(convId)
    setShowHistory(false)
  }, [loadConversation])

  const handleChannelSelect = useCallback((channel: ConversationChannelOption) => {
    setSelectedChannelKey(channel.key)
    setShowScopeSelect(false)

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

  const handleDeleteConversation = useCallback((e: React.MouseEvent, convId: string) => {
    e.stopPropagation()
    deleteConversation(convId)
  }, [deleteConversation])

  // W3: Drag & drop support (app-internal + OS files)
  const [isDragOver, setIsDragOver] = useState(false)

  const focusInputWithResize = useCallback(() => {
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
        textareaRef.current.focus()
      }
    }, 0)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
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
          const lines = [
            '### 设计项目引用',
            `- 项目: ${data.name}`,
            data.path ? `- 文件: ${data.path}` : '- 文件: (未保存草稿)',
            data.dirty ? '- 状态: 有未保存更改' : data.saveStatus ? `- 状态: ${data.saveStatus}` : null,
          ].filter(Boolean)
          const currentInput = useAgent.getState().inputValue
          const snippet = lines.join('\n')
          setInputValue(currentInput ? `${currentInput}\n${snippet}` : snippet)
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
        } else if ((data.type === 'file' || data.type === 'doc-tab') && data.path) {
          // Add as chat attachment
          const normalizedExt = (data.ext || data.name.split('.').pop() || '')
            .toLowerCase()
            .replace(/^\./, '')
          const ext = normalizedExt ? `.${normalizedExt}` : ''
          const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff']
          const videoExts = ['mp4', 'mov', 'mkv', 'webm', 'avi']
          const textExts = ['txt', 'md', 'csv', 'pdf', 'json', 'html', 'docx', 'doc', 'rtf', 'odt']
          const spreadExts = ['xlsx', 'xls', 'tsv']
          let type: ChatAttachment['type'] = 'other'
          if (imageExts.includes(normalizedExt)) type = 'image'
          else if (videoExts.includes(normalizedExt)) type = 'video'
          else if (textExts.includes(normalizedExt)) type = 'text'
          else if (spreadExts.includes(normalizedExt)) type = 'spreadsheet'

          addAttachments([{
            id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: data.name,
            path: data.path,
            type,
            size: data.size || 0,
            ext,
          }])
        }
      } catch { /* ignore malformed data */ }
      return
    }

    // 2. Fallback: OS file drop
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    const newAttachments: ChatAttachment[] = files.map(file => {
      const path = (typeof window !== 'undefined' && window.electronAPI)
        ? window.electronAPI.getFilePathFromDrop(file)
        : file.name
      const normalizedExt = (file.name.split('.').pop() || '').toLowerCase()
      const ext = normalizedExt ? `.${normalizedExt}` : ''
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff']
      const videoExts = ['mp4', 'mov', 'mkv', 'webm', 'avi']
      const textExts = ['txt', 'md', 'csv', 'pdf', 'json', 'html', 'docx', 'doc', 'rtf', 'odt']
      const spreadExts = ['xlsx', 'xls', 'tsv']
      let type: ChatAttachment['type'] = 'other'
      if (imageExts.includes(normalizedExt)) type = 'image'
      else if (videoExts.includes(normalizedExt)) type = 'video'
      else if (textExts.includes(normalizedExt)) type = 'text'
      else if (spreadExts.includes(normalizedExt)) type = 'spreadsheet'

      return {
        id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        path,
        type,
        size: file.size,
        ext
      }
    })
    addAttachments(newAttachments)
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

  // W4: Handle input change with @ detection
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInputValue(value)

    // Auto-resize textarea
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'

    // Detect @ character
    const cursorPos = textarea.selectionStart
    const textBeforeCursor = value.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/)

    if (atMatch && filePool.length > 0) {
      setAtFilter(atMatch[1])
      setShowAtMenu(true)
    } else {
      setShowAtMenu(false)
      setAtFilter('')
    }
  }, [setInputValue, filePool])

  // W4: Insert @ reference
  const handleAtSelect = useCallback((file: ChatAttachment) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPos = textarea.selectionStart
    const textBeforeCursor = inputValue.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/)

    if (atMatch) {
      const beforeAt = textBeforeCursor.slice(0, atMatch.index)
      const afterCursor = inputValue.slice(cursorPos)
      const insertion = `@[${file.name}]`
      const newValue = beforeAt + insertion + afterCursor
      setInputValue(newValue)

      // Set cursor after the insertion
      setTimeout(() => {
        const newPos = (beforeAt + insertion).length
        textarea.setSelectionRange(newPos, newPos)
        textarea.focus()
      }, 0)
    }

    setShowAtMenu(false)
    setAtFilter('')
  }, [inputValue, setInputValue])

  // W4: @ button click
  const handleAtButtonClick = useCallback(() => {
    if (filePool.length === 0) return
    setAtFilter('')
    setShowAtMenu(!showAtMenu)
  }, [filePool, showAtMenu])

  // Filtered file pool for @ menu
  const filteredFilePool = useMemo(() => {
    if (!atFilter) return filePool
    return filePool.filter(f => f.name.toLowerCase().includes(atFilter.toLowerCase()))
  }, [filePool, atFilter])

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
      className="content-surface-panel flex-shrink-0 flex flex-col overflow-hidden"
      style={{
        width: chatPanelVisible ? chatPanelWidth : 0,
        minWidth: chatPanelVisible ? chatPanelWidth : 0,
        background: 'var(--surface-panel-bg)',
        borderLeft: chatPanelVisible ? '1px solid var(--border-default)' : 'none',
        transition: 'width 300ms ease-in-out, min-width 300ms ease-in-out',
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* Header -- chatHead: 38px height, 13px/600 title */}
      <div
        className="glass-surface-panel flex items-center justify-between"
        style={{ height: 38, padding: '0 14px', borderBottom: '1px solid var(--border-default)', background: 'var(--surface-toolbar-bg)' }}
      >
        <div className="relative" ref={scopeRef}>
          <button
            onClick={() => setShowScopeSelect(!showScopeSelect)}
            className="flex items-center active:scale-[0.98] transition-all duration-200 ease-out"
            style={{ gap: 6, padding: '6px 10px', borderRadius: 10, border: '1px solid var(--border-input)', maxWidth: 200 }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-title)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentChannel.label}
            </span>
            <ChevronDown
              style={{
                width: 12,
                height: 12,
                flexShrink: 0,
                transform: showScopeSelect ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 200ms ease',
                color: 'var(--text-light)',
              }}
            />
          </button>

          {showScopeSelect && (
            <div
              className="glass-surface-floating"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                width: 300,
                maxHeight: 340,
                overflowY: 'auto',
                background: 'var(--surface-floating-bg)',
                border: '1px solid var(--border-default)',
                borderRadius: 10,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                padding: 6,
                zIndex: 220,
              }}
            >
              {channelOptions.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-gray)', padding: '12px 10px' }}>暂无频道</div>
              ) : (
                channelOptions.map((channel) => (
                  <button
                    key={channel.key}
                    onClick={() => handleChannelSelect(channel)}
                    className="w-full flex items-center gap-2 hover:bg-black/5 active:scale-[0.98] transition-all duration-150"
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      border: 'none',
                      background: currentChannel.key === channel.key ? 'var(--bg-hover)' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      marginBottom: 4,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {channel.label}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
                        {channel.caption}
                      </div>
                    </div>
                    {currentChannel.key === channel.key && (
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-blue)' }} />
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <div className="flex items-center" style={{ gap: 6 }}>
          <button
            onClick={handleNewSession}
            title="新建对话"
            className="p-1 rounded hover:bg-black/5 active:scale-[0.98] transition-all duration-200 ease-out"
            style={{ color: 'var(--text-light)' }}
          >
            <RotateCcw style={{ width: 14, height: 14 }} strokeWidth={2} />
          </button>

          {/* W2: History Button with Dropdown */}
          <div className="relative" ref={historyRef}>
            <button
              onClick={handleHistoryToggle}
              title="历史对话"
              className="p-1 rounded hover:bg-black/5 active:scale-[0.98] transition-all duration-200 ease-out"
              style={{ color: showHistory ? 'var(--color-blue)' : 'var(--text-light)' }}
            >
              <History style={{ width: 14, height: 14 }} strokeWidth={2} />
            </button>

            {showHistory && (
              <div
                className="glass-surface-floating"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 4,
                  width: 260,
                  maxHeight: 320,
                  overflowY: 'auto',
                  background: 'var(--surface-floating-bg)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 8,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                  padding: 4,
                  zIndex: 200
                }}
              >
                <div style={{ fontSize: 10, color: 'var(--text-light)', padding: '4px 8px', marginBottom: 2 }}>
                  {currentChannel.label}历史
                </div>
                {filteredScopes.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-gray)', padding: '12px 8px', textAlign: 'center' }}>
                    当前频道暂无会话历史
                  </div>
                ) : (
                  filteredScopes.map(conv => (
                    <button
                      key={conv.id}
                      onClick={() => handleLoadConversation(conv.id)}
                      className="w-full flex items-center gap-2 hover:bg-black/5 active:scale-[0.98] transition-all duration-150 group"
                      style={{
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 12, fontWeight: 500, color: 'var(--text-body)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                        }}>
                          {conv.title || '新对话'}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2, display: 'flex', gap: 6 }}>
                          <span>{conv.agent}</span>
                          <span>{formatTime(conv.updatedAt)}</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => handleDeleteConversation(e, conv.id)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-black/10 transition-opacity"
                        title="删除对话"
                      >
                        <X style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                      </button>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <button className="p-1 rounded active:scale-[0.98] transition-all duration-200 ease-out" style={{ color: 'var(--text-light)' }}>
            <Minus style={{ width: 14, height: 14 }} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* ChatMessages */}
      <div
        className="flex-1 overflow-auto"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {/* Welcome Card */}
        <div
          className="flex flex-col items-center"
          style={{ gap: 16, padding: '50px 16px' }}
        >
          {/* Avatar */}
          <div
            className="flex items-center justify-center"
            style={{
              width: 40, height: 40,
              borderRadius: 10,
              background: 'var(--bg-avatar)'
            }}
          >
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-title)' }}>R</span>
          </div>

          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-body)' }}>Ready AI Assistant</span>

          <span
            style={{
              fontSize: 13, fontWeight: 500, color: 'var(--text-gray)',
              textAlign: 'center', lineHeight: '1.5'
            }}
          >
            你的智能工作区助手。随时提问、创作内容、分析数据。
          </span>

          {/* Quick Action Cards */}
          <div className="flex w-full" style={{ gap: 8 }}>
            <button
              onClick={() => setInputValue('帮我分析最近的热门视频趋势')}
              className="flex-1 text-left hover:border-[var(--color-blue)] transition-all duration-200 ease-out active:scale-[0.98]"
              style={{
                padding: 12, borderRadius: 8,
                border: '1px solid var(--border-default)',
                display: 'flex', flexDirection: 'column', gap: 4
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>内容优化</span>
              <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>分析热门数据...</span>
            </button>
            <button
              onClick={() => setInputValue('帮我写一篇关于 AI 创作的文案')}
              className="flex-1 text-left hover:border-[var(--color-blue)] transition-all duration-200 ease-out active:scale-[0.98]"
              style={{
                padding: 12, borderRadius: 8,
                border: '1px solid var(--border-default)',
                display: 'flex', flexDirection: 'column', gap: 4
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>写作文案</span>
              <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>创作优质内容...</span>
            </button>
          </div>
        </div>

        {showToolTraceCapsule && (
          <div className="flex">
            <div
              className="max-w-[92%] w-full"
              style={{
                borderRadius: 12,
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card-bg)',
                overflow: 'hidden',
              }}
            >
              <button
                type="button"
                onClick={() => setToolTraceExpanded((value) => !value)}
                className="w-full text-left"
                style={{
                  padding: '8px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'transparent',
                }}
              >
                <div
                  className="flex items-center justify-center"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--color-blue) 12%, transparent)',
                    color: 'var(--color-blue)',
                    flexShrink: 0,
                  }}
                >
                  {toolTraceStatus === 'running'
                    ? <CircleDashed style={{ width: 12, height: 12 }} className="animate-spin" strokeWidth={2} />
                    : <CheckCircle2 style={{ width: 12, height: 12 }} strokeWidth={2} />}
                </div>
                <Wrench style={{ width: 13, height: 13, color: 'var(--text-gray)', flexShrink: 0 }} strokeWidth={2} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--text-body)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {toolTraceStatus === 'running'
                      ? '工具调用中'
                      : toolTraceStatus === 'error'
                        ? '工具调用失败'
                        : toolTraceStatus === 'cancelled'
                          ? '工具调用已停止'
                          : '工具调用结束'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-gray)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginTop: 1,
                    }}
                  >
                    {latestToolEvent?.text || (isStreaming ? '准备执行网页/文档操作…' : '本次会话没有额外工具输出。')}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-light)', flexShrink: 0 }}>
                  {toolTrace.length} 条
                </div>
                <ChevronRight
                  style={{
                    width: 13,
                    height: 13,
                    color: 'var(--text-light)',
                    transform: toolTraceExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 180ms ease',
                    flexShrink: 0,
                  }}
                  strokeWidth={2}
                />
              </button>

              {toolTraceExpanded && (
                <div
                  style={{
                    padding: '8px 10px 10px',
                    borderTop: '1px solid var(--border-default)',
                    background: 'var(--bg-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    maxHeight: 180,
                    overflowY: 'auto',
                  }}
                >
                  {toolTrace.map((event) => (
                    <div
                      key={event.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-body)',
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ color: event.kind === 'call' ? 'var(--color-blue)' : 'var(--color-green)', marginTop: 1 }}>
                        {event.kind === 'call' ? '•' : '✓'}
                      </span>
                      <div style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{event.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Message List */}
        {messages.map((msg) => {
          return (
            <div
              key={msg.id}
              className={`flex gap-2.5 ${msg.type === 'user' ? 'flex-row-reverse' : ''}`}
            >
              {msg.type === 'user' ? (
                /* User message: right-aligned, subtle tinted background */
                <div
                  className="max-w-[85%] text-[13px] leading-relaxed"
                  style={{
                    padding: '8px 12px',
                    borderRadius: '14px 14px 4px 14px',
                    background: 'var(--bg-user-msg, color-mix(in srgb, var(--color-blue) 8%, transparent))',
                    color: 'var(--text-body)',
                  }}
                >
                  {/* Attachments strip */}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5" style={{ marginBottom: msg.content ? 6 : 0 }}>
                      {msg.attachments.map(att => (
                        <button
                          key={att.id}
                          type="button"
                          onClick={() => { void handleAttachmentPreview(att) }}
                          className="flex items-center gap-1.5 rounded-md text-left transition-all duration-150 hover:border-[var(--color-blue)]"
                          style={{
                            padding: '4px 8px',
                            background: 'var(--bg-code)',
                            border: '1px solid var(--border-default)',
                            fontSize: 11,
                            color: 'var(--text-gray)',
                            maxWidth: 180,
                            cursor: 'pointer',
                          }}
                        >
                          {getAttachmentPreviewSrc(att) ? (
                            <img
                              src={getAttachmentPreviewSrc(att)!}
                              alt={att.name}
                              style={{
                                width: 24,
                                height: 24,
                                objectFit: 'cover',
                                borderRadius: 6,
                                border: '1px solid var(--border-default)',
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            <AttachmentIcon attachment={att} size={12} />
                          )}
                          <span className="truncate">{att.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {msg.content && <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>}
                </div>
              ) : msg.type === 'system' ? (
                /* System / error message */
                <div
                  className="text-[12px] leading-relaxed"
                  style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: 'color-mix(in srgb, var(--color-red) 10%, transparent)',
                    color: 'var(--color-red)',
                  }}
                >
                  {msg.content}
                </div>
              ) : (
                /* Agent message: no background, just text */
                <div
                  className="group/agentmsg relative max-w-[90%] text-[13px] leading-relaxed"
                  style={{ color: 'var(--text-body)', paddingRight: 18 }}
                >
                  <MarkdownContent content={msg.content} />
                  {!!msg.content?.trim() && (
                    <button
                      type="button"
                      onClick={() => { void handleCopyAgentMessage(msg.id, msg.content) }}
                      className={`absolute transition-all duration-160 ease-out ${
                        copiedMessageId === msg.id
                          ? 'opacity-100 pointer-events-auto'
                          : 'opacity-0 pointer-events-none group-hover/agentmsg:opacity-100 group-hover/agentmsg:pointer-events-auto'
                      }`}
                      style={{
                        right: 0,
                        bottom: -2,
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid var(--border-default)',
                        color: copiedMessageId === msg.id ? 'var(--color-green)' : 'var(--text-light)',
                        background: copiedMessageId === msg.id
                          ? 'color-mix(in srgb, var(--color-green) 10%, transparent)'
                          : 'var(--surface-card-bg)',
                      }}
                      title={copiedMessageId === msg.id ? '已复制' : '复制回复'}
                    >
                      {copiedMessageId === msg.id ? (
                        <Check style={{ width: 12, height: 12 }} strokeWidth={2} />
                      ) : (
                        <Copy style={{ width: 12, height: 12 }} strokeWidth={2} />
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {isStreaming && (() => {
          const streamMsg = messages.find(m => m.id === (useAgent.getState().streamingMessageId))
          if (!streamMsg || streamMsg.content.length === 0) {
            return (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-avatar)' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-title)' }}>R</span>
                </div>
                <div className="px-3 py-2 rounded-xl bg-[var(--bg-primary)] border border-[var(--border-default)]">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-[var(--color-blue)] animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 rounded-full bg-[var(--color-blue)] animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 rounded-full bg-[var(--color-blue)] animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )
          }
          return null
        })()}

        <div ref={messagesEndRef} />
      </div>

      {/* ChatInputArea */}
      <div
        className="glass-surface-panel"
        style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--border-default)',
          display: 'flex', flexDirection: 'column', gap: 8,
          background: 'var(--surface-toolbar-bg)',
        }}
      >
        {/* W3: Attachment thumbnails bar */}
        {attachments.length > 0 && (
          <div
            className="flex items-center gap-2 overflow-x-auto"
            style={{ padding: '4px 0' }}
          >
            {attachments.map(att => (
              <div
                key={att.id}
                className="relative flex-shrink-0 flex items-center gap-1.5"
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  background: 'var(--bg-hover)',
                  border: '1px solid var(--border-default)',
                  maxWidth: 140
                }}
              >
                <button
                  type="button"
                  onClick={() => { void handleAttachmentPreview(att) }}
                  className="flex items-center gap-1.5 text-left"
                  style={{ minWidth: 0, flex: 1, paddingRight: 8 }}
                >
                  {att.type === 'image' ? (
                    <img
                      src={toLocalFileUrl(att.path)}
                      alt={att.name}
                      style={{ width: 28, height: 28, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  ) : (
                    <AttachmentIcon attachment={att} />
                  )}
                  <span style={{
                    fontSize: 10, color: 'var(--text-body)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {att.name}
                  </span>
                </button>
                <button
                  onClick={() => removeAttachment(att.id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center hover:bg-black/10"
                  style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-default)' }}
                >
                  <X style={{ width: 8, height: 8 }} className="text-[var(--text-gray)]" strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
        )}

        {pendingSendCount > 0 && !isStreaming && (
          <div
            className="glass-surface-card flex items-center justify-between"
            style={{
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-input)',
              background: 'var(--surface-card-bg)',
              fontSize: 11,
              color: 'var(--text-gray)',
            }}
          >
            <span>
              正在合并 {pendingSendCount} 条连续消息，准备统一发送
            </span>
            <span style={{ color: 'var(--text-light)' }}>
              {Math.max(0.1, pendingSendCountdown / 1000).toFixed(1)}s
            </span>
          </div>
        )}

        {/* Input Box -- upgraded to textarea for multiline + @ detection */}
        <div
          className="glass-surface-card flex items-end"
          style={{
            borderRadius: 10,
            background: 'var(--surface-card-bg)',
            border: isDragOver ? '2px solid var(--color-blue)' : '1px solid var(--border-input)',
            padding: isDragOver ? '9px 13px' : '10px 14px',
            position: 'relative',
            transition: 'border 150ms ease',
          }}
        >
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            placeholder="Hi～今天有什么可以帮到你"
            className="flex-1 bg-transparent border-none outline-none resize-none"
            style={{
              fontSize: 13, fontWeight: 500, color: 'var(--text-body)',
              lineHeight: '1.5', minHeight: 20, maxHeight: 120,
              opacity: isStreaming ? 0.7 : 1,
            }}
            rows={1}
          />

          {/* W4: @ mention dropdown */}
          {showAtMenu && filteredFilePool.length > 0 && (
            <div
              ref={atMenuRef}
              className="glass-surface-floating"
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                marginBottom: 4,
                width: '100%',
                maxHeight: 200,
                overflowY: 'auto',
                background: 'var(--surface-floating-bg)',
                border: '1px solid var(--border-default)',
                borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                padding: 4,
                zIndex: 200
              }}
            >
              <div style={{ fontSize: 10, color: 'var(--text-light)', padding: '2px 8px', marginBottom: 2 }}>
                引用文件
              </div>
              {filteredFilePool.map(file => (
                <button
                  key={file.id}
                  onClick={() => handleAtSelect(file)}
                  className="w-full flex items-center gap-2 hover:bg-black/5 active:scale-[0.98] transition-all duration-150"
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <AttachmentIcon attachment={file} />
                  <span style={{
                    fontSize: 12, fontWeight: 500, color: 'var(--text-body)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {file.name}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-light)', marginLeft: 'auto' }}>
                    {file.source === 'browser-tab'
                      ? '网页'
                      : file.source === 'skill-folder'
                        ? '技能'
                        : `${(file.size / 1024).toFixed(0)} KB`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Bottom Bar */}
        <div className="flex items-center justify-between">
          {/* Left: add + mode + model */}
          <div className="flex items-center" style={{ gap: 6 }}>
            {/* W3: + button for file picking */}
            <button
              onClick={pickFiles}
              title="添加文件"
              className="flex items-center justify-center hover:bg-black/5 active:scale-[0.98] transition-all duration-200 ease-out"
              style={{ width: 24, height: 24, borderRadius: 8, border: '1px solid var(--border-input)' }}
            >
              <Plus style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
            </button>
            {/* Agent selector with dropdown */}
            <div className="relative" ref={dropdownRef}>
              <button
                disabled={currentScope?.sourceKind === 'channel'}
                onClick={() => setShowAgentSelect(!showAgentSelect)}
                className="flex items-center active:scale-[0.98] transition-all duration-200 ease-out"
                style={{
                  padding: '3px 8px',
                  borderRadius: 8,
                  border: '1px solid var(--border-input)',
                  gap: 4,
                  opacity: currentScope?.sourceKind === 'channel' ? 0.7 : 1,
                  cursor: currentScope?.sourceKind === 'channel' ? 'default' : 'pointer',
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>{currentAgentData?.avatar}</span>
                <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>{currentAgentData?.displayName || '管家'}</span>
                <ChevronDown
                  style={{
                    width: 10, height: 10,
                    transform: showAgentSelect ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 200ms ease'
                  }}
                  className="text-[var(--text-light)]"
                />
              </button>

              {/* Agent Dropdown Menu */}
              {showAgentSelect && currentScope?.sourceKind !== 'channel' && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: 0,
                    marginBottom: 4,
                    minWidth: 160,
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 8,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                    padding: 4,
                    zIndex: 100
                  }}
                >
                  {agents.map((agent) => (
                    <button
                      key={agent.name}
                      onClick={() => handleAgentSelect(agent.name)}
                      className="w-full flex items-center gap-2 hover:bg-black/5 active:scale-[0.98] transition-all duration-150"
                      style={{
                        padding: '6px 10px',
                        borderRadius: 6,
                        border: 'none',
                        background: agent.name === currentAgent ? 'var(--bg-hover)' : 'transparent',
                        cursor: 'pointer'
                      }}
                    >
                      <span style={{ fontSize: 14 }}>{agent.avatar}</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)', flex: 1, textAlign: 'left' }}>
                        {agent.displayName}
                      </span>
                      {agent.name === currentAgent && (
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-blue)' }} />
                      )}
                      {agent.status === 'working' && (
                        <span style={{ fontSize: 10, color: 'var(--color-blue)' }}>工作中</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Model selector */}
            <ModelSelector />
          </div>

          {/* Right: undo + @ + expand + stop/send */}
          <div className="flex items-center" style={{ gap: 6 }}>
            {/* Undo last message */}
            {!isStreaming && messages.filter(m => m.type === 'user').length > 0 && (
              <button
                onClick={undoLastMessage}
                title="撤回上一条消息"
                className="p-1 rounded hover:bg-black/5 active:scale-[0.98] transition-all duration-200 ease-out"
              >
                <Undo2 style={{ width: 15, height: 15 }} className="text-[var(--text-gray)]" strokeWidth={2} />
              </button>
            )}
            {/* W4: @ button */}
            <button
              onClick={handleAtButtonClick}
              title={filePool.length > 0 ? '引用文件' : '先用 + 添加文件'}
              className="p-1 rounded active:scale-[0.98] transition-all duration-200 ease-out"
              style={{ opacity: filePool.length > 0 ? 1 : 0.4 }}
            >
              <AtSign style={{ width: 15, height: 15 }} className="text-[var(--text-gray)]" strokeWidth={2} />
            </button>
            <button className="p-1 rounded active:scale-[0.98] transition-all duration-200 ease-out">
              <Maximize2 style={{ width: 14, height: 14 }} className="text-[var(--text-gray)]" strokeWidth={2} />
            </button>
            {isStreaming ? (
              <button
                onClick={stopStreaming}
                title="停止生成"
                className="flex items-center justify-center text-white hover:brightness-95 active:scale-[0.98] transition-all duration-200 ease-out"
                style={{
                  width: 26, height: 26,
                  borderRadius: 13,
                  background: 'var(--color-red)'
                }}
              >
                <Square style={{ width: 11, height: 11 }} strokeWidth={0} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!inputValue.trim() && attachments.length === 0}
                className="flex items-center justify-center text-white hover:brightness-95 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 ease-out"
                style={{
                  width: 26, height: 26,
                  borderRadius: 13,
                  background: 'var(--color-blue)'
                }}
              >
                <Send style={{ width: 13, height: 13 }} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>

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
              background: 'var(--surface-floating-bg)',
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
