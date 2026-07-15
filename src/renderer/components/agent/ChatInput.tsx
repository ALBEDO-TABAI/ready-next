import { forwardRef, useRef, useEffect, useState, useImperativeHandle, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, Plus, Square, ChevronDown, ImagePlus, Puzzle } from 'lucide-react'
import { LiquidLens } from '../ui/liquid-glass/LiquidLens'
import { LiquidBackdropProjection } from '../ui/liquid-glass/LiquidBackdropProjection'
import { LiquidFloatingPanel } from '../ui/liquid-glass/LiquidFloatingPanel'
import type { ChatAttachment } from '../../stores/useAgent'
import type { ReadySkillReference } from '../../modules/agent/chat-input-bridge'
import type { NativeContextMenuItem } from '../../../shared/native-context-menu'
import type { ContextUsageSnapshot } from '../../../shared/context-usage-types'
import { chatMenuItemStyle, chatMenuSurfaceStyle } from './chatMenuStyles'
import { ContextUsageMeter } from './chat-panel/ContextUsageMeter'
import {
  buildSlashSkillInsertion,
  buildSlashCommandInsertion,
  filterSlashSkills,
  type SkillMenuItem,
} from '../../modules/agent/slash-skill-selection'

interface ChatInputProps {
  inputValue: string
  isStreaming: boolean
  attachmentsCount: number
  hasUserMessages: boolean
  pendingSendCount: number
  pendingSendCountdown: number
  isDragOver: boolean
  contextUsage: ContextUsageSnapshot | null
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
  thoroughOverride: boolean
  onThoroughOverrideChange: (enabled: boolean) => void
  onStop: () => void
  onUndo: () => void
  onPickFiles: () => void
  onAgentSelect: (agentName: string) => void
  onSkillReference: (skill: ReadySkillReference) => void
  onReferenceSelect: (attachment: ChatAttachment) => void
  renderAttachmentIcon: (attachment: ChatAttachment, size?: number) => React.ReactNode
  ModelSelector: React.ComponentType
}

interface ComposerMenuFrame {
  left: number
  bottom: number
  width: number
  maxHeight: number
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
  contextUsage,
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
  thoroughOverride,
  onThoroughOverrideChange,
  onStop,
  onUndo,
  onPickFiles,
  onAgentSelect,
  onSkillReference,
  onReferenceSelect,
  renderAttachmentIcon,
  ModelSelector,
}: ChatInputProps, ref) {
  const [showAgentSelect, setShowAgentSelect] = useState(false)
  const [agentNativeMenuOpen, setAgentNativeMenuOpen] = useState(false)
  const [showAtMenu, setShowAtMenu] = useState(false)
  const [atFilter, setAtFilter] = useState('')
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [skills, setSkills] = useState<SkillMenuItem[]>([])
  const [composerMenuFrame, setComposerMenuFrame] = useState<ComposerMenuFrame | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const atMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const composerLocked = isStreaming

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
      if (showSlashMenu && slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setShowSlashMenu(false)
        setSlashFilter('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAgentSelect, showAtMenu, showSlashMenu])

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

  const showNativeAgentMenu = useCallback(async (button: HTMLButtonElement) => {
    if (isChannelScope) return
    const api = typeof window !== 'undefined' ? window.electronAPI?.ui : null
    if (!api?.showNativeContextMenu) {
      setShowAgentSelect((value) => !value)
      return
    }

    const items: NativeContextMenuItem[] = agents.map((agent) => {
      const label = (agent.displayName || agent.name).trim()
      return {
        id: agent.name,
        label: agent.status === 'working' ? `${label}    工作中` : label,
        iconText: agent.avatar,
        checked: agent.name === currentAgent,
      }
    })
    if (items.length === 0) return

    const rect = button.getBoundingClientRect()
    const estimatedHeight = Math.min(items.length, 8) * 28 + 10
    setShowAgentSelect(false)
    setShowAtMenu(false)
    setAtFilter('')
    setShowSlashMenu(false)
    setSlashFilter('')
    setAgentNativeMenuOpen(true)

    let selectedId = ''
    try {
      const result = await api.showNativeContextMenu({
        x: Math.max(8, Math.round(rect.left)),
        y: Math.max(8, Math.round(rect.top - estimatedHeight - 6)),
        items,
      }).catch(() => null)
      selectedId = typeof result?.selectedId === 'string' ? result.selectedId : ''
    } finally {
      setAgentNativeMenuOpen(false)
    }

    if (selectedId && agents.some((agent) => agent.name === selectedId)) {
      onAgentSelect(selectedId)
    }
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [agents, currentAgent, isChannelScope, onAgentSelect])

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
      if (inputValue.trim() || attachmentsCount > 0) {
        onSend()
      }
    }
  }

  const portalRoot = typeof document !== 'undefined' ? document.body : null
  const composerMenuLeft = composerMenuFrame?.left ?? 12
  const composerMenuBottom = composerMenuFrame?.bottom ?? 120
  const composerMenuWidth = composerMenuFrame?.width ?? 'calc(100vw - 24px)'
  const composerMenuMaxHeight = composerMenuFrame?.maxHeight ?? 240

  const atMenu = showAtMenu && filteredFilePool.length > 0 ? (
    <LiquidFloatingPanel
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
      contentClassName="ready-liquid-popover__content panel-hover-scrollbar"
    >
      <div style={{ fontSize: 10, color: 'var(--text-light)', padding: '2px 8px', marginBottom: 2 }}>
        引用文件 / 文件夹
      </div>
      {filteredFilePool.map((file) => (
        <button
          key={file.id}
          onClick={() => insertAtReference(file)}
          className="ready-floating-menu-item w-full flex items-center gap-2 active:scale-[0.98] transition-[background-color,transform] duration-150"
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
    </LiquidFloatingPanel>
  ) : null

  const slashMenu = showSlashMenu ? (
    <LiquidFloatingPanel
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
      contentClassName="ready-liquid-popover__content panel-hover-scrollbar"
    >
      <div style={{ fontSize: 10, color: 'var(--text-light)', padding: '2px 8px', marginBottom: 2 }}>
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
          className={`ready-floating-menu-item w-full flex items-center gap-2 active:scale-[0.98] transition-[background-color,transform] duration-150 ${slashSelectedIndex === 0 ? 'is-selected' : ''}`}
          style={{ ...chatMenuItemStyle, textAlign: 'left' }}
        >
          <ImagePlus style={{ width: 15, height: 15, flexShrink: 0, color: 'var(--color-ready-orange)' }} strokeWidth={2} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-body)' }}>/imag</div>
            <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>生成图片，可搭配已添加的参考图</div>
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-light)', marginLeft: 'auto', flexShrink: 0 }}>命令</span>
        </button>
      ) : null}
      {filteredSkills.length > 0 ? filteredSkills.map((skill, index) => {
        const menuIndex = index + (showImageCommand ? 1 : 0)
        return (
        <button
          key={skill.id}
          onMouseDown={(event) => {
            event.preventDefault()
            insertSlashSkillReference(skill)
          }}
          onPointerEnter={() => setSlashSelectedIndex(menuIndex)}
          className={`ready-floating-menu-item w-full flex items-center gap-2 active:scale-[0.98] transition-[background-color,transform] duration-150 ${menuIndex === slashSelectedIndex ? 'is-selected' : ''}`}
          style={{
            ...chatMenuItemStyle,
            textAlign: 'left',
          }}
        >
          <Puzzle style={{ width: 15, height: 15, flexShrink: 0, color: 'var(--text-gray)' }} strokeWidth={2} />
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
              {skill.name}
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
              title={skill.description || skill.id}
            >
              {skill.description || skill.id}
            </div>
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-light)', marginLeft: 'auto', flexShrink: 0 }}>
            {skill.installed ? '已就绪' : '未安装'}
          </span>
        </button>
        )
      }) : !showImageCommand ? (
        <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-light)' }}>
          没有匹配的 skill
        </div>
      ) : null}
    </LiquidFloatingPanel>
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
        backdropFilter: 'none',
        WebkitBackdropFilter: 'none',
        boxShadow: 'none',
      }}
    >
      {pendingSendCount > 0 && !composerLocked && (
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

      <div
        data-chat-composer-shell="true"
        data-drag-over={isDragOver ? 'true' : 'false'}
        className="ready-liquid-composer block w-full"
        style={{ ...composerShellStyle, overflow: 'visible' }}
      >
        <LiquidLens
          className="ready-liquid-composer__surface"
          radius={18}
          bevel={22}
          depth={37}
          ior={1.34}
          dome={5}
          // squircle=折弯集中最外缘（规格 §6.1）；观感不合意改回 'circular' 一行回退
          profile="squircle"
          strength={6.4}
          blur={3.5}
          frost={0}
          blurBeforeRefraction
          saturation={1.18}
          brightness={1.05}
          contrast={0.84}
          aberration={0}
          engine="backdrop"
          backdropContent={<LiquidBackdropProjection className="ready-liquid-composer__projection" />}
        >
          <div
            className="ready-liquid-composer__content flex flex-col"
            style={{
              borderRadius: 'var(--workbench-canvas-radius)',
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
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            disabled={composerLocked}
            placeholder="Hi～今天有什么可以帮到你"
            className="ready-input-slot-inner w-full bg-transparent border-none outline-none resize-none"
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--text-body)',
              lineHeight: '1.5',
              width: '100%',
              minHeight: 44,
              maxHeight: 120,
              opacity: composerLocked ? 0.7 : 1,
            }}
            rows={2}
          />

          <div className="flex items-center justify-between" style={{ gap: 8, minHeight: 32 }}>
            <div className="flex items-center" style={{ gap: 6, minWidth: 0, flex: '1 1 auto' }}>
              <button
                onClick={onPickFiles}
                title="添加文件"
                className="flex items-center justify-center hover:bg-black/5 active:scale-[0.98] transition-[background-color,transform] duration-200 ease-out"
                style={{ width: 26, height: 26, borderRadius: 8, border: '1px solid transparent', background: 'transparent', flexShrink: 0 }}
              >
                <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-gray)]" strokeWidth={2} />
              </button>

              <div className="relative" ref={dropdownRef} style={{ flexShrink: 0 }}>
                <button
                  disabled={isChannelScope}
                  onClick={(event) => {
                    void showNativeAgentMenu(event.currentTarget)
                  }}
                  className="flex items-center active:scale-[0.98] transition-[opacity,transform] duration-200 ease-out"
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
                      transform: (showAgentSelect || agentNativeMenuOpen) ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 200ms ease',
                    }}
                    className="text-[var(--text-light)]"
                  />
                </button>

                {showAgentSelect && !agentNativeMenuOpen && !isChannelScope && (
                  <div
                    style={{
                      ...chatMenuSurfaceStyle,
                      position: 'absolute',
                      bottom: '100%',
                      left: 0,
                      marginBottom: 4,
                      minWidth: 160,
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
                        className={`ready-floating-menu-item w-full flex items-center gap-2 active:scale-[0.98] transition-[background-color,transform] duration-150 ${agent.name === currentAgent ? 'is-selected' : ''}`}
                        style={{
                          ...chatMenuItemStyle,
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

              <div style={{ minWidth: 0 }}>
                <ModelSelector />
              </div>
            </div>

            <div className="flex items-center" style={{ gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                data-ready-delivery-thorough="true"
                aria-pressed={thoroughOverride}
                title="Boost：仅下一次发送启用强化协作与独立复核，发送后自动关闭"
                onClick={() => onThoroughOverrideChange(!thoroughOverride)}
                className="rounded-full hover:bg-black/5 active:scale-[0.98] transition-[background-color,color,transform] duration-150"
                style={{
                  height: 26,
                  padding: '0 8px',
                  fontSize: 10.5,
                  lineHeight: 1,
                  fontWeight: 550,
                  border: '1px solid transparent',
                  background: thoroughOverride ? 'color-mix(in srgb, var(--color-ready-orange) 14%, transparent)' : 'transparent',
                  color: thoroughOverride ? 'var(--color-ready-orange)' : 'var(--text-light)',
                }}
              >
                Boost
              </button>
              <ContextUsageMeter usage={contextUsage} dimmed={composerLocked} />

              {composerLocked ? (
                <button
                  onClick={onStop}
                  data-ready-agent-stop="true"
                  title="停止生成"
                  className="flex items-center justify-center text-white hover:brightness-95 active:scale-[0.98] transition-[filter,transform] duration-200 ease-out"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 16,
                    background: 'var(--color-red)',
                  }}
                >
                  <Square style={{ width: 12, height: 12 }} strokeWidth={0} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={onSend}
                  data-ready-agent-send="true"
                  disabled={!inputValue.trim() && attachmentsCount === 0}
                  className="flex items-center justify-center hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed transition-[opacity,filter,transform] duration-200 ease-out"
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 16,
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    background: '#0f0f0f',
                    color: '#fff',
                    boxShadow: 'none',
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
    </div>
  )
})

export default ChatInput
