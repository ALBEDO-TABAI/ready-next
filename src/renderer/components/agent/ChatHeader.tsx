import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, ChevronDown, ChevronRight, MessageSquare, Minimize2, MoreHorizontal, PanelLeftClose, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { LiquidFloatingPanel } from '../ui/liquid-glass/LiquidFloatingPanel'
import Modal from '../ui/Modal'
import type { SessionRecallHit } from '../../../shared/session-recall'
import { SESSION_DOT_COLOR, recallStatusToDot, type SessionDotStatus } from './chat-panel/helpers/session-status'
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
  onChannelSelect: (channel: ConversationChannelOption) => void | Promise<void>
  onNewSession: () => void | Promise<unknown>
  onResetCurrentConversation: () => void | Promise<void>
  onCompactCurrentSession: () => void | Promise<void>
  currentConversationAvailable: boolean
  lifecyclePendingAction: 'creating' | 'resetting' | 'stopping' | 'closing' | 'compacting' | null
  lifecycleUncertainty: 'interrupt' | 'compaction' | null
  /** Per-channel live sessions (keyed by `${sourceKind}:${sourceId}`), newest
   *  first. Drives the expanded history list so every session — including a
   *  fresh remote `/new` — is individually selectable. */
  sessionsByChannelKey: Record<string, SessionRecallHit[]>
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
  onTogglePanel?: () => void
  onHistoryOpen?: () => void
  sessionTitle?: string
  formatAgentName?: (agentId: string) => string
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
  onNewSession,
  onResetCurrentConversation,
  onCompactCurrentSession,
  currentConversationAvailable,
  lifecyclePendingAction,
  lifecycleUncertainty,
  sessionsByChannelKey,
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
  onTogglePanel,
  onHistoryOpen,
  sessionTitle,
  formatAgentName,
  formatTime,
}: ChatHeaderProps) {
  const [showHistory, setShowHistory] = useState(false)
  const [historyMenuPosition, setHistoryMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const [historyMenuAnchor, setHistoryMenuAnchor] = useState<'title' | 'scope'>('title')
  const [expandedChannelKeys, setExpandedChannelKeys] = useState<string[]>([])
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ conversationId: string; title: string } | null>(null)
  const [pendingRenameSession, setPendingRenameSession] = useState<{ conversationId: string; title: string } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ conversationId: string; title: string; position: FloatingMenuPosition } | null>(null)
  const [operationMenuPosition, setOperationMenuPosition] = useState<FloatingMenuPosition | null>(null)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const titleTriggerRef = useRef<HTMLButtonElement>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const rowMenuRef = useRef<HTMLDivElement>(null)
  const rowMenuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const operationMenuRef = useRef<HTMLDivElement>(null)
  const operationMenuTriggerRef = useRef<HTMLButtonElement>(null)
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

  const computeRowMenuPosition = useCallback((trigger: HTMLButtonElement | null): FloatingMenuPosition | null => (
    computeMenuPosition(trigger, 140, 'right')
  ), [computeMenuPosition])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const clickedHistory = !!(
        historyMenuRef.current?.contains(target) ||
        titleTriggerRef.current?.contains(target) ||
        scopeTriggerRef.current?.contains(target) ||
        rowMenuRef.current?.contains(target) ||
        operationMenuRef.current?.contains(target) ||
        operationMenuTriggerRef.current?.contains(target)
      )

      if (showHistory && !clickedHistory) {
        setShowHistory(false)
        setHistoryMenuPosition(null)
      }
      if (rowMenu) {
        const clickedRowMenu = !!(
          rowMenuRef.current?.contains(target) ||
          (target instanceof Element && target.closest('[data-row-menu-trigger="true"]'))
        )
        if (!clickedRowMenu) {
          rowMenuTriggerRef.current = null
          setRowMenu(null)
        }
      }
      if (
        operationMenuPosition
        && !operationMenuRef.current?.contains(target)
        && !operationMenuTriggerRef.current?.contains(target)
      ) {
        setOperationMenuPosition(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [operationMenuPosition, showHistory, rowMenu])

  // Close the per-row "更多" menu whenever the history dropdown closes, so a
  // detached menu never lingers after the list it belongs to is gone.
  useEffect(() => {
    if (!showHistory) {
      rowMenuTriggerRef.current = null
      setRowMenu(null)
    }
  }, [showHistory])

  const closeHistoryMenu = useCallback(() => {
    setShowHistory(false)
    setHistoryMenuPosition(null)
    rowMenuTriggerRef.current = null
    setRowMenu(null)
  }, [])

  const handleHistoryToggle = useCallback((anchor: 'title' | 'scope') => {
    const trigger = anchor === 'scope' ? scopeTriggerRef.current : titleTriggerRef.current
    const align = anchor === 'scope' ? 'right' : 'left'
    setHistoryMenuAnchor(anchor)
    setShowHistory((prev) => {
      const next = !prev
      setHistoryMenuPosition(next ? computeMenuPosition(trigger, historyMenuWidth, align) : null)
      if (next) {
        setExpandedChannelKeys((current) =>
          current.includes(currentChannel.key) ? current : [...current, currentChannel.key],
        )
      }
      return next
    })
  }, [computeMenuPosition, currentChannel.key, historyMenuWidth])

  // Both header entry points open the same source/history switcher.
  const handleHistoryButtonClick = useCallback(() => {
    if (!showHistory) onHistoryOpen?.()
    handleHistoryToggle('title')
  }, [showHistory, onHistoryOpen, handleHistoryToggle])

  const handleScopeButtonClick = useCallback(() => {
    if (!showHistory) onHistoryOpen?.()
    handleHistoryToggle('scope')
  }, [showHistory, onHistoryOpen, handleHistoryToggle])

  const toggleChannelHistory = useCallback((channelKey: string) => {
    setExpandedChannelKeys((current) =>
      current.includes(channelKey)
        ? current.filter((key) => key !== channelKey)
        : [...current, channelKey],
    )
  }, [])

  useEffect(() => {
    if (!showHistory) return

    const syncMenuPositions = () => {
      setRowMenu((current) => {
        if (!current) return current
        const rowTrigger = rowMenuTriggerRef.current
        if (!rowTrigger || !document.body.contains(rowTrigger)) {
          rowMenuTriggerRef.current = null
          return null
        }
        const position = computeRowMenuPosition(rowTrigger)
        if (!position) {
          rowMenuTriggerRef.current = null
          return null
        }
        if (position.left === current.position.left && position.top === current.position.top) {
          return current
        }
        return { ...current, position }
      })
      const trigger = historyMenuAnchor === 'scope' ? scopeTriggerRef.current : titleTriggerRef.current
      const align = historyMenuAnchor === 'scope' ? 'right' : 'left'
      setHistoryMenuPosition(computeMenuPosition(trigger, historyMenuWidth, align))
    }

    syncMenuPositions()
    const unsubscribeWindowResize = subscribeWorkbenchWindowResize(syncMenuPositions)
    window.addEventListener('scroll', syncMenuPositions, true)
    return () => {
      unsubscribeWindowResize()
      window.removeEventListener('scroll', syncMenuPositions, true)
    }
  }, [computeMenuPosition, computeRowMenuPosition, historyMenuAnchor, historyMenuWidth, showHistory])

  const historyMenuStyle = {
    ...buildChatHeaderFloatingMenuStyle(historyMenuWidth),
    position: 'fixed' as const,
    top: historyMenuPosition?.top ?? 0,
    left: historyMenuPosition?.left ?? 0,
    maxHeight: 420,
    overflow: 'hidden',
  }

  const renderConversationRow = (conv: SessionRecallHit) => {
    const attached = attachedSessionRecallConversationIds.includes(conv.conversationId)
    const conversationSummary =
      conv.hitExcerpt?.trim() ||
      conv.latestTaskSummary?.trim() ||
      conv.resumeTitle?.trim() ||
      ''
    const dotStatus: SessionDotStatus = sessionStatusByConversationId?.[conv.conversationId] ?? recallStatusToDot(conv.sessionStatus)
    const dotColor = SESSION_DOT_COLOR[dotStatus]
    const responsibleAgent = conv.activeAgentId && conv.activeAgentId !== conv.agentId
      ? formatAgentName?.(conv.activeAgentId) ?? conv.activeAgentId
      : null

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
            closeHistoryMenu()
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {responsibleAgent ? (
                  <span data-chat-session-responsible-agent="true">{responsibleAgent}</span>
                ) : null}
                <span>{formatTime(conv.updatedAt)}</span>
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
              const trigger = event.currentTarget
              setRowMenu((prev) => {
                if (prev?.conversationId === conv.conversationId) {
                  rowMenuTriggerRef.current = null
                  return null
                }
                rowMenuTriggerRef.current = trigger
                const position = computeRowMenuPosition(trigger)
                if (!position) return null
                return {
                  conversationId: conv.conversationId,
                  title: conv.title || '新对话',
                  position,
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
        <div className="min-w-0 flex-1" data-chat-session-title="true">
          {sessionTitle ? (
            <button
              ref={titleTriggerRef}
              type="button"
              onClick={handleHistoryButtonClick}
              title={sessionTitle}
              aria-label={`当前会话：${sessionTitle}，点击查看历史对话`}
              className="active:scale-[0.99] transition-transform duration-150"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                maxWidth: '100%',
                width: '100%',
                height: '100%',
                border: 'none',
                background: 'transparent',
                padding: '6px 10px 6px 0',
                cursor: 'pointer',
                overflow: 'hidden',
              }}
            >
              <ChevronDown
                style={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  transform: showHistory ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 200ms ease',
                  color: 'var(--text-body)',
                }}
              />
              <span
                style={{
                  display: 'block',
                  minWidth: 0,
                  flex: 1,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: 'var(--text-body)',
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
        </div>

        <div className="flex items-center" style={{ gap: 4, marginRight: -5 }} data-chat-session-menu="true">
          <div className="relative" data-chat-session-switcher="true">
            <IconButton
              icon={<MessageSquare style={{ width: 14, height: 14 }} strokeWidth={2} />}
              onClick={handleScopeButtonClick}
              title="会话来源"
              active={showHistory}
              ref={scopeTriggerRef}
            />
          </div>

          <IconButton
            icon={<Plus style={{ width: 14, height: 14 }} strokeWidth={2} />}
            onClick={() => { void onNewSession() }}
            title="新建对话"
          />

          {lifecyclePendingAction && (
            <span style={{ fontSize: 11, color: 'var(--text-light)', whiteSpace: 'nowrap' }}>
              {{
                creating: '正在创建…',
                resetting: '正在重置…',
                stopping: '正在停止…',
                closing: '正在关闭…',
                compacting: '正在压缩…',
              }[lifecyclePendingAction]}
            </span>
          )}

          {!lifecyclePendingAction && lifecycleUncertainty && (
            <span
              data-codex-lifecycle-uncertain={lifecycleUncertainty}
              style={{ fontSize: 11, color: 'var(--color-orange, #f59e0b)', whiteSpace: 'nowrap' }}
            >
              {lifecycleUncertainty === 'interrupt' ? '停止状态待确认' : '压缩状态待确认'}
            </span>
          )}

          <IconButton
            icon={<MoreHorizontal style={{ width: 14, height: 14 }} strokeWidth={2} />}
            onClick={() => {
              setOperationMenuPosition((current) => current
                ? null
                : computeMenuPosition(operationMenuTriggerRef.current, 176, 'right'))
            }}
            disabled={!currentConversationAvailable || Boolean(lifecyclePendingAction) || Boolean(lifecycleUncertainty)}
            title={lifecyclePendingAction
              ? '会话操作进行中'
              : lifecycleUncertainty
                ? '当前会话状态待确认，请新建对话'
                : '当前对话操作'}
            ref={operationMenuTriggerRef}
          />

          {onTogglePanel && (
            <IconButton
              icon={<PanelLeftClose style={{ width: 14, height: 14 }} strokeWidth={2} />}
              onClick={onTogglePanel}
              title="收起/展开聊天面板"
            />
          )}
        </div>
      </div>

      {portalRoot && operationMenuPosition && createPortal(
        <LiquidFloatingPanel
          ref={operationMenuRef}
          className="chat-header-floating-menu"
          style={{
            ...buildChatHeaderFloatingMenuStyle(176),
            position: 'fixed',
            top: operationMenuPosition.top,
            left: operationMenuPosition.left,
            padding: 6,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setOperationMenuPosition(null)
              void onResetCurrentConversation()
            }}
            className="chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-2"
            style={buildChatHeaderMenuItemStyle({ selected: false })}
          >
            <RotateCcw style={{ width: 14, height: 14 }} strokeWidth={2} />
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>重置当前对话</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOperationMenuPosition(null)
              void onCompactCurrentSession()
            }}
            className="chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-2"
            style={buildChatHeaderMenuItemStyle({ selected: false })}
          >
            <Minimize2 style={{ width: 14, height: 14 }} strokeWidth={2} />
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>压缩上下文</span>
          </button>
        </LiquidFloatingPanel>,
        portalRoot,
      )}

      {portalRoot && showHistory && historyMenuPosition && createPortal(
        <LiquidFloatingPanel
          ref={historyMenuRef}
          className="chat-header-floating-menu"
          style={historyMenuStyle}
        >
          <div style={CHAT_HEADER_MENU_SECTION_LABEL_STYLE}>会话来源</div>
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
              className="rounded-[8px] border"
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
                className="rounded-[8px] border transition-[background-color,border-color,color]"
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

          {channelOptions.length > 0 && (
            <div
              className="panel-hover-scrollbar flex flex-col"
              style={{ gap: 8, maxHeight: 300, overflow: 'auto', scrollbarGutter: 'stable' }}
            >
              {channelOptions.map((channel) => {
                const expanded = expandedChannelKeys.includes(channel.key)
                const selected = currentChannel.key === channel.key
                // With a query: show recall search hits. Without: show this
                // channel's live sessions so every distinct conversation —
                // including a fresh remote `/new` — is individually selectable
                // (channelOptions itself dedupes one entry per source).
                const hasQuery = sessionRecallQuery.trim().length > 0
                const channelResults = hasQuery
                  ? sessionRecallResults.filter(
                      (item) => item.sourceKind === channel.sourceKind && item.sourceId === channel.sourceId,
                    )
                  : (sessionsByChannelKey[channel.key] || [])
                return (
                  <div
                    key={channel.key}
                    className="flex flex-col"
                    style={{ gap: expanded ? 6 : 0 }}
                  >
                    <div
                      className={`chat-header-floating-menu-item ready-floating-menu-item w-full active:scale-[0.98] transition-[background-color,border-color,box-shadow,transform] duration-150 ${selected ? 'is-selected' : ''}`}
                      style={{
                        ...buildChatHeaderMenuItemStyle({ selected }),
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) 26px',
                        alignItems: 'center',
                        gap: 8,
                        minHeight: 54,
                        padding: '9px 8px 9px 12px',
                        overflow: 'hidden',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onChannelSelect(channel)
                          closeHistoryMenu()
                        }}
                        style={{
                          minWidth: 0,
                          border: 'none',
                          background: 'transparent',
                          padding: 0,
                          cursor: 'pointer',
                          textAlign: 'left',
                          width: '100%',
                          overflow: 'hidden',
                        }}
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
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleChannelHistory(channel.key)
                        }}
                        className="chat-header-menu-delete-button transition-[background-color,color,opacity]"
                        style={{
                          ...CHAT_HEADER_MENU_DELETE_BUTTON_STYLE,
                          width: 24,
                          height: 24,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-gray)',
                          opacity: 0.82,
                        }}
                        title={expanded ? '收起历史会话' : '展开历史会话'}
                        aria-label={expanded ? '收起历史会话' : '展开历史会话'}
                        aria-expanded={expanded}
                      >
                        <ChevronRight
                          style={{
                            width: 14,
                            height: 14,
                            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                            transition: 'transform 160ms ease',
                          }}
                          strokeWidth={2}
                        />
                      </button>
                    </div>
                    {expanded && (
                      <div className="flex flex-col" style={{ gap: 6, paddingLeft: 8 }}>
                        {channelResults.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--text-gray)', padding: '8px 8px 10px', textAlign: 'center' }}>
                            {sessionRecallSearching ? '搜索中…' : sessionRecallQuery.trim() ? '这个来源没有匹配的旧会话' : '这个来源暂无会话'}
                          </div>
                        ) : (
                          channelResults.map(renderConversationRow)
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {channelOptions.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-gray)', padding: '12px 8px 10px', textAlign: 'center' }}>
              暂无会话来源
            </div>
          )}
        </LiquidFloatingPanel>,
        document.body,
      )}

      {portalRoot && showHistory && rowMenu && createPortal(
        <LiquidFloatingPanel
          ref={rowMenuRef}
          className="chat-header-floating-menu"
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
              rowMenuTriggerRef.current = null
              setRowMenu(null)
              closeHistoryMenu()
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
              rowMenuTriggerRef.current = null
              setRowMenu(null)
              closeHistoryMenu()
            }}
            className="chat-header-floating-menu-item ready-floating-menu-item w-full flex items-center gap-2 active:scale-[0.98] transition-[background-color,border-color,box-shadow,transform] duration-150"
            style={buildChatHeaderMenuItemStyle()}
          >
            <Trash2 style={{ width: 13, height: 13, flexShrink: 0, color: 'var(--color-red)' }} strokeWidth={2} />
            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--color-red)' }}>删除</span>
          </button>
        </LiquidFloatingPanel>,
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
