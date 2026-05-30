import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, History, Plus, ChevronDown, MoreHorizontal, Pencil, Trash2, PanelRightClose } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import Modal from '../ui/Modal'
import type { SessionRecallHit } from '../../../shared/session-recall'
import { SESSION_DOT_COLOR, type SessionDotStatus } from './chat-panel/helpers/session-status'
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
  onRenameConversation?: (conversationId: string, title: string) => void
  sessionStatusByConversationId?: Record<string, SessionDotStatus>
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
  sessionTitle?: string
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
  onRenameConversation,
  sessionStatusByConversationId,
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
  sessionTitle,
  formatTime,
}: ChatHeaderProps) {
  const [showScopeSelect, setShowScopeSelect] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [scopeMenuPosition, setScopeMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const [historyMenuPosition, setHistoryMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ conversationId: string; title: string } | null>(null)
  const [pendingRenameSession, setPendingRenameSession] = useState<{ conversationId: string; title: string } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ conversationId: string; title: string; position: FloatingMenuPosition } | null>(null)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const titleTriggerRef = useRef<HTMLButtonElement>(null)
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const rowMenuRef = useRef<HTMLDivElement>(null)
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
        historyMenuRef.current?.contains(target) ||
        titleTriggerRef.current?.contains(target) ||
        rowMenuRef.current?.contains(target)
      )

      if (showScopeSelect && !clickedScope) {
        setShowScopeSelect(false)
        setScopeMenuPosition(null)
      }
      if (showHistory && !clickedHistory) {
        setShowHistory(false)
        setHistoryMenuPosition(null)
      }
      if (rowMenu) {
        const clickedRowMenu = !!(
          rowMenuRef.current?.contains(target) ||
          (target instanceof Element && target.closest('[data-row-menu-trigger="true"]'))
        )
        if (!clickedRowMenu) setRowMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showHistory, showScopeSelect, rowMenu])

  // Close the per-row "更多" menu whenever the history dropdown closes, so a
  // detached menu never lingers after the list it belongs to is gone.
  useEffect(() => {
    if (!showHistory) setRowMenu(null)
  }, [showHistory])

  const handleHistoryToggle = useCallback(() => {
    setShowHistory((prev) => {
      const next = !prev
      setHistoryMenuPosition(next ? computeMenuPosition(historyTriggerRef.current, historyMenuWidth, 'right') : null)
      return next
    })
  }, [computeMenuPosition, historyMenuWidth])

  // Shared by the History icon button and the session-title button: opening
  // (re)loads the history list, and closing the scope menu keeps a single
  // floating menu open at a time.
  const handleHistoryButtonClick = useCallback(() => {
    if (!showHistory) onHistoryOpen?.()
    handleHistoryToggle()
    setShowScopeSelect(false)
    setScopeMenuPosition(null)
  }, [showHistory, onHistoryOpen, handleHistoryToggle])

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
      // A fixed-positioned row menu detaches from its trigger on scroll/resize.
      setRowMenu(null)
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

        {sessionTitle ? (
          <button
            ref={titleTriggerRef}
            type="button"
            onClick={handleHistoryButtonClick}
            title={sessionTitle}
            aria-label={`当前会话：${sessionTitle}，点击查看历史对话`}
            className="active:scale-[0.99] transition-transform duration-150"
            style={{
              flex: 1,
              minWidth: 0,
              margin: '0 10px',
              display: 'flex',
              alignItems: 'center',
              height: '100%',
              border: 'none',
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                width: '100%',
                fontSize: 12.5,
                fontWeight: 500,
                color: 'var(--text-light)',
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'clip',
                WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent 100%)',
                maskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent 100%)',
              }}
            >
              {sessionTitle}
            </span>
          </button>
        ) : null}

        <div className="flex items-center" style={{ gap: 4 }} data-chat-session-menu="true">
          <IconButton
            icon={<PanelRightClose style={{ width: 14, height: 14 }} strokeWidth={2} />}
            onClick={onTogglePanel}
            title="折叠聊天面板"
          />

          <div className="relative">
            <IconButton
              icon={<History style={{ width: 14, height: 14 }} strokeWidth={2} />}
              onClick={handleHistoryButtonClick}
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
                const dotStatus: SessionDotStatus = sessionStatusByConversationId?.[conv.conversationId] ?? 'off'
                const dotColor = SESSION_DOT_COLOR[dotStatus]
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
                      minHeight: 64,
                      padding: '12px 12px',
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
                        justifyContent: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{ minWidth: 0, width: '100%', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, width: '100%' }}>
                          <span
                            aria-hidden="true"
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              flexShrink: 0,
                              background: dotColor,
                              boxShadow: dotStatus === 'off' ? 'none' : `0 0 5px ${dotColor}`,
                            }}
                          />
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 12.5,
                              fontWeight: 600,
                              lineHeight: 1.3,
                              color: 'var(--text-body)',
                              paddingRight: 4,
                              overflow: 'hidden',
                              textOverflow: 'clip',
                              whiteSpace: 'nowrap',
                              WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)',
                              maskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)'
                            }}
                          >
                            {conv.title || '新对话'}
                          </div>
                          <div
                            style={{
                              ...CHAT_HEADER_MENU_META_STYLE,
                              marginTop: 0,
                              flexShrink: 0,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {formatTime(conv.updatedAt)}
                          </div>
                        </div>
                        {conversationSummary && (
                          <div
                            style={{
                              marginLeft: 14,
                              fontSize: 11,
                              color: 'var(--text-light)',
                              marginTop: 4,
                              lineHeight: 1.45,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'clip',
                              WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)',
                              maskImage: 'linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)'
                            }}
                          >
                            {conversationSummary}
                          </div>
                        )}
                      </div>
                    </button>
                    <div
                      className="flex items-center"
                      style={{
                        flexShrink: 0,
                        alignSelf: 'center',
                        gap: 2,
                      }}
                    >
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (attached) return
                          onAttachSessionRecall(conv.conversationId)
                        }}
                        disabled={attached}
                        className="chat-header-menu-delete-button transition-[background-color,color,opacity]"
                        style={{
                          ...CHAT_HEADER_MENU_DELETE_BUTTON_STYLE,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: attached ? 'default' : 'pointer',
                          color: attached ? 'var(--color-blue)' : 'var(--text-gray)',
                          opacity: attached ? 0.95 : 0.72,
                        }}
                        title={attached ? '已引用到本轮' : '引用到本轮'}
                        aria-label={attached ? '已引用到本轮' : '引用到本轮'}
                      >
                        <AtSign style={{ width: 13, height: 13 }} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        data-row-menu-trigger="true"
                        onClick={(event) => {
                          event.stopPropagation()
                          const rect = event.currentTarget.getBoundingClientRect()
                          setRowMenu((prev) => {
                            if (prev?.conversationId === conv.conversationId) return null
                            const menuWidth = 140
                            const margin = 8
                            const left = Math.max(
                              margin,
                              Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin),
                            )
                            return {
                              conversationId: conv.conversationId,
                              title: conv.title || '新对话',
                              position: { left: Math.round(left), top: Math.round(rect.bottom + 6) },
                            }
                          })
                        }}
                        className="chat-header-menu-delete-button transition-[background-color,color,opacity]"
                        style={{
                          ...CHAT_HEADER_MENU_DELETE_BUTTON_STYLE,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-gray)',
                          opacity: 0.72,
                        }}
                        title="更多"
                        aria-label="更多操作"
                      >
                        <MoreHorizontal style={{ width: 13, height: 13 }} strokeWidth={2} />
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

      {portalRoot && showHistory && rowMenu && createPortal(
        <div
          ref={rowMenuRef}
          className="glass-surface-floating chat-header-floating-menu ready-floating-menu"
          style={{
            ...buildChatHeaderFloatingMenuStyle(140),
            position: 'fixed',
            top: rowMenu.position.top,
            left: rowMenu.position.left,
            padding: 6,
            maxHeight: undefined,
            zIndex: 260,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setPendingRenameSession({ conversationId: rowMenu.conversationId, title: rowMenu.title })
              setRowMenu(null)
              setShowHistory(false)
            }}
            className="chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-2 active:scale-[0.98] transition-[background-color,border-color,box-shadow,transform] duration-150"
            style={buildChatHeaderMenuItemStyle()}
          >
            <Pencil style={{ width: 13, height: 13, flexShrink: 0, color: 'var(--text-light)' }} strokeWidth={2} />
            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-body)' }}>重命名</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingDeleteSession({ conversationId: rowMenu.conversationId, title: rowMenu.title })
              setRowMenu(null)
              setShowHistory(false)
            }}
            className="chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-2 active:scale-[0.98] transition-[background-color,border-color,box-shadow,transform] duration-150"
            style={buildChatHeaderMenuItemStyle()}
          >
            <Trash2 style={{ width: 13, height: 13, flexShrink: 0, color: 'var(--color-red)' }} strokeWidth={2} />
            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--color-red)' }}>删除</span>
          </button>
        </div>,
        document.body,
      )}

      <Modal
        open={pendingDeleteSession !== null}
        mode="confirm"
        danger
        dimBackdrop={false}
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

      <Modal
        open={pendingRenameSession !== null}
        mode="prompt"
        dimBackdrop={false}
        title="重命名会话"
        message="为这个会话取一个新名称："
        defaultValue={pendingRenameSession?.title ?? ''}
        placeholder="会话名称"
        confirmLabel="保存"
        cancelLabel="取消"
        onConfirm={(value) => {
          const next = (value ?? '').trim()
          if (pendingRenameSession && next) {
            onRenameConversation?.(pendingRenameSession.conversationId, next)
          }
          setPendingRenameSession(null)
        }}
        onCancel={() => setPendingRenameSession(null)}
      />
    </>
  )
}
