import { forwardRef, useRef, useEffect, useState, useImperativeHandle, useCallback, useMemo } from 'react'
import { AtSign, Plus, Send, Square, Undo2, ChevronDown } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import type { ChatAttachment } from '../../stores/useAgent'

interface ChatInputProps {
  inputValue: string
  isStreaming: boolean
  attachmentsCount: number
  hasUserMessages: boolean
  pendingSendCount: number
  pendingSendCountdown: number
  isDragOver: boolean
  composerShellStyle: React.CSSProperties
  filePool: ChatAttachment[]
  filePoolCount: number
  currentAgent: string
  currentAgentAvatar: string
  currentAgentDisplayName: string
  agents: Array<{ name: string; avatar: string; displayName: string; status: string }>
  isChannelScope: boolean
  onInputChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onUndo: () => void
  onPickFiles: () => void
  onAgentSelect: (agentName: string) => void
  renderAttachmentIcon: (attachment: ChatAttachment, size?: number) => React.ReactNode
  ModelSelector: React.ComponentType
}

export interface ChatInputHandle {
  focusWithResize: () => void
  resetHeight: () => void
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  inputValue,
  isStreaming,
  attachmentsCount,
  hasUserMessages,
  pendingSendCount,
  pendingSendCountdown,
  isDragOver,
  composerShellStyle,
  filePool,
  filePoolCount,
  currentAgent,
  currentAgentAvatar,
  currentAgentDisplayName,
  agents,
  isChannelScope,
  onInputChange,
  onSend,
  onStop,
  onUndo,
  onPickFiles,
  onAgentSelect,
  renderAttachmentIcon,
  ModelSelector,
}: ChatInputProps, ref) {
  const [showAgentSelect, setShowAgentSelect] = useState(false)
  const [showAtMenu, setShowAtMenu] = useState(false)
  const [atFilter, setAtFilter] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const atMenuRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)

  const resizeTextarea = useCallback(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
  }, [])

  const focusWithResize = useCallback(() => {
    setTimeout(() => {
      resizeTextarea()
      textareaRef.current?.focus()
    }, 0)
  }, [resizeTextarea])

  const resetHeight = useCallback(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = 'auto'
  }, [])

  useImperativeHandle(ref, () => ({
    focusWithResize,
    resetHeight,
  }), [focusWithResize, resetHeight])

  // Auto-resize textarea
  useEffect(() => {
    resizeTextarea()
  }, [inputValue, resizeTextarea])

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showAgentSelect && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAgentSelect(false)
      }
      if (showAtMenu && atMenuRef.current && !atMenuRef.current.contains(e.target as Node)) {
        setShowAtMenu(false)
        setAtFilter('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAgentSelect, showAtMenu])

  const filteredFilePool = useMemo(() => {
    if (!atFilter) return filePool
    const loweredFilter = atFilter.toLowerCase()
    return filePool.filter((file) => (
      file.name.toLowerCase().includes(loweredFilter) ||
      file.path.toLowerCase().includes(loweredFilter)
    ))
  }, [filePool, atFilter])

  const insertAtReference = useCallback((file: ChatAttachment) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPos = textarea.selectionStart
    const textBeforeCursor = inputValue.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/)
    if (!atMatch) return

    const beforeAt = textBeforeCursor.slice(0, atMatch.index)
    const afterCursor = inputValue.slice(cursorPos)
    const insertion = `@[${file.name}]`
    const nextValue = beforeAt + insertion + afterCursor
    onInputChange(nextValue)

    setTimeout(() => {
      const newPos = (beforeAt + insertion).length
      textarea.setSelectionRange(newPos, newPos)
      textarea.focus()
    }, 0)

    setShowAtMenu(false)
    setAtFilter('')
  }, [inputValue, onInputChange])

  const handleInputChange = (value: string, cursorPos: number) => {
    onInputChange(value)
    const textBeforeCursor = value.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/)
    if (atMatch && filePool.length > 0) {
      setAtFilter(atMatch[1])
      setShowAtMenu(true)
    } else {
      setShowAtMenu(false)
      setAtFilter('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent
    const nativeKeyCode = Number(nativeEvent.keyCode || 0)
    const nativeWhich = Number(nativeEvent.which || 0)
    const isImeConfirmKey = nativeKeyCode === 229 || nativeWhich === 229
    if (composingRef.current || e.nativeEvent.isComposing || isImeConfirmKey) {
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (inputValue.trim() || attachmentsCount > 0) {
        onSend()
      }
    }
  }

  return (
    <div
      style={{
        padding: '10px 16px 0',
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
      {pendingSendCount > 0 && !isStreaming && (
        <div
          className="flex items-center justify-between"
          style={{
            padding: '7px 10px',
            borderRadius: 8,
            border: '1px solid transparent',
            background: 'transparent',
            fontSize: 11,
            color: 'var(--text-gray)',
          }}
        >
          <span>正在合并 {pendingSendCount} 条连续消息，准备统一发送</span>
          <span style={{ color: 'var(--text-light)' }}>
            {Math.max(0.1, pendingSendCountdown / 1000).toFixed(1)}s
          </span>
        </div>
      )}

      <div data-chat-composer-shell="true" className="block w-full" style={composerShellStyle}>
        <div
          className="flex items-end"
          style={{
            borderRadius: 10,
            background: 'transparent',
            padding: isDragOver ? '9px 13px' : '10px 14px',
            position: 'relative',
            transition: 'padding 150ms ease',
          }}
        >
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => handleInputChange(e.target.value, e.target.selectionStart)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            disabled={isStreaming}
            placeholder="Hi～今天有什么可以帮到你"
            className="ready-input-slot-inner flex-1 bg-transparent border-none outline-none resize-none"
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--text-body)',
              lineHeight: '1.5',
              minHeight: 20,
              maxHeight: 120,
              opacity: isStreaming ? 0.7 : 1,
            }}
            rows={1}
          />

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
                background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
                border: '1px solid var(--border-default)',
                borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                padding: 4,
                zIndex: 200,
              }}
            >
              <div style={{ fontSize: 10, color: 'var(--text-light)', padding: '2px 8px', marginBottom: 2 }}>
                引用文件 / 文件夹
              </div>
              {filteredFilePool.map((file) => (
                <button
                  key={file.id}
                  onClick={() => insertAtReference(file)}
                  className="w-full flex items-center gap-2 hover:bg-black/5 active:scale-[0.98] transition-all duration-150"
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {renderAttachmentIcon(file)}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: 'var(--text-body)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {file.name}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--text-light)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 2,
                      }}
                      title={file.path}
                    >
                      {file.path}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--text-light)', marginLeft: 'auto', flexShrink: 0 }}>
                    {file.isDirectory
                      ? '文件夹'
                      : file.source === 'browser-tab'
                        ? '网页'
                        : file.source === 'skill-folder'
                          ? '技能'
                          : `${Math.max(1, Math.round(file.size / 1024))} KB`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="flex items-center justify-between">
        {/* Left: add + agent + model */}
        <div className="flex items-center" style={{ gap: 6 }}>
          <button
            onClick={onPickFiles}
            title="添加文件"
            className="flex items-center justify-center hover:bg-black/5 active:scale-[0.98] transition-all duration-200 ease-out"
            style={{ width: 24, height: 24, borderRadius: 8, border: '1px solid transparent', background: 'transparent' }}
          >
            <Plus style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
          </button>

          {/* Agent selector */}
          <div className="relative" ref={dropdownRef}>
            <button
              disabled={isChannelScope}
              onClick={() => setShowAgentSelect(!showAgentSelect)}
              className="flex items-center active:scale-[0.98] transition-all duration-200 ease-out"
              style={{
                padding: '3px 8px',
                borderRadius: 8,
                border: '1px solid transparent',
                background: 'transparent',
                gap: 4,
                opacity: isChannelScope ? 0.7 : 1,
                cursor: isChannelScope ? 'default' : 'pointer',
              }}
            >
              <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>{currentAgentAvatar}</span>
              <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>{currentAgentDisplayName || '管家'}</span>
              <ChevronDown
                style={{
                  width: 10,
                  height: 10,
                  transform: showAgentSelect ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 200ms ease',
                }}
                className="text-[var(--text-light)]"
              />
            </button>

            {showAgentSelect && !isChannelScope && (
              <div
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: 0,
                  marginBottom: 4,
                  minWidth: 160,
                  background: 'color-mix(in srgb, var(--bg-panel) 24%, transparent)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 8,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                  padding: 4,
                  zIndex: 100,
                }}
              >
                {agents.map((agent) => (
                  <button
                    key={agent.name}
                    onClick={() => {
                      onAgentSelect(agent.name)
                      setShowAgentSelect(false)
                    }}
                    className="w-full flex items-center gap-2 hover:bg-black/5 active:scale-[0.98] transition-all duration-150"
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: 'none',
                      background: agent.name === currentAgent ? 'var(--bg-hover)' : 'transparent',
                      cursor: 'pointer',
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

          <ModelSelector />
        </div>

        {/* Right: undo + @ + stop/send */}
        <div className="flex items-center" style={{ gap: 6 }}>
          {!isStreaming && hasUserMessages && (
            <IconButton
              icon={<Undo2 style={{ width: 15, height: 15 }} strokeWidth={2} />}
              onClick={onUndo}
              title="撤回上一条消息"
            />
          )}

          <IconButton
            icon={<AtSign style={{ width: 15, height: 15 }} strokeWidth={2} />}
            onClick={() => {
              if (filePool.length === 0) return
              setAtFilter('')
              setShowAtMenu((value) => !value)
            }}
            title={filePoolCount > 0 ? '引用文件或文件夹' : '先用 + 添加文件'}
            disabled={filePoolCount === 0}
          />

          {isStreaming ? (
            <button
              onClick={onStop}
              title="停止生成"
              className="flex items-center justify-center text-white hover:brightness-95 active:scale-[0.98] transition-all duration-200 ease-out"
              style={{
                width: 26,
                height: 26,
                borderRadius: 13,
                background: 'var(--color-red)',
              }}
            >
              <Square style={{ width: 11, height: 11 }} strokeWidth={0} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!inputValue.trim() && attachmentsCount === 0}
              className="flex items-center justify-center text-white hover:brightness-95 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 ease-out"
              style={{
                width: 26,
                height: 26,
                borderRadius: 13,
                border: '1px solid transparent',
                background: 'var(--color-blue)',
                boxShadow: 'none',
              }}
            >
              <Send style={{ width: 13, height: 13 }} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

export default ChatInput
