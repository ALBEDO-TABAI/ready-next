import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Wrench } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  useSettings,
  listChatSwitcherProfiles,
  getProviderDef,
} from '../../../../stores/useSettings'

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
  const [expandedProfileIds, setExpandedProfileIds] = useState<Set<string>>(() => new Set())
  const ref = useRef<HTMLDivElement>(null)
  const autoExpandedActiveIdRef = useRef<string | null>(null)

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
  const activeProfile = getActiveProfile()
  const label = activeProfile?.name || config.displayName || getShortProviderLabel()
  // `showInChatSwitcher` is pre-filtered into `visibleProfiles`.
  const { currentHiddenProfile, visibleProfiles } = listChatSwitcherProfiles(workspace)

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

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
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

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 4,
            minWidth: 248,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-default)',
            borderRadius: 12,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: 8,
            zIndex: 100
          }}
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
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              background: 'var(--bg-hover)'
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
                className="w-full text-left hover:bg-black/5 transition-colors"
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'transparent',
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
                        className="w-full text-left hover:bg-black/5 transition-colors"
                        style={{
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: isActiveProfile ? '1px solid color-mix(in srgb, var(--color-blue) 28%, transparent)' : '1px solid transparent',
                          background: isActiveProfile ? 'var(--bg-hover)' : 'transparent',
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
                                className="hover:bg-black/10"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  padding: 2,
                                  borderRadius: 4,
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
                                className="w-full text-left hover:bg-black/5 transition-colors"
                                style={{
                                  padding: '6px 10px',
                                  borderRadius: 6,
                                  background: isActiveModel ? 'var(--bg-hover)' : 'transparent',
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
            className="w-full flex items-center justify-center gap-2 hover:bg-black/5 transition-colors"
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-default)',
              background: 'transparent',
              fontSize: 11,
              color: 'var(--text-muted)',
            }}
          >
            <Wrench style={{ width: 12, height: 12 }} strokeWidth={2} />
            管理显示项
          </button>
        </div>
      )}
    </div>
  )
}
