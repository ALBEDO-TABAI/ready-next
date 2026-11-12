import { forwardRef, useRef, useEffect, useState, useImperativeHandle, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, Plus, Square, ChevronDown, ImagePlus, LoaderCircle, Puzzle, ShieldCheck } from 'lucide-react'
import { LiquidLens } from '../ui/liquid-glass/LiquidLens'
import { LiquidBackdropProjection } from '../ui/liquid-glass/LiquidBackdropProjection'
import { FloatPanel } from '../ui/float/FloatPanel'
import { useTheme } from '../../stores/useTheme'
import type { ChatAttachment } from '../../stores/useAgent'
import type { ReadySkillReference } from '../../modules/agent/chat-input-bridge'
import type { ContextUsageSnapshot } from '../../../shared/context-usage-types'
import { CHAT_MENU_ITEM_CLASS, chatMenuItemStyle, chatMenuSurfaceStyle } from './chatMenuStyles'
import { getChatMenuHorizontalFrame, subscribeChatMenuLayout } from './chatMenuLayout'
import { ContextUsageMeter } from './chat-panel/ContextUsageMeter'
import { usePastedImages } from './chat-panel/use-pasted-images'
import type { ActionAuthorizationMode } from '../../../shared/action-authorization-mode'
import {
  buildSlashSkillInsertion,
  buildSlashCommandInsertion,
  filterSlashSkills,
  type SkillMenuItem,
} from '../../modules/agent/slash-skill-selection'
import {
  deriveComposerState,
  type ComposerSendBlocker,
} from '../../modules/agent/composer-state'

interface ChatInputProps {
  inputValue: string
  stopAvailable: boolean
  lifecycleInputBlocked: boolean
  sendBlocker?: ComposerSendBlocker | null
  destructiveOperationPending?: boolean
  stopPending: boolean
  stopError: string | null
  attachmentsCount: number
  hasUserMessages: boolean
  isDragOver: boolean
  contextUsage: ContextUsageSnapshot | null
  composerShellStyle: React.CSSProperties
  filePool: ChatAttachment[]
  filePoolCount: number
  isChannelScope: boolean
  actionAuthorizationMode: ActionAuthorizationMode
  onInputChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onPickFiles: () => void
  onActionAuthorizationModeChange: (mode: ActionAuthorizationMode) => void | Promise<void>
  onSkillReference: (skill: ReadySkillReference) => void
  onReferenceSelect: (attachment: ChatAttachment) => void
  renderAttachmentIcon: (attachment: ChatAttachment, size?: number) => React.ReactNode
  ModelSelector: React.ComponentType
  admissionReady?: boolean
}

interface ComposerMenuFrame {
  left: number
  bottom: number
  width: number
  maxHeight: number
}

interface AuthorizationMenuFrame {
  left: number
  bottom: number
  width: number
}

export interface ChatInputHandle {
  focusWithResize: () => void
  resetHeight: () => void
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  inputValue,
  stopAvailable,
  lifecycleInputBlocked,
  sendBlocker = null,
  destructiveOperationPending = false,
  stopPending,
  stopError,
  attachmentsCount,
  hasUserMessages,
  isDragOver,
  contextUsage,
  composerShellStyle,
  filePool,
  filePoolCount,
  isChannelScope,
  actionAuthorizationMode,
  onInputChange,
  onSend,
  onStop,
  onPickFiles,
  onActionAuthorizationModeChange,
  onSkillReference,
  onReferenceSelect,
  renderAttachmentIcon,
  ModelSelector,
  admissionReady = true,
}: ChatInputProps, ref) {
  const reducedTransparency = useTheme(state => state.transparency === 'reduced')
  const [showAuthorizationModeSelect, setShowAuthorizationModeSelect] = useState(false)
  const [authorizationModeUpdating, setAuthorizationModeUpdating] = useState(false)
  const [showAtMenu, setShowAtMenu] = useState(false)
  const [atFilter, setAtFilter] = useState('')
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [skills, setSkills] = useState<SkillMenuItem[]>([])
  const [composerMenuFrame, setComposerMenuFrame] = useState<ComposerMenuFrame | null>(null)
  const [authorizationMenuFrame, setAuthorizationMenuFrame] = useState<AuthorizationMenuFrame | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const authorizationModeRef = useRef<HTMLDivElement>(null)
  const authorizationMenuRef = useRef<HTMLDivElement>(null)
  const atMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const { onPaste, isPasting, pasteError } = usePastedImages()
  const hasSendableContent = Boolean(inputValue.trim() || attachmentsCount > 0)
  const composerState = deriveComposerState({
    hasSendableContent,
    sendAvailability: admissionReady && !lifecycleInputBlocked && !isPasting ? 'ready' : 'blocked',
    blocker: isPasting ? 'attachment_importing' : !admissionReady ? 'head_unavailable' : sendBlocker,
    authorizationModeUpdating,
    destructiveOperationPending,
    exactStopIntentAvailable: stopAvailable,
  })
  const composerLocked = !composerState.editable
  const sendBlockedReason = isPasting ? '正在添加图片' : !admissionReady
    ? '还没有可用的对话，请稍候或新建对话'
    : authorizationModeUpdating
      ? '正在更新授权方式'
      : lifecycleInputBlocked
        ? '当前会话暂时不能发送，你仍可继续编辑草稿'
      : ''
  const sendUnavailable = Boolean(sendBlockedReason)
  const sendDisabled = !composerState.sendEnabled

  const syncComposerMenuFrame = useCallback(() => {
    const textarea = textareaRef.current
    const shell = textarea?.closest('[data-chat-composer-shell="true"]') as HTMLElement | null
    if (!shell) return

    const rect = shell.getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
    const margin = 12
    const width = Math.max(240, Math.min(rect.width, viewportWidth - margin * 2))
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin))

    setComposerMenuFrame({
      left: Math.round(left),
      bottom: Math.max(margin, Math.round(viewportHeight - rect.top + 6)),
      width: Math.round(width),
      maxHeight: Math.max(180, Math.round(rect.top - margin - 6)),
    })
  }, [])

  const syncAuthorizationMenuFrame = useCallback(() => {
    const anchor = authorizationModeRef.current
    if (!anchor) return
    const shell = anchor.closest<HTMLElement>('[data-chat-composer-shell="true"]') || anchor
    const rect = shell.getBoundingClientRect()
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
    const margin = 12
    setAuthorizationMenuFrame({
      ...getChatMenuHorizontalFrame(anchor, Math.min(280, rect.width), rect.left),
      bottom: Math.max(margin, Math.round(viewportHeight - rect.top + 6)),
    })
  }, [])

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

  const loadSkills = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI?.skills : null
    if (!api?.list) return
    const result = await api.list().catch(() => null)
    if (!result?.success || !Array.isArray(result.data)) return
    const nextSkills = result.data
      .map((item: unknown): SkillMenuItem | null => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const id = String(record.id || '').trim()
        const name = String(record.name || id).trim()
        if (!id || !name) return null
        return {
          id,
          name,
          description: String(record.description || ''),
          installed: record.installed !== false,
          manifestValid: record.manifestValid !== false,
          defaultAction: typeof record.defaultAction === 'string' ? record.defaultAction : undefined,
          managedPath: typeof record.managedPath === 'string' ? record.managedPath : undefined,
          sourcePath: typeof record.sourcePath === 'string' ? record.sourcePath : undefined,
        }
      })
      .filter((item): item is SkillMenuItem => Boolean(item && item.manifestValid))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    setSkills(nextSkills)
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  // Auto-resize textarea
  useEffect(() => {
    resizeTextarea()
  }, [inputValue, resizeTextarea])

  useEffect(() => {
    if (!showAtMenu && !showSlashMenu) return
    syncComposerMenuFrame()
    window.addEventListener('resize', syncComposerMenuFrame)
    window.addEventListener('scroll', syncComposerMenuFrame, true)
    return () => {
      window.removeEventListener('resize', syncComposerMenuFrame)
      window.removeEventListener('scroll', syncComposerMenuFrame, true)
    }
  }, [showAtMenu, showSlashMenu, syncComposerMenuFrame])

  useEffect(() => {
    if (!showAuthorizationModeSelect) return
    syncAuthorizationMenuFrame()
    return subscribeChatMenuLayout(
      authorizationModeRef.current?.closest<HTMLElement>('[data-chat-composer-shell="true"]') ?? null,
      syncAuthorizationMenuFrame,
    )
  }, [showAuthorizationModeSelect, syncAuthorizationMenuFrame])

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        showAuthorizationModeSelect
        && !authorizationModeRef.current?.contains(e.target as Node)
        && !authorizationMenuRef.current?.contains(e.target as Node)
      ) {
        setShowAuthorizationModeSelect(false)
      }
      if (showAtMenu && atMenuRef.current && !atMenuRef.current.contains(e.target as Node)) {
        setShowAtMenu(false)
        setAtFilter('')
      }
      if (showSlashMenu && slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setShowSlashMenu(false)
        setSlashFilter('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAtMenu, showAuthorizationModeSelect, showSlashMenu])

  const authorizationModeOptions: Array<{
    mode: ActionAuthorizationMode
    label: string
    description: string
  }> = [
    { mode: 'ask', label: '询问授权', description: '每个外部写入都先问我' },
    { mode: 'auto', label: '替我决定', description: '普通小操作由 Ready 决定' },
    { mode: 'full', label: '全部授权', description: '放行可委托动作，高危步骤仍会询问' },
  ]
  const currentAuthorizationMode = authorizationModeOptions.find(
    (option) => option.mode === actionAuthorizationMode,
  ) || authorizationModeOptions[0]

  const filteredFilePool = useMemo(() => {
    if (!atFilter) return filePool
    const loweredFilter = atFilter.toLowerCase()
    return filePool.filter((file) => (
      file.name.toLowerCase().includes(loweredFilter) ||
      file.path.toLowerCase().includes(loweredFilter)
    ))
  }, [filePool, atFilter])

  const filteredSkills = useMemo(() => {
    return filterSlashSkills(skills, slashFilter)
  }, [skills, slashFilter])
  const showImageCommand = useMemo(() => {
    const query = slashFilter.trim().toLowerCase()
    return !query || 'imag'.startsWith(query) || 'image'.startsWith(query) || '生图'.includes(query)
  }, [slashFilter])
  const slashItemCount = filteredSkills.length + (showImageCommand ? 1 : 0)

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashFilter])

  useEffect(() => {
    setSlashSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(0, slashItemCount - 1))))
  }, [slashItemCount])

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
    onReferenceSelect(file)

    setTimeout(() => {
      const newPos = (beforeAt + insertion).length
      textarea.setSelectionRange(newPos, newPos)
      textarea.focus()
    }, 0)

    setShowAtMenu(false)
    setAtFilter('')
  }, [inputValue, onInputChange, onReferenceSelect])

  const insertSlashSkillReference = useCallback((skill: SkillMenuItem) => {
    const textarea = textareaRef.current
    if (!textarea) return

    const cursorPos = textarea.selectionStart
    const insertion = buildSlashSkillInsertion(inputValue, cursorPos, skill.name)
    if (!insertion) return

    onInputChange(insertion.nextValue)
    onSkillReference({
      type: 'skill-folder',
      name: skill.name,
      path: skill.managedPath || skill.sourcePath || undefined,
      skillId: skill.id,
      description: skill.description,
      defaultAction: skill.defaultAction,
    })

    setTimeout(() => {
      textarea.setSelectionRange(insertion.cursorPosition, insertion.cursorPosition)
      textarea.focus()
    }, 0)

    setShowSlashMenu(false)
    setSlashFilter('')
  }, [inputValue, onInputChange, onSkillReference])

  const insertImageCommand = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const insertion = buildSlashCommandInsertion(inputValue, textarea.selectionStart, 'imag')
    if (!insertion) return
    onInputChange(insertion.nextValue)
    setTimeout(() => {
      textarea.setSelectionRange(insertion.cursorPosition, insertion.cursorPosition)
      textarea.focus()
    }, 0)
    setShowSlashMenu(false)
    setSlashFilter('')
  }, [inputValue, onInputChange])

  const handleInputChange = (value: string, cursorPos: number) => {
    onInputChange(value)
    const textBeforeCursor = value.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/)
    if (atMatch && filePool.length > 0) {
      setAtFilter(atMatch[1])
      setShowAtMenu(true)
      syncComposerMenuFrame()
      setShowSlashMenu(false)
      setSlashFilter('')
    } else {
      setShowAtMenu(false)
      setAtFilter('')
      const slashMatch = textBeforeCursor.match(/(?:^|\s)\/([^\s/@]*)$/)
      if (slashMatch) {
        setSlashFilter(slashMatch[1] || '')
        setShowSlashMenu(true)
        syncComposerMenuFrame()
        if (skills.length === 0) void loadSkills()
      } else {
        setShowSlashMenu(false)
        setSlashFilter('')
      }
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
    if (showSlashMenu) {
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (showImageCommand && slashSelectedIndex === 0) {
          e.preventDefault()
          insertImageCommand()
          return
        }
        const skillIndex = slashSelectedIndex - (showImageCommand ? 1 : 0)
        const selected = filteredSkills[skillIndex] || (!showImageCommand ? filteredSkills[0] : undefined)
        if (selected) {
          e.preventDefault()
          insertSlashSkillReference(selected)
          return
        }
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((index) => Math.min(index + 1, Math.max(0, slashItemCount - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((index) => Math.max(0, index - 1))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSlashMenu(false)
        setSlashFilter('')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!sendDisabled) {
        onSend()
      }
    }
  }

  const portalRoot = typeof document !== 'undefined' ? document.body : null
  const composerMenuLeft = composerMenuFrame?.left ?? 12
  const composerMenuBottom = composerMenuFrame?.bottom ?? 120
  const composerMenuWidth = composerMenuFrame?.width ?? 'calc(100vw - 24px)'
  const composerMenuMaxHeight = composerMenuFrame?.maxHeight ?? 240
  const authorizationMenuLeft = authorizationMenuFrame?.left ?? 12
  const authorizationMenuBottom = authorizationMenuFrame?.bottom ?? 120
  const authorizationMenuWidth = authorizationMenuFrame?.width ?? 260

  const atMenu = showAtMenu && filteredFilePool.length > 0 ? (
    <FloatPanel
      ref={atMenuRef}
      style={{
        ...chatMenuSurfaceStyle,
        position: 'fixed',
        left: composerMenuLeft,
        bottom: composerMenuBottom,
        width: composerMenuWidth,
        maxHeight: Math.min(220, composerMenuMaxHeight),
        zIndex: 520,
      }}
      contentStyle={{
        maxHeight: Math.min(208, composerMenuMaxHeight - 12),
        overflowY: 'auto',
      }}
      contentClassName="rn-float-panel__content panel-hover-scrollbar"
    >
      <div style={{ fontSize: 10, color: 'var(--rn-ink-3)', padding: '2px 8px', marginBottom: 2 }}>
        引用文件 / 文件夹
      </div>
      {filteredFilePool.map((file) => (
        <button
          key={file.id}
          type="button"
          onClick={() => insertAtReference(file)}
          className={`${CHAT_MENU_ITEM_CLASS} flex items-center gap-2`}
          style={{
            ...chatMenuItemStyle,
            textAlign: 'left',
          }}
        >
          {renderAttachmentIcon(file)}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--rn-ink)',
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
                color: 'var(--rn-ink-3)',
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
          <span style={{ fontSize: 10, color: 'var(--rn-ink-3)', marginLeft: 'auto', flexShrink: 0 }}>
            {file.isDirectory
              ? '文件夹'
              : file.source === 'rss-reference' ? 'RSS 引用'
              : file.source === 'browser-tab'
                ? '网页'
                : file.source === 'skill-folder'
                  ? '技能'
                  : `${Math.max(1, Math.round(file.size / 1024))} KB`}
          </span>
        </button>
      ))}
    </FloatPanel>
  ) : null

  const slashMenu = showSlashMenu ? (
    <FloatPanel
      ref={slashMenuRef}
      className="panel-hover-scrollbar"
      style={{
        ...chatMenuSurfaceStyle,
        position: 'fixed',
        left: composerMenuLeft,
        bottom: composerMenuBottom,
        width: composerMenuWidth,
        maxHeight: Math.min(260, composerMenuMaxHeight),
        zIndex: 530,
      }}
      contentStyle={{
        maxHeight: Math.min(248, composerMenuMaxHeight - 12),
        overflowY: 'auto',
      }}
      contentClassName="rn-float-panel__content panel-hover-scrollbar"
    >
      <div style={{ fontSize: 10, color: 'var(--rn-ink-3)', padding: '2px 8px', marginBottom: 2 }}>
        命令与 Skill
      </div>
      {showImageCommand ? (
        <button
          type="button"
          data-slash-command="imag"
          onMouseDown={(event) => {
            event.preventDefault()
            insertImageCommand()
          }}
          onPointerEnter={() => setSlashSelectedIndex(0)}
          className={`${CHAT_MENU_ITEM_CLASS} flex items-center gap-2`}
          data-highlighted={slashSelectedIndex === 0 || undefined}
          style={{ ...chatMenuItemStyle, textAlign: 'left' }}
        >
          <ImagePlus style={{ width: 15, height: 15, flexShrink: 0, color: 'var(--rn-ink-2)' }} strokeWidth={2} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--rn-ink)' }}>/imag</div>
            <div style={{ fontSize: 10, color: 'var(--rn-ink-3)', marginTop: 2 }}>生成图片，可搭配已添加的参考图</div>
          </div>
          <span style={{ fontSize: 10, color: 'var(--rn-ink-3)', marginLeft: 'auto', flexShrink: 0 }}>命令</span>
        </button>
      ) : null}
      {filteredSkills.length > 0 ? filteredSkills.map((skill, index) => {
        const menuIndex = index + (showImageCommand ? 1 : 0)
        return (
        <button
          key={skill.id}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault()
            insertSlashSkillReference(skill)
          }}
          onPointerEnter={() => setSlashSelectedIndex(menuIndex)}
          className={`${CHAT_MENU_ITEM_CLASS} flex items-center gap-2`}
          data-highlighted={menuIndex === slashSelectedIndex || undefined}
          style={{
            ...chatMenuItemStyle,
            textAlign: 'left',
          }}
        >
          <Puzzle style={{ width: 15, height: 15, flexShrink: 0, color: 'var(--rn-ink-3)' }} strokeWidth={2} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--rn-ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {skill.name}
            </div>
            <div
              style={{
                fontSize: 10,
                color: 'var(--rn-ink-3)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 2,
              }}
              title={skill.description || skill.id}
            >
              {skill.description || skill.id}
            </div>
          </div>
          <span style={{ fontSize: 10, color: 'var(--rn-ink-3)', marginLeft: 'auto', flexShrink: 0 }}>
            {skill.installed ? '已就绪' : '未安装'}
          </span>
        </button>
        )
      }) : !showImageCommand ? (
        <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--rn-ink-3)' }}>
          没有匹配的 skill
        </div>
      ) : null}
    </FloatPanel>
  ) : null

  const authorizationMenu = showAuthorizationModeSelect ? (
    <FloatPanel
      ref={authorizationMenuRef}
      data-ready-action-authorization-menu="true"
      style={{
        ...chatMenuSurfaceStyle,
        position: 'fixed',
        left: authorizationMenuLeft,
        bottom: authorizationMenuBottom,
        width: authorizationMenuWidth,
        maxWidth: 'calc(100vw - 24px)',
        zIndex: 540,
      }}
      contentStyle={{ padding: 4 }}
    >
      {authorizationModeOptions.map((option) => (
        <button
          key={option.mode}
          type="button"
          data-ready-action-authorization-option={option.mode}
          className={CHAT_MENU_ITEM_CLASS}
          data-highlighted={option.mode === actionAuthorizationMode || undefined}
          style={{ ...chatMenuItemStyle, display: 'block', textAlign: 'left' }}
          onClick={async () => {
            if (option.mode === actionAuthorizationMode) {
              setShowAuthorizationModeSelect(false)
              return
            }
            setAuthorizationModeUpdating(true)
            try {
              await onActionAuthorizationModeChange(option.mode)
              setShowAuthorizationModeSelect(false)
            } catch {
              // silent-catch: the parent updates the displayed mode only after Main
              // persisted it. Keep the old value and menu on failure.
            } finally {
              setAuthorizationModeUpdating(false)
            }
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--rn-ink)' }}>{option.label}</div>
          <div style={{ marginTop: 2, fontSize: 10, lineHeight: 1.35, color: 'var(--rn-ink-3)' }}>{option.description}</div>
        </button>
      ))}
    </FloatPanel>
  ) : null

  return (
    <div
      style={{
        padding: '10px 0 0',
        borderTop: '1px solid transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'transparent',
        boxShadow: 'none',
      }}
    >
      <div
        data-chat-composer-shell="true"
        data-ready-composer-editable={composerState.editable ? 'true' : 'false'}
        data-ready-composer-send-enabled={composerState.sendEnabled ? 'true' : 'false'}
        data-ready-composer-blocker={composerState.blocker ?? ''}
        data-drag-over={isDragOver ? 'true' : 'false'}
        className="ready-liquid-composer block w-full"
        style={{ ...composerShellStyle, overflow: 'visible' }}
      >
        <LiquidLens
          className="ready-liquid-composer__surface"
          // 减少透明（DL12）：不折射、不投影，退回纸色（liquid-composer.css）。
          engine={reducedTransparency ? 'off' : 'backdrop'}
          radius={18}
          bevel={22}
          depth={37}
          ior={1.34}
          dome={2}
          // squircle=折弯集中最外缘（规格 §6.1）；观感不合意改回 'circular' 一行回退
          profile="squircle"
          strength={3.2}
          blur={3.5}
          frost={0}
          blurBeforeRefraction
          saturation={1.18}
          brightness={1.05}
          contrast={0.84}
          aberration={0}
          backdropContent={<LiquidBackdropProjection className="ready-liquid-composer__projection" />}
        >
          <div
            className="ready-liquid-composer__content flex flex-col"
            style={{
              borderRadius: 'var(--rn-liquid-r)',
              background: 'transparent',
              padding: isDragOver ? '13px 15px 10px' : '14px 16px 11px',
              position: 'relative',
              minHeight: 108,
              gap: 10,
              transition: 'padding 150ms ease',
            }}
          >
          <textarea
            ref={textareaRef}
            data-ready-agent-input="true"
            value={inputValue}
            onChange={(e) => handleInputChange(e.target.value, e.target.selectionStart)}
            onKeyDown={handleKeyDown}
            onPaste={onPaste}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            disabled={!composerState.editable}
            placeholder="Hi～今天有什么可以帮到你"
            className="ready-input-slot-inner w-full bg-transparent border-none outline-none resize-none"
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--rn-liquid-ink)',
              lineHeight: '1.5',
              width: '100%',
              minHeight: 44,
              maxHeight: 120,
              opacity: composerState.editable ? 1 : 0.7,
            }}
            rows={2}
          />

          {(isPasting || pasteError) && (
            <div role={pasteError ? 'alert' : 'status'} style={{ fontSize: 11, color: pasteError ? 'var(--rn-bad)' : 'var(--rn-ink-2)' }}>
              {isPasting ? '正在添加图片…' : pasteError}
            </div>
          )}
          {stopError && (
            <div
              role="alert"
              data-ready-agent-stop-error="true"
              style={{
                color: 'var(--rn-bad)',
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              {stopError}
            </div>
          )}

          <div className="flex items-center justify-between" style={{ gap: 8, minHeight: 32 }}>
            <div className="flex items-center" style={{ gap: 6, minWidth: 0, flex: '1 1 auto' }}>
              <button
                type="button"
                onClick={onPickFiles}
                title="添加文件"
                className="flex items-center justify-center active:scale-[0.98] transition-[background-color,transform] duration-200 ease-out"
                style={{ width: 26, height: 26, borderRadius: 8, border: '1px solid transparent', background: 'transparent', flexShrink: 0 }}
              >
                <Plus style={{ width: 14, height: 14 }} className="text-[var(--rn-liquid-ink-2)]" strokeWidth={2} />
              </button>

              <div style={{ minWidth: 0 }}>
                <ModelSelector />
              </div>

              {!isChannelScope && (
                <div className="relative" ref={authorizationModeRef} style={{ flexShrink: 0 }}>
                  <button
                    type="button"
                    data-ready-action-authorization-mode={actionAuthorizationMode}
                    disabled={authorizationModeUpdating}
                    onClick={() => {
                      if (!showAuthorizationModeSelect) syncAuthorizationMenuFrame()
                      setShowAuthorizationModeSelect((value) => !value)
                    }}
                    title={currentAuthorizationMode.description}
                    className="flex items-center active:scale-[0.98] transition-[opacity,transform] duration-200 ease-out"
                    style={{
                      padding: '3px 8px',
                      borderRadius: 8,
                      border: '1px solid transparent',
                      background: 'transparent',
                      gap: 4,
                      opacity: authorizationModeUpdating ? 0.55 : 1,
                    }}
                  >
                    <ShieldCheck style={{ width: 12, height: 12 }} className="text-[var(--rn-liquid-ink-2)]" strokeWidth={1.8} />
                    <span style={{ fontSize: 11, color: 'var(--rn-liquid-ink-2)' }}>{currentAuthorizationMode.label}</span>
                    <ChevronDown
                      style={{
                        width: 10,
                        height: 10,
                        transform: showAuthorizationModeSelect ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 200ms ease',
                      }}
                      className="text-[var(--rn-liquid-ink-3)]"
                    />
                  </button>

                </div>
              )}
            </div>

            <div className="flex items-center" style={{ gap: 6, flexShrink: 0 }}>
              <ContextUsageMeter usage={contextUsage} dimmed={composerLocked} />

              {stopAvailable ? (
                <button
                  type="button"
                  onClick={onStop}
                  data-ready-agent-stop="true"
                  disabled={stopPending}
                  aria-busy={stopPending}
                  aria-label={stopPending ? '正在停止' : '停止生成'}
                  title={stopPending ? '正在停止' : '停止生成'}
                  className="flex items-center justify-center hover:brightness-95 active:scale-[0.98] transition-[filter,transform] duration-200 ease-out"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 16,
                    background: 'var(--rn-bad)',
                    color: 'var(--rn-accent-ink)',
                    cursor: stopPending ? 'wait' : 'pointer',
                    opacity: stopPending ? 0.62 : 1,
                  }}
                >
                  {stopPending
                    ? <LoaderCircle className="animate-spin" style={{ width: 14, height: 14 }} />
                    : <Square style={{ width: 12, height: 12 }} strokeWidth={0} fill="currentColor" />}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onSend}
                  data-ready-agent-send="true"
                  data-ready-agent-send-blocked={sendUnavailable ? sendBlockedReason : undefined}
                  disabled={sendDisabled}
                  title={sendBlockedReason || undefined}
                  aria-label={sendBlockedReason || '发送'}
                  className="flex items-center justify-center hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed transition-[opacity,filter,transform] duration-200 ease-out"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 16,
                    border: '1px solid color-mix(in srgb, var(--rn-on-inverse) 8%, transparent)',
                    background: 'var(--rn-inverse)',
                    color: 'var(--rn-on-inverse)',
                    boxShadow: 'none',
                    opacity: sendUnavailable ? 0.38 : 1,
                  }}
                >
                  <ArrowUp style={{ width: 16, height: 16 }} strokeWidth={2.2} fill="none" />
                </button>
              )}
            </div>
          </div>
          </div>
        </LiquidLens>
      </div>
      {portalRoot && atMenu ? createPortal(atMenu, portalRoot) : null}
      {portalRoot && slashMenu ? createPortal(slashMenu, portalRoot) : null}
      {portalRoot && authorizationMenu ? createPortal(authorizationMenu, portalRoot) : null}
    </div>
  )
})

export default ChatInput
