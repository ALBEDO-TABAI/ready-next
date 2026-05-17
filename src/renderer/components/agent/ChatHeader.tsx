import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { History, Plus, ChevronDown, X, PanelRightClose } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import Modal from '../ui/Modal'
import type { SessionRecallHit } from '../../../shared/session-recall'
import {
  CHAT_HEADER_MENU_DELETE_BUTTON_STYLE,
  CHAT_HEADER_MENU_META_STYLE,
  CHAT_HEADER_MENU_SECTION_LABEL_STYLE,
  buildChatHeaderFloatingMenuStyle,
  buildChatHeaderMenuItemStyle,
} from './chatHeaderMenuStyles'
import { subscribeWorkbenchWindowResize } from '../../modules/workbench/windowResize'

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
  onChannelSelect: (channel: ConversationChannelOption) => void
  onTogglePanel: () => void
  onNewSession: () => void
  onLoadConversation: (convId: string) => void
  onDeleteConversation: (convId: string) => void
  sessionRecallQuery: string
  sessionRecallResults: SessionRecallHit[]
  sessionRecallSearching: boolean
  sessionRecallError?: string | null
  attachedSessionRecallCount: number
  attachedSessionRecallConversationIds: string[]
  onSessionRecallQueryChange: (value: string) => void
  onSessionRecallSearch: () => void
  onAttachSessionRecall: (conversationId: string) => void
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
  onChannelSelect,
  onTogglePanel,
  onNewSession,
  onLoadConversation,
  onDeleteConversation,
  sessionRecallQuery,
  sessionRecallResults,
  sessionRecallSearching,
  sessionRecallError,
  attachedSessionRecallCount,
  attachedSessionRecallConversationIds,
  onSessionRecallQueryChange,
  onSessionRecallSearch,
  onAttachSessionRecall,
  onHistoryOpen,
  formatTime,
}: ChatHeaderProps) {
  const [showScopeSelect, setShowScopeSelect] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [scopeMenuPosition, setScopeMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const [historyMenuPosition, setHistoryMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ conversationId: string; title: string } | null>(null)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const portalRoot = typeof document !== 'undefined' ? document.body : null
  const historyMenuWidth = 340
  const recallActionRailWidth = 72

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
      setHistoryMenuPosition(next ? computeMenuPosition(historyTriggerRef.current, historyMenuWidth, 'right') : null)
      return next
    })
  }, [computeMenuPosition, historyMenuWidth])

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
        setHistoryMenuPosition(computeMenuPosition(historyTriggerRef.current, historyMenuWidth, 'right'))
      }
    }

    syncMenuPositions()
    const unsubscribeWindowResize = subscribeWorkbenchWindowResize(syncMenuPositions)
    window.addEventListener('scroll', syncMenuPositions, true)
    return () => {
      unsubscribeWindowResize()
      window.removeEventListener('scroll', syncMenuPositions, true)
    }
  }, [computeMenuPosition, historyMenuWidth, showHistory, showScopeSelect])

  const channelMenuStyle = {
    ...buildChatHeaderFloatingMenuStyle(300),
    position: 'fixed' as const,
    top: scopeMenuPosition?.top ?? 0,
    left: scopeMenuPosition?.left ?? 0,
  }

  const historyMenuStyle = {
    ...buildChatHeaderFloatingMenuStyle(historyMenuWidth),
    position: 'fixed' as const,
    top: historyMenuPosition?.top ?? 0,
    left: historyMenuPosition?.left ?? 0,
    maxHeight: 420,
    overflow: 'hidden',
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
            className="flex items-center active:scale-[0.98] transition-[background-color,transform] duration-200 ease-out"
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
                  className={`chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-3 active:scale-[0.98] transition-[background-color,border-color,box-shadow,transform] duration-150 ${currentChannel.key === channel.key ? 'is-selected' : ''}`}
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
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              alignItems: 'start',
              gap: 12,
              padding: '2px 12px 0'
            }}
          >
            <input
              value={sessionRecallQuery}
              onChange={(event) => onSessionRecallQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onSessionRecallSearch()
                }
              }}
              placeholder="搜旧会话标题、消息、任务摘要或附件名"
              className="rounded-[10px] border"
              style={{
                minWidth: 0,
                width: '100%',
                maxWidth: '100%',
                padding: '8px 10px',
                borderColor: 'var(--border-default)',
                background: 'var(--bg-input)',
                color: 'var(--text-body)',
                fontSize: 12.5
              }}
            />
            <div
              style={{
                width: recallActionRailWidth,
                flexShrink: 0,
                display: 'flex',
                justifyContent: 'flex-start',
                alignItems: 'flex-start',
                paddingTop: 2
              }}
            >
              <button
                type="button"
                onClick={onSessionRecallSearch}
                className="rounded-[10px] border transition-[background-color,border-color,color]"
                style={{
                  width: 44,
                  height: 32,
                  borderColor: 'var(--border-default)',
                  background: 'transparent',
                  color: 'var(--text-body)',
                  fontSize: 12,
                  fontWeight: 600
                }}
              >
                {sessionRecallSearching ? '搜索中…' : '搜索'}
              </button>
            </div>
          </div>

          {attachedSessionRecallCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-light)', padding: '2px 12px 0' }}>
              当前轮已引用 {attachedSessionRecallCount} 条旧会话
            </div>
          )}

          {sessionRecallError && (
            <div style={{ fontSize: 11, color: 'var(--color-red)', padding: '0 12px' }}>
              {sessionRecallError}
            </div>
          )}

          {sessionRecallResults.length === 0 && !sessionRecallSearching ? (
            <div style={{ fontSize: 12, color: 'var(--text-gray)', padding: '12px 8px 10px', textAlign: 'center' }}>
              {sessionRecallQuery.trim() ? '当前频道没有找到匹配的旧会话' : '这里会先显示当前频道最近会话'}
            </div>
          ) : (
            <div
              className="panel-hover-scrollbar flex flex-col"
              style={{ gap: 8, maxHeight: 300, overflow: 'auto', scrollbarGutter: 'stable' }}
            >
              {sessionRecallResults.map((conv) => {
                const attached = attachedSessionRecallConversationIds.includes(conv.conversationId)
                const conversationSummary =
                  conv.hitExcerpt?.trim() ||
                  conv.latestTaskSummary?.trim() ||
                  conv.resumeTitle?.trim() ||
                  ''
                return (
                  <div
                    key={conv.conversationId}
                    className="chat-header-floating-menu-item ready-floating-menu-item w-full flex items-start gap-3 active:scale-[0.98] transition-[background-color,border-color,box-shadow,transform] duration-150 group"
                    style={{
                      ...buildChatHeaderMenuItemStyle(),
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) auto',
                      alignItems: 'stretch',
                      gap: 12,
                      minHeight: 84,
                      padding: '12px 12px 11px',
                      overflow: 'hidden',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onLoadConversation(conv.conversationId)
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
                        width: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-start',
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{ minWidth: 0, width: '100%', overflow: 'hidden' }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            lineHeight: 1.3,
                            color: 'var(--text-body)',
                            paddingRight: 4,
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {conv.title || '新对话'}
                        </div>
                        {conversationSummary && (
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-light)',
                              marginTop: 4,
                              lineHeight: 1.45,
                              paddingRight: 4,
                              maxWidth: '100%',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              maxHeight: '3.1em',
                              whiteSpace: 'normal',
                              wordBreak: 'break-word',
                              overflowWrap: 'anywhere'
                            }}
                          >
                            {conversationSummary}
                          </div>
                        )}
                        <div
                          style={{
                            ...CHAT_HEADER_MENU_META_STYLE,
                            marginTop: conversationSummary ? 6 : 4,
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {formatTime(conv.updatedAt)}
                        </div>
                      </div>
                    </button>
                    <div
                      className="flex items-center"
                      style={{
                        width: recallActionRailWidth,
                        flexShrink: 0,
                        alignSelf: 'flex-start',
                        gap: 6,
                        paddingTop: 2
                      }}
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onAttachSessionRecall(conv.conversationId)
                        }}
                        disabled={attached}
                        className="rounded-[10px] border transition-[background-color,border-color,color,opacity]"
                        style={{
                          width: 44,
                          height: 32,
                          borderColor: 'var(--border-default)',
                          background: attached ? 'var(--bg-hover)' : 'transparent',
                          color: attached ? 'var(--text-light)' : 'var(--text-body)',
                          fontSize: 11.5,
                          fontWeight: 600,
                          opacity: attached ? 0.8 : 1
                        }}
                      >
                        {attached ? '已引用' : '引用'}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setPendingDeleteSession({
                            conversationId: conv.conversationId,
                            title: conv.title || '新对话',
                          })
                        }}
                        className="chat-header-menu-delete-button group-hover:opacity-100 transition-[background-color,opacity]"
                        style={CHAT_HEADER_MENU_DELETE_BUTTON_STYLE}
                        title="删除对话"
                      >
                        <X style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>,
        document.body,
      )}

      <Modal
        open={pendingDeleteSession !== null}
        mode="confirm"
        danger
        title="删除会话"
        message={pendingDeleteSession ? `确定删除会话 "${pendingDeleteSession.title}" 吗？此操作不可撤销。` : ''}
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={() => {
          if (pendingDeleteSession) {
            onDeleteConversation(pendingDeleteSession.conversationId)
          }
          setPendingDeleteSession(null)
        }}
        onCancel={() => setPendingDeleteSession(null)}
      />
    </>
  )
}
