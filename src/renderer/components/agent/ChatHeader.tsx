import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, ChevronDown, ChevronRight, MessageSquare, Minimize2, MoreHorizontal, PanelLeftClose, Pencil, Plus, Puzzle, RotateCcw, Trash2 } from 'lucide-react'
import { requestShellAction } from '../../modules/workbench/commands/shell-actions'
import { Button, IconButton, Input, MenuList, anchorOf, closeFloat, confirmDialog, isFloatOpen, openDialog, openMenu, type MenuEntry } from '../ui'
import { FloatPanel } from '../ui/float/FloatPanel'
import type { SessionRecallHit } from '../../../shared/session-recall'
import { SESSION_DOT_COLOR, recallStatusToDot, type SessionDotStatus } from './chat-panel/helpers/session-status'
import {
  CHAT_HEADER_MENU_META_STYLE,
  CHAT_HEADER_MENU_ROW_CLASS,
  CHAT_HEADER_MENU_SECTION_LABEL_STYLE,
  buildChatHeaderFloatingMenuStyle,
  buildChatHeaderMenuItemStyle,
} from './chatHeaderMenuStyles'
import { getChatMenuHorizontalFrame, subscribeChatMenuLayout } from './chatMenuLayout'
import type { LifecycleOperationProjectionV2 } from '../../../shared/ipc-contracts/agent-lifecycle-snapshot'

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
  lifecycleUncertainty: 'stop' | 'close' | 'reset' | 'compaction' | null
  lifecycleActions?: LifecycleOperationProjectionV2['actions'] | null
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
  width: number
}

// The "当前对话操作" menu is the shared menu (openMenu); its trigger carries this id as data-float-anchor so a
// second click on it closes the menu instead of reopening it.
const OPERATION_MENU_ID = 'chat-header-operations'
// The row "更多" menu holds the shared MenuList, which is at least this wide (.rn-menu).
const ROW_MENU_WIDTH = 200

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
  lifecycleActions = null,
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
  const [rowMenu, setRowMenu] = useState<{ conversationId: string; title: string; position: FloatingMenuPosition } | null>(null)
  const scopeTriggerRef = useRef<HTMLButtonElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const titleTriggerRef = useRef<HTMLButtonElement>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const rowMenuRef = useRef<HTMLDivElement>(null)
  const rowMenuTriggerRef = useRef<HTMLButtonElement | null>(null)
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
    const preferredLeft = align === 'left' ? rect.left : rect.right - menuWidth

    return {
      ...getChatMenuHorizontalFrame(headerRef.current || trigger, menuWidth, preferredLeft),
      top: Math.round(rect.bottom + 6),
    }
  }, [])

  const computeRowMenuPosition = useCallback((trigger: HTMLButtonElement | null): FloatingMenuPosition | null => (
    computeMenuPosition(trigger, ROW_MENU_WIDTH, 'right')
  ), [computeMenuPosition])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const clickedHistory = !!(
        historyMenuRef.current?.contains(target) ||
        titleTriggerRef.current?.contains(target) ||
        scopeTriggerRef.current?.contains(target) ||
        rowMenuRef.current?.contains(target)
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
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showHistory, rowMenu])

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
        if (position.left === current.position.left && position.top === current.position.top && position.width === current.position.width) {
          return current
        }
        return { ...current, position }
      })
      const trigger = historyMenuAnchor === 'scope' ? scopeTriggerRef.current : titleTriggerRef.current
      const align = historyMenuAnchor === 'scope' ? 'right' : 'left'
      setHistoryMenuPosition(computeMenuPosition(trigger, historyMenuWidth, align))
    }

    syncMenuPositions()
    return subscribeChatMenuLayout(headerRef.current, syncMenuPositions)
  }, [computeMenuPosition, computeRowMenuPosition, historyMenuAnchor, historyMenuWidth, showHistory])

  // The row menu is the shared MenuList inside the history panel: it takes focus when it opens so the arrow keys
  // and Enter steer it, and Escape closes it.
  useEffect(() => {
    if (!rowMenu) return
    rowMenuRef.current?.querySelector<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true })
  }, [rowMenu])

  const closeRowMenu = useCallback(() => {
    rowMenuTriggerRef.current = null
    setRowMenu(null)
  }, [])

  const operationsDisabled = !currentConversationAvailable
    || Boolean(lifecyclePendingAction)
    || (!lifecycleActions
      || (lifecycleActions.reset.availability !== 'ready'
        && lifecycleActions.manual_compact.availability !== 'ready'))

  // An open operation menu closes once its trigger turns unavailable, and with the header.
  useEffect(() => {
    if (operationsDisabled) closeFloat(OPERATION_MENU_ID)
  }, [operationsDisabled])
  useEffect(() => () => closeFloat(OPERATION_MENU_ID), [])

  const toggleOperationMenu = () => {
    if (isFloatOpen(OPERATION_MENU_ID)) {
      closeFloat(OPERATION_MENU_ID)
      return
    }
    const trigger = operationMenuTriggerRef.current
    if (!trigger) return
    openMenu(anchorOf(trigger), [
      {
        id: 'reset',
        label: '重置当前对话',
        icon: <RotateCcw />,
        disabled: lifecycleActions?.reset.availability !== 'ready',
        onSelect: () => { void onResetCurrentConversation() },
      },
      {
        id: 'compact',
        label: '压缩上下文',
        icon: <Minimize2 />,
        disabled: lifecycleActions?.manual_compact.availability !== 'ready',
        onSelect: () => { void onCompactCurrentSession() },
      },
    ], { id: OPERATION_MENU_ID, placement: 'bottom-end', label: '当前对话操作' })
  }

  const openRenameDialog = (conversationId: string, title: string) => {
    let value = title
    const save = () => {
      const next = value.trim()
      if (next) onRenameConversation?.(conversationId, next)
    }
    const dialogId = openDialog({
      title: '重命名会话',
      body: (
        <>
          <div>为这个会话取一个新名称：</div>
          <Input
            data-autofocus
            aria-label="会话名称"
            defaultValue={title}
            placeholder="会话名称"
            style={{ width: '100%', marginTop: 10 }}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => { value = event.target.value }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              save()
              closeFloat(dialogId)
            }}
          />
        </>
      ),
      actions: [
        { label: '取消', variant: 'ghost' },
        { label: '保存', variant: 'primary', onClick: save },
      ],
    })
  }

  const confirmDeleteSession = (conversationId: string, title: string) => {
    void confirmDialog({
      title: '删除会话',
      body: `确定删除会话 "${title}" 吗？此操作不可撤销。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true,
    }).then((confirmed) => {
      if (confirmed) onDeleteConversation(conversationId)
    })
  }

  const rowMenuItems = (menu: { conversationId: string; title: string }): MenuEntry[] => [
    {
      id: 'rename',
      label: '重命名',
      icon: <Pencil />,
      onSelect: () => {
        closeHistoryMenu()
        openRenameDialog(menu.conversationId, menu.title)
      },
    },
    {
      id: 'delete',
      label: '删除',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => {
        closeHistoryMenu()
        confirmDeleteSession(menu.conversationId, menu.title)
      },
    },
  ]

  const historyMenuStyle = {
    ...buildChatHeaderFloatingMenuStyle(historyMenuPosition?.width ?? historyMenuWidth),
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
        className={`${CHAT_HEADER_MENU_ROW_CLASS} w-full flex items-start gap-3 group`}
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
                  color: 'var(--rn-ink)',
                  paddingRight: 4,
                  overflow: 'hidden',
                  textOverflow: 'clip',
                  whiteSpace: 'nowrap',
                  WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
                  maskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)'
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
                  color: 'var(--rn-ink-3)',
                  marginTop: 4,
                  lineHeight: 1.45,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'clip',
                  WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
                  maskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)'
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
          {/* 20px row actions keep the row's geometry; an attached session reads as a pressed toggle. */}
          <IconButton
            size="sm"
            icon={<AtSign style={{ width: 13, height: 13 }} strokeWidth={2} />}
            onClick={(event) => {
              event.stopPropagation()
              if (attached) return
              onAttachSessionRecall(conv.conversationId)
            }}
            disabled={attached}
            active={attached}
            style={{ width: 20, height: 20, opacity: attached ? 1 : undefined }}
            title={attached ? '已引用到本轮' : '引用到本轮'}
          />
          <IconButton
            size="sm"
            icon={<MoreHorizontal style={{ width: 13, height: 13 }} strokeWidth={2} />}
            data-row-menu-trigger="true"
            aria-haspopup="menu"
            aria-expanded={rowMenu?.conversationId === conv.conversationId}
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
            style={{ width: 20, height: 20 }}
            title="更多"
            aria-label="更多操作"
          />
        </div>
      </div>
    )
  }

  return (
    <>
      <div
        ref={headerRef}
        className="flex items-center justify-between"
        style={{
          height: 38,
          padding: '0 14px',
          borderBottom: '1px solid transparent',
          background: 'transparent',
          position: 'relative',
          overflow: 'visible',
          zIndex: 20,
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
                  color: 'var(--rn-ink)',
                }}
              />
              <span
                style={{
                  display: 'block',
                  minWidth: 0,
                  flex: 1,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: 'var(--rn-ink)',
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'clip',
                  WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent 100%)',
                  maskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent 100%)',
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
            <span style={{ fontSize: 11, color: 'var(--rn-ink-3)', whiteSpace: 'nowrap' }}>
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
              style={{ fontSize: 11, color: 'var(--rn-warn)', whiteSpace: 'nowrap' }}
            >
              {{
                stop: '停止状态待确认',
                close: '关闭状态待确认',
                reset: '重置状态待确认',
                compaction: '压缩状态待确认',
              }[lifecycleUncertainty]}
            </span>
          )}

          {/* The skills centre belongs to the assistant: it opens as a page beside settings (W2 §2.3). */}
          <IconButton
            icon={<Puzzle style={{ width: 14, height: 14 }} strokeWidth={2} />}
            onClick={() => requestShellAction('open-skills')}
            title="技能中心"
          />

          <IconButton
            icon={<MoreHorizontal style={{ width: 14, height: 14 }} strokeWidth={2} />}
            onClick={toggleOperationMenu}
            data-float-anchor={OPERATION_MENU_ID}
            aria-haspopup="menu"
            disabled={operationsDisabled}
            title={lifecyclePendingAction
              ? '会话操作进行中'
              : lifecycleUncertainty === 'stop'
                ? '当前会话停止状态待确认'
                : lifecycleUncertainty === 'close'
                  ? '关闭状态待确认，可在会话列表重试关闭'
                  : lifecycleUncertainty === 'reset'
                    ? '重置状态待确认，可重试重置'
                : lifecycleUncertainty === 'compaction'
                  ? '压缩状态待确认，可重置当前对话'
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

      {portalRoot && showHistory && historyMenuPosition && createPortal(
        <FloatPanel
          ref={historyMenuRef}
          data-chat-header-menu="history"
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
            <Input
              value={sessionRecallQuery}
              onChange={(event) => onSessionRecallQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onSessionRecallSearch()
                }
              }}
              placeholder="搜旧会话标题、消息、任务摘要或附件名"
              aria-label="搜索旧会话"
              style={{
                minWidth: 0,
                width: '100%',
                maxWidth: '100%',
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
                paddingTop: 0
              }}
            >
              <Button
                variant="secondary"
                onClick={onSessionRecallSearch}
                style={{
                  width: 44,
                  height: 32,
                  padding: 0,
                  fontSize: 12
                }}
              >
                {sessionRecallSearching ? '搜索中…' : '搜索'}
              </Button>
            </div>
          </div>

          {attachedSessionRecallCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--rn-ink-3)', padding: '2px 12px 0' }}>
              当前轮已引用 {attachedSessionRecallCount} 条旧会话
            </div>
          )}

          {sessionRecallError && (
            <div style={{ fontSize: 11, color: 'var(--rn-bad)', padding: '0 12px' }}>
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
                      className={`${CHAT_HEADER_MENU_ROW_CLASS} w-full`}
                      data-selected={selected || undefined}
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
                              color: 'var(--rn-ink)',
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
                      <IconButton
                        size="sm"
                        icon={(
                          <ChevronRight
                            style={{
                              width: 14,
                              height: 14,
                              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                              transition: 'transform 160ms ease',
                            }}
                            strokeWidth={2}
                          />
                        )}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleChannelHistory(channel.key)
                        }}
                        title={expanded ? '收起历史会话' : '展开历史会话'}
                        aria-expanded={expanded}
                      />
                    </div>
                    {expanded && (
                      <div className="flex flex-col" style={{ gap: 6, paddingLeft: 8 }}>
                        {channelResults.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--rn-ink-3)', padding: '8px 8px 10px', textAlign: 'center' }}>
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
            <div style={{ fontSize: 12, color: 'var(--rn-ink-3)', padding: '12px 8px 10px', textAlign: 'center' }}>
              暂无会话来源
            </div>
          )}
        </FloatPanel>,
        document.body,
      )}

      {portalRoot && showHistory && rowMenu && createPortal(
        <FloatPanel
          ref={rowMenuRef}
          data-chat-header-menu="row"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            const trigger = rowMenuTriggerRef.current
            closeRowMenu()
            trigger?.focus()
          }}
          style={{
            ...buildChatHeaderFloatingMenuStyle(rowMenu.position.width),
            position: 'fixed',
            top: rowMenu.position.top,
            left: rowMenu.position.left,
            padding: 0,
            maxHeight: undefined,
            zIndex: 260,
          }}
        >
          <MenuList items={rowMenuItems(rowMenu)} label="会话操作" onDone={closeRowMenu} />
        </FloatPanel>,
        document.body,
      )}
    </>
  )
}
