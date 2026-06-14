import { useCallback, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Wrench } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  useSettings,
  listChatSwitcherProfiles,
  getProviderDef,
} from '../../../../stores/useSettings'
import { chatMenuItemStyle, chatMenuSurfaceStyle } from '../../chatMenuStyles'
import { LiquidFloatingPanel } from '../../../ui/liquid-glass/LiquidFloatingPanel'

interface ModelMenuFrame {
  left: number
  bottom: number
  width: number
  maxHeight: number
}

// Model Selector (wired to useSettings store)
export default function ModelSelector() {
  const navigate = useNavigate()
  const {
    config,
    workspace,
    loaded,
    loadConfig,
    activateProfile,
    activateProfileWithModel,
    getActiveProfile,
    getShortModelLabel,
    getShortProviderLabel,
  } = useSettings()
  const [open, setOpen] = useState(false)
  const [menuFrame, setMenuFrame] = useState<ModelMenuFrame | null>(null)
  const [expandedProfileIds, setExpandedProfileIds] = useState<Set<string>>(() => new Set())
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const autoExpandedActiveIdRef = useRef<string | null>(null)

  const syncMenuFrame = useCallback(() => {
    const anchor = ref.current
    if (!anchor) return

    const composerShell = anchor.closest('[data-chat-composer-shell="true"]') as HTMLElement | null
    const shellRect = (composerShell || anchor).getBoundingClientRect()
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
    const margin = 12
    const fallbackWidth = Math.min(360, Math.max(248, viewportWidth - margin * 2))
    const width = composerShell
      ? Math.max(248, Math.min(shellRect.width, viewportWidth - margin * 2))
      : fallbackWidth
    const left = composerShell
      ? Math.max(margin, Math.min(shellRect.left, viewportWidth - width - margin))
      : Math.max(margin, Math.min(shellRect.right - width, viewportWidth - width - margin))
    const topLimit = Math.max(margin, shellRect.top - margin)

    setMenuFrame({
      left: Math.round(left),
      bottom: Math.max(margin, Math.round(viewportHeight - shellRect.top + 6)),
      width: Math.round(width),
      maxHeight: Math.max(220, Math.round(topLimit)),
    })
  }, [])

  useEffect(() => {
    if (!loaded) loadConfig()
  }, [loaded, loadConfig])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    syncMenuFrame()
    window.addEventListener('resize', syncMenuFrame)
    window.addEventListener('scroll', syncMenuFrame, true)
    return () => {
      window.removeEventListener('resize', syncMenuFrame)
      window.removeEventListener('scroll', syncMenuFrame, true)
    }
  }, [open, syncMenuFrame])

  const hasKey = !!config.apiKey
  const activeProfile = getActiveProfile()
  const label = activeProfile?.name || config.displayName || getShortProviderLabel()
  // `showInChatSwitcher` is pre-filtered into `visibleProfiles`.
  const { currentHiddenProfile, visibleProfiles } = listChatSwitcherProfiles(workspace)
  const portalRoot = typeof document !== 'undefined' ? document.body : null

  useEffect(() => {
    if (!open) {
      autoExpandedActiveIdRef.current = null
      return
    }
    if (!activeProfile) return
    if (autoExpandedActiveIdRef.current === activeProfile.id) return
    const ids = activeProfile.config.modelIds || []
    if (ids.length <= 1) return
    autoExpandedActiveIdRef.current = activeProfile.id
    setExpandedProfileIds((prev) => {
      if (prev.has(activeProfile.id)) return prev
      const next = new Set(prev)
      next.add(activeProfile.id)
      return next
    })
  }, [open, activeProfile?.id])

  const resolveHost = (value: string): string => {
    try {
      return value ? new URL(value).hostname : '未配置'
    } catch {
      return value || '未配置'
    }
  }

  const menu = open ? (
    <LiquidFloatingPanel
      ref={menuRef}
      className="panel-hover-scrollbar"
      style={{
        ...chatMenuSurfaceStyle,
        position: 'fixed',
        left: menuFrame ? menuFrame.left : 12,
        bottom: menuFrame ? menuFrame.bottom : 88,
        width: menuFrame ? menuFrame.width : 320,
        minWidth: 248,
        maxWidth: menuFrame ? menuFrame.width : 'min(360px, calc(100vw - 24px))',
        maxHeight: menuFrame ? menuFrame.maxHeight : 'min(640px, calc(100vh - 96px))',
        zIndex: 500,
      }}
      contentStyle={{
        maxHeight: menuFrame ? Math.max(180, menuFrame.maxHeight - 12) : 'min(628px, calc(100vh - 108px))',
        overflowY: 'auto',
      }}
      contentClassName="ready-liquid-popover__content panel-hover-scrollbar"
    >
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-light)',
          padding: '2px 8px',
          marginBottom: 4
        }}
      >
        当前模型
      </div>
      <div
        className="ready-floating-menu-item is-selected"
        style={{
          ...chatMenuItemStyle,
          cursor: 'default',
          textAlign: 'left',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>
          {getShortModelLabel()}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
          {resolveHost(config.baseUrl)}
        </div>
      </div>

      {currentHiddenProfile && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-light)',
              padding: '2px 8px',
              marginBottom: 4,
            }}
          >
            当前使用中
          </div>
          <button
            onClick={() => {
              activateProfile(currentHiddenProfile.id)
              setOpen(false)
            }}
            className="ready-floating-menu-item is-selected w-full text-left transition-colors"
            style={{
              ...chatMenuItemStyle,
              textAlign: 'left',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>
              {currentHiddenProfile.name}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
              {getShortModelLabel(currentHiddenProfile.id)}
            </div>
          </button>
        </div>
      )}

      {visibleProfiles.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-light)',
              padding: '2px 8px',
              marginBottom: 4,
            }}
          >
            快速切换
          </div>
          <div className="flex flex-col gap-1">
            {visibleProfiles.map((profile) => {
              const isActiveProfile = profile.id === activeProfile?.id
              const modelIds = profile.config.modelIds || []
              const hasMulti = modelIds.length > 1
              const expanded = expandedProfileIds.has(profile.id)
              const providerDef = getProviderDef(profile.config.provider, profile.config.baseUrl)
              return (
                <div key={profile.id} className="flex flex-col gap-1">
                  <button
                    onClick={() => {
                      activateProfile(profile.id)
                      setOpen(false)
                    }}
                    className={`ready-floating-menu-item w-full text-left transition-colors ${isActiveProfile ? 'is-selected' : ''}`}
                    style={{
                      ...chatMenuItemStyle,
                      textAlign: 'left',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>{profile.name}</span>
                      <div className="flex items-center gap-2">
                        {isActiveProfile && (
                          <span style={{ fontSize: 10, color: 'var(--color-blue)' }}>当前</span>
                        )}
                        {hasMulti && (
                          <span
                            role="button"
                            aria-label={expanded ? '收起模型列表' : '展开模型列表'}
                            onClick={(e) => {
                              e.stopPropagation()
                              setExpandedProfileIds((prev) => {
                                const next = new Set(prev)
                                if (next.has(profile.id)) next.delete(profile.id)
                                else next.add(profile.id)
                                return next
                              })
                            }}
                            className="ready-floating-menu-item"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              padding: 2,
                              borderRadius: 4,
                              border: '1px solid transparent',
                              background: 'transparent',
                              cursor: 'pointer',
                            }}
                          >
                            <ChevronDown
                              style={{
                                width: 12,
                                height: 12,
                                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 180ms ease',
                              }}
                              className="text-[var(--text-light)]"
                            />
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-light)', marginTop: 2 }}>
                      {getShortModelLabel(profile.id)}
                    </div>
                  </button>

                  {hasMulti && expanded && (
                    <div
                      className="flex flex-col"
                      style={{
                        marginLeft: 12,
                        paddingLeft: 8,
                        borderLeft: '1px solid var(--border-default)',
                        gap: 2,
                      }}
                    >
                      {modelIds.map((modelId) => {
                        const isActiveModel = isActiveProfile && profile.config.model === modelId
                        const modelLabel = providerDef?.models.find((m) => m.id === modelId)?.label || modelId
                        return (
                          <button
                            key={modelId}
                            onClick={() => {
                              activateProfileWithModel(profile.id, modelId)
                            }}
                            className={`ready-floating-menu-item w-full text-left transition-colors ${isActiveModel ? 'is-selected' : ''}`}
                            style={{
                              ...chatMenuItemStyle,
                              padding: '6px 10px',
                              textAlign: 'left',
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: isActiveModel ? 500 : 400,
                                  color: isActiveModel ? 'var(--color-blue)' : 'var(--text-body)',
                                }}
                              >
                                {modelLabel}
                              </span>
                              {isActiveModel && (
                                <span style={{ fontSize: 10, color: 'var(--color-blue)' }}>当前</span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!hasKey && (
        <div
          style={{ fontSize: 10, color: 'var(--color-red)', padding: '4px 8px', marginTop: 4 }}
        >
          未配置 API Key，请前往设置页配置
        </div>
      )}

      <button
        onClick={() => {
          navigate('/settings?section=ai')
          setOpen(false)
        }}
        className="ready-floating-menu-item w-full flex items-center justify-center gap-2 transition-colors"
        style={{
          ...chatMenuItemStyle,
          marginTop: 8,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        <Wrench style={{ width: 12, height: 12 }} strokeWidth={2} />
        管理显示项
      </button>
    </LiquidFloatingPanel>
  ) : null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          syncMenuFrame()
          setOpen(true)
        }}
        className="flex items-center active:scale-[0.98] transition-[background-color,transform] duration-200 ease-out"
        style={{
          padding: '3px 8px',
          borderRadius: 8,
          border: '1px solid transparent',
          background: 'transparent',
          gap: 4
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: hasKey ? 'var(--color-green)' : 'var(--color-red)' }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>{label}</span>
        <ChevronDown
          style={{
            width: 10,
            height: 10,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms ease'
          }}
          className="text-[var(--text-light)]"
        />
      </button>

      {menu && (portalRoot ? createPortal(menu, portalRoot) : menu)}
    </div>
  )
}
