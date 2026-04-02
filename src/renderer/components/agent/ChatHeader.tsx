import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { History, Plus, ChevronDown, X, PanelRightClose } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import type { ConversationScope } from '../../stores/useAgent'
import {
  CHAT_HEADER_MENU_DELETE_BUTTON_STYLE,
  CHAT_HEADER_MENU_META_STYLE,
  CHAT_HEADER_MENU_SECTION_LABEL_STYLE,
  buildChatHeaderFloatingMenuStyle,
  buildChatHeaderMenuItemStyle,
} from './chatHeaderMenuStyles'

interface ConversationChannelOption {
  key: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  label: string
  caption: string
}

interface ChatHeaderProps {
  currentChannel: ConversationChannelOption
  channelOptions: ConversationChannelOption[]
  filteredScopes: ConversationScope[]
  onChannelSelect: (channel: ConversationChannelOption) => void
  onTogglePanel: () => void
  onNewSession: () => void
  onLoadConversation: (convId: string) => void
  onDeleteConversation: (convId: string) => void
  onHistoryOpen?: () => void
  formatTime: (time: string) => string
}

interface FloatingMenuPosition {
  left: number
  top: number
}

export default function ChatHeader({
  currentChannel,
  channelOptions,
  filteredScopes,
  onChannelSelect,
  onTogglePanel,
  onNewSession,
  onLoadConversation,
  onDeleteConversation,
  onHistoryOpen,
  formatTime,
}: ChatHeaderProps) {
  const [showScopeSelect, setShowScopeSelect] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [scopeMenuPosition, setScopeMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const [historyMenuPosition, setHistoryMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const portalRoot = typeof document !== 'undefined' ? document.body : null

  const computeMenuPosition = useCallback((
    trigger: HTMLButtonElement | null,
    menuWidth: number,
    align: 'left' | 'right',
  ): FloatingMenuPosition | null => {
    if (!trigger || typeof window === 'undefined') return null

    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const margin = 8
    const preferredLeft = align === 'left' ? rect.left : rect.right - menuWidth
    const left = Math.max(margin, Math.min(preferredLeft, viewportWidth - menuWidth - margin))

    return {
      left: Math.round(left),
      top: Math.round(rect.bottom + 6),
    }
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const clickedScope = !!(
        scopeTriggerRef.current?.contains(target) ||
        scopeMenuRef.current?.contains(target)
      )
      const clickedHistory = !!(
        historyTriggerRef.current?.contains(target) ||
        historyMenuRef.current?.contains(target)
      )

      if (showScopeSelect && !clickedScope) {
        setShowScopeSelect(false)
        setScopeMenuPosition(null)
      }
      if (showHistory && !clickedHistory) {
        setShowHistory(false)
        setHistoryMenuPosition(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showHistory, showScopeSelect])

  const handleHistoryToggle = useCallback(() => {
    setShowHistory((prev) => {
      const next = !prev
      setHistoryMenuPosition(next ? computeMenuPosition(historyTriggerRef.current, 286, 'right') : null)
      return next
    })
  }, [computeMenuPosition])

  const handleScopeToggle = useCallback(() => {
    setShowScopeSelect((prev) => {
      const next = !prev
      setScopeMenuPosition(next ? computeMenuPosition(scopeTriggerRef.current, 300, 'left') : null)
      return next
    })
  }, [computeMenuPosition])

  useEffect(() => {
    if (!showScopeSelect && !showHistory) return

    const syncMenuPositions = () => {
      if (showScopeSelect) {
        setScopeMenuPosition(computeMenuPosition(scopeTriggerRef.current, 300, 'left'))
      }
      if (showHistory) {
        setHistoryMenuPosition(computeMenuPosition(historyTriggerRef.current, 286, 'right'))
      }
    }

    syncMenuPositions()
    window.addEventListener('resize', syncMenuPositions)
    window.addEventListener('scroll', syncMenuPositions, true)
    return () => {
      window.removeEventListener('resize', syncMenuPositions)
      window.removeEventListener('scroll', syncMenuPositions, true)
    }
  }, [computeMenuPosition, showHistory, showScopeSelect])

  const channelMenuStyle = {
    ...buildChatHeaderFloatingMenuStyle(300),
    position: 'fixed' as const,
    top: scopeMenuPosition?.top ?? 0,
    left: scopeMenuPosition?.left ?? 0,
  }

  const historyMenuStyle = {
    ...buildChatHeaderFloatingMenuStyle(286),
    position: 'fixed' as const,
    top: historyMenuPosition?.top ?? 0,
    left: historyMenuPosition?.left ?? 0,
    maxHeight: 332,
  }

  return (
    <>
      <div
        className="flex items-center justify-between"
        style={{
          height: 38,
          padding: '0 14px',
          borderBottom: '1px solid transparent',
          background: 'transparent',
          position: 'relative',
          overflow: 'visible',
          zIndex: 20,
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          boxShadow: 'none',
        }}
      >
        <div className="relative" data-chat-session-switcher="true">
          <button
            ref={scopeTriggerRef}
            onClick={() => {
              handleScopeToggle()
              setShowHistory(false)
              setHistoryMenuPosition(null)
            }}
            className="flex items-center active:scale-[0.98] transition-all duration-200 ease-out"
            style={{
              gap: 6,
              padding: '6px 10px 6px 2px',
              borderRadius: 10,
              border: '1px solid transparent',
              background: 'transparent',
              maxWidth: 200,
            }}
          >
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--text-title)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
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
        </div>

        <div className="flex items-center" style={{ gap: 4 }} data-chat-session-menu="true">
          <IconButton
            icon={<PanelRightClose style={{ width: 14, height: 14 }} strokeWidth={2} />}
            onClick={onTogglePanel}
            title="折叠聊天面板"
          />

          <div className="relative">
            <IconButton
              icon={<History style={{ width: 14, height: 14 }} strokeWidth={2} />}
              onClick={() => {
                const next = !showHistory
                if (next) onHistoryOpen?.()
                handleHistoryToggle()
                setShowScopeSelect(false)
                setScopeMenuPosition(null)
              }}
              title="历史对话"
              active={showHistory}
              ref={historyTriggerRef}
            />
          </div>

          <IconButton
            icon={<Plus style={{ width: 14, height: 14 }} strokeWidth={2} />}
            onClick={onNewSession}
            title="新建对话"
          />
        </div>
      </div>

      {portalRoot && showScopeSelect && scopeMenuPosition && createPortal(
        <div
          ref={scopeMenuRef}
          className="glass-surface-floating chat-header-floating-menu ready-floating-menu"
          style={channelMenuStyle}
        >
          <div style={CHAT_HEADER_MENU_SECTION_LABEL_STYLE}>会话来源</div>
          {channelOptions.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-gray)', padding: '12px 10px 10px' }}>暂无频道</div>
          ) : (
            <div className="flex flex-col" style={{ gap: 4 }}>
              {channelOptions.map((channel) => (
                <button
                  key={channel.key}
                  onClick={() => {
                    onChannelSelect(channel)
                    setShowScopeSelect(false)
                    setScopeMenuPosition(null)
                  }}
                  className={`chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-3 active:scale-[0.98] transition-all duration-150 ${currentChannel.key === channel.key ? 'is-selected' : ''}`}
                  style={buildChatHeaderMenuItemStyle({ selected: currentChannel.key === channel.key })}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--text-body)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {channel.label}
                    </div>
                    <div style={CHAT_HEADER_MENU_META_STYLE}>{channel.caption}</div>
                  </div>
                  {currentChannel.key === channel.key && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'rgba(96, 104, 118, 0.38)',
                        boxShadow: '0 0 0 4px rgba(255,255,255,0.24)',
                      }}
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}

      {portalRoot && showHistory && historyMenuPosition && createPortal(
        <div
          ref={historyMenuRef}
          className="glass-surface-floating chat-header-floating-menu ready-floating-menu"
          style={historyMenuStyle}
        >
          <div style={CHAT_HEADER_MENU_SECTION_LABEL_STYLE}>{currentChannel.label}历史</div>
          {filteredScopes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-gray)', padding: '12px 8px 10px', textAlign: 'center' }}>
              当前频道暂无会话历史
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: 4 }}>
              {filteredScopes.map((conv) => (
                <div
                  key={conv.id}
                  className="chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-3 active:scale-[0.98] transition-all duration-150 group"
                  style={{ ...buildChatHeaderMenuItemStyle(), display: 'flex', alignItems: 'center', gap: 12 }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onLoadConversation(conv.id)
                      setShowHistory(false)
                      setHistoryMenuPosition(null)
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--text-body)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {conv.title || '新对话'}
                    </div>
                    <div style={{ ...CHAT_HEADER_MENU_META_STYLE, display: 'flex', gap: 6 }}>
                      <span>{conv.agent}</span>
                      <span>{formatTime(conv.updatedAt)}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteConversation(conv.id)
                    }}
                    className="chat-header-menu-delete-button group-hover:opacity-100 transition-all"
                    style={CHAT_HEADER_MENU_DELETE_BUTTON_STYLE}
                    title="删除对话"
                  >
                    <X style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
