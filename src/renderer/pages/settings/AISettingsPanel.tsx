import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronLeft, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { resolveAIConfigCapabilities, getActiveAIProfile } from '../../../shared/ai-providers'
import type { CapabilityRuntimeSnapshot } from '../../../shared/ai-capability-runtime'
import { listSettingsCapabilityGroups, type CapabilityGroupId } from '../../../shared/ai-capability-groups'
import { useSettings, getProviderDef } from '../../stores/useSettings'
import type { AIProviderCategory } from '../../stores/useSettings'
import {
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_FLAT_CHIP_STYLE,
  SETTINGS_FLAT_INPUT_STYLE,
} from '../../components/settings/settings-theme'
import { AISettingsFieldCard, SettingsSwitch } from './settings-shared'
import { resolveToolUseModePresentation } from './tool-use-mode-copy'

// ── AI Settings Panel (dynamic, wired to backend) ──────────────────────────
const compactSelectStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  padding: '8px 28px 8px 12px',
}
const stackedInputStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  padding: '10px 12px',
  width: '100%',
  textAlign: 'left' as const,
}
const stackedSelectStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  padding: '10px 36px 10px 12px',
  width: '100%',
}
// Inner control slot for compact settings controls and label-on-top field cards.
// Borderless filled slot (no second stroke against the surrounding card) with comfortable
// left padding so the value no longer hugs the card edge.
const fieldSlotStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  marginTop: 6,
  border: '1px solid transparent',
  borderRadius: 12,
  background: 'color-mix(in srgb, var(--surface-floating-bg) 58%, transparent)',
  boxShadow: 'none',
  padding: '8px 12px',
  fontSize: 12,
  width: '100%',
}

export function AISettingsPanel() {
  const {
    config: activeConfig,
    workspace,
    selectedProfileId,
    loaded,
    testStatus,
    testMessage,
    testLatency,
    remoteModels,
    saveStatus,
    saveMessage,
    loadConfig,
    updateField,
    updateCapabilityMode,
    selectProfile,
    activateProfile,
    renameProfile,
    setProfileVisibility,
    addCustomProfile,
    removeCustomProfile,
    addModelId,
    removeModelId,
    testConnection,
  } = useSettings()

  const [showKey, setShowKey] = useState(false)
  const [pendingModelId, setPendingModelId] = useState('')
  const [editorTab, setEditorTab] = useState<'basic' | 'models' | 'capabilities' | 'conversation'>('basic')
  const [profileFilter, setProfileFilter] = useState<'all' | AIProviderCategory>('all')
  const [profileDetailOpen, setProfileDetailOpen] = useState(false)
  const [messageCoalesceEnabled, setMessageCoalesceEnabled] = useState(true)
  const [messageCoalesceWindowMs, setMessageCoalesceWindowMs] = useState('1200')
  const [capabilityRuntimeSnapshot, setCapabilityRuntimeSnapshot] = useState<CapabilityRuntimeSnapshot | null>(null)
  const [capabilityRuntimeSnapshotKey, setCapabilityRuntimeSnapshotKey] = useState<string | null>(null)
  const [capabilityRuntimeLoading, setCapabilityRuntimeLoading] = useState(false)

  const selectedProfile = useMemo(
    () => workspace.profiles.find((profile) => profile.id === (selectedProfileId || workspace.activeProfileId)) || null,
    [workspace, selectedProfileId]
  )
  const activeProfile = useMemo(() => getActiveAIProfile(workspace), [workspace])
  const selectedConfig = selectedProfile?.config || activeConfig
  const currentProvider = getProviderDef(selectedConfig.provider, selectedConfig.baseUrl)
  const capabilities = useMemo(() => resolveAIConfigCapabilities(selectedConfig), [selectedConfig])
  const toolUsePresentation = useMemo(
    () => resolveToolUseModePresentation(selectedConfig),
    [selectedConfig]
  )
  const models = currentProvider?.models || []
  const showReasoningEffort = capabilities?.agentProtocol === 'openai' && capabilities?.wireApi === 'responses'
  const capabilityGroups = listSettingsCapabilityGroups()
  const customProfiles = workspace.profiles.filter((profile) => profile.category === 'custom')
  const visibleProfiles = useMemo(
    () => profileFilter === 'all'
      ? workspace.profiles
      : workspace.profiles.filter((profile) => profile.category === profileFilter),
    [profileFilter, workspace.profiles]
  )
  const resolvedAgentInterfaceLabel = capabilities?.agentProtocol === 'anthropic'
    ? 'Anthropic /v1/messages'
    : capabilities?.wireApi === 'responses'
      ? 'OpenAI /responses'
      : 'OpenAI /chat/completions'
  const capabilityRuntimeConfig = useMemo(() => ({
    ...selectedConfig,
    apiKey: '',
    displayName: selectedConfig.displayName,
  }), [selectedConfig])
  const capabilitySnapshotKey = JSON.stringify({
    provider: capabilityRuntimeConfig.provider,
    baseUrl: capabilityRuntimeConfig.baseUrl,
    model: capabilityRuntimeConfig.model,
    agentProtocol: capabilityRuntimeConfig.agentProtocol,
    wireApi: capabilityRuntimeConfig.wireApi,
    toolUseMode: capabilityRuntimeConfig.toolUseMode,
    visionMode: capabilityRuntimeConfig.visionMode,
    reasoningEffort: capabilityRuntimeConfig.reasoningEffort,
    capabilityModes: capabilityRuntimeConfig.capabilityModes || {},
  })
  const knownModel = models.find((model) => model.id === selectedConfig.model)
  const contextWindowPlaceholder = String(knownModel?.contextWindow ?? 200_000)
  const showCustomContextWindowWarning =
    selectedConfig.provider === 'openai-compatible'
    && !selectedConfig.contextWindowOverride
    && !knownModel?.contextWindow
  const managedModelIds = selectedConfig.modelIds || (selectedConfig.model ? [selectedConfig.model] : [])
  const managedModelIdSet = new Set(managedModelIds)
  const defaultModelOptions = Array.from(new Set([...managedModelIds, selectedConfig.model].filter(Boolean)))

  const persistBridgeSetting = useCallback((key: string, value: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    void window.electronAPI.settings.set(key, value)
  }, [])

  const refreshCapabilityRuntimeSnapshot = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    setCapabilityRuntimeLoading(true)
    try {
      const result = await window.electronAPI.agent.getCapabilityRuntimeSnapshot(capabilityRuntimeConfig)
      if (!result.success || !result.data) return
      setCapabilityRuntimeSnapshot(result.data)
      setCapabilityRuntimeSnapshotKey(capabilitySnapshotKey)
    } finally {
      setCapabilityRuntimeLoading(false)
    }
  }, [capabilityRuntimeConfig, capabilitySnapshotKey])

  useEffect(() => {
    if (!loaded) void loadConfig()
  }, [loaded, loadConfig])

  useEffect(() => {
    let cancelled = false
    if (!loaded || typeof window === 'undefined' || !window.electronAPI?.settings) return

    ;(async () => {
      const allSettingsResult = await window.electronAPI.settings.getAll?.()
      if (cancelled) return

      const settings = allSettingsResult?.success && allSettingsResult.data ? allSettingsResult.data : {}
      if (settings.agent_message_coalesce_enabled) setMessageCoalesceEnabled(settings.agent_message_coalesce_enabled !== 'false')
      if (settings.agent_message_coalesce_window_ms) setMessageCoalesceWindowMs(settings.agent_message_coalesce_window_ms)
    })()

    return () => { cancelled = true }
  }, [loaded])

  useEffect(() => {
    setEditorTab('basic')
    setPendingModelId('')
    setShowKey(false)
    setCapabilityRuntimeSnapshot(null)
    setCapabilityRuntimeSnapshotKey(null)
  }, [selectedProfile?.id])

  const getCapabilityModeValue = useCallback((groupId: CapabilityGroupId): 'auto' | 'on' | 'off' => {
    const current = selectedConfig.capabilityModes?.[groupId]
    return current === 'on' || current === 'off' || current === 'auto' ? current : 'auto'
  }, [selectedConfig.capabilityModes])

  const updateContextWindowOverride = useCallback((rawValue: string) => {
    const trimmed = rawValue.trim()
    if (!trimmed) {
      updateField('contextWindowOverride', undefined)
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.min(2_000_000, Math.max(1, Math.floor(parsed)))
    updateField('contextWindowOverride', clamped)
  }, [updateField])

  const updateMaxOutputTokensOverride = useCallback((rawValue: string) => {
    const trimmed = rawValue.trim()
    if (!trimmed) {
      updateField('maxOutputTokensOverride', undefined)
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.min(1_000_000, Math.max(1, Math.floor(parsed)))
    updateField('maxOutputTokensOverride', clamped)
  }, [updateField])

  const resolveCapabilityRuntimeDisplay = useCallback((groupId: CapabilityGroupId) => {
    if (capabilityRuntimeLoading) return { label: '刷新中...', tone: 'muted' as const }
    const snapshot = capabilityRuntimeSnapshotKey === capabilitySnapshotKey ? capabilityRuntimeSnapshot?.groups[groupId] : null
    if (!snapshot) return { label: '未刷新', tone: 'muted' as const }
    if (snapshot.status === 'inactive') return { label: '保留占位', tone: 'muted' as const }
    if (snapshot.status === 'host_only') return { label: '宿主内部', tone: 'muted' as const }
    if (snapshot.status === 'environment_unavailable') return { label: '因环境不可用而关闭', tone: 'muted' as const }
    if (snapshot.status === 'run_intent_suppressed') return { label: '因本轮任务抑制', tone: 'muted' as const }
    if (snapshot.status === 'closed') {
      if (snapshot.reason === 'provider_disabled_tools') return { label: '因接口能力关闭', tone: 'muted' as const }
      if (snapshot.reason === 'disabled_by_config') return { label: '已关闭', tone: 'muted' as const }
      return { label: '当前场景未启用', tone: 'muted' as const }
    }
    return {
      label: snapshot.mode === 'on' ? '已启用' : '自动启用',
      tone: 'positive' as const,
    }
  }, [capabilityRuntimeLoading, capabilityRuntimeSnapshot, capabilityRuntimeSnapshotKey, capabilitySnapshotKey])

  const formatInterfaceLabel = useCallback((config: typeof selectedConfig) => {
    const resolved = resolveAIConfigCapabilities(config)
    if (resolved?.agentProtocol === 'anthropic') return 'Anthropic 兼容'
    if (resolved?.wireApi === 'responses') return 'OpenAI Responses'
    return 'OpenAI Chat'
  }, [])

  const providerFilters: Array<{ id: 'all' | AIProviderCategory; label: string; meta?: string }> = [
    { id: 'all', label: '全部', meta: String(workspace.profiles.length) },
    { id: 'openai', label: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'gemini', label: 'Gemini' },
    { id: 'custom', label: '自定义', meta: String(customProfiles.length) },
  ]

  const editorTabs: Array<{ id: typeof editorTab; label: string }> = [
    { id: 'basic', label: '基础' },
    { id: 'models', label: '模型' },
    { id: 'capabilities', label: '能力' },
    { id: 'conversation', label: '对话' },
  ]

  const selectedTestLabel = testStatus === 'testing'
    ? '测试中'
    : testStatus === 'success'
      ? '已通过'
      : testStatus === 'error'
        ? '失败'
        : '未测试'
  const selectedTestColor = testStatus === 'success'
    ? 'var(--color-green)'
    : testStatus === 'error'
      ? 'var(--color-red)'
      : 'var(--text-muted)'

  const handleCreateProfile = useCallback(() => {
    addCustomProfile()
    setProfileFilter('custom')
    setEditorTab('basic')
    setProfileDetailOpen(true)
  }, [addCustomProfile])
  const openProfileDetail = useCallback((profileId: string) => {
    selectProfile(profileId)
    setEditorTab('basic')
    setProfileDetailOpen(true)
  }, [selectProfile])
  const selectedIsActive = selectedProfile?.id === activeProfile?.id

  return (
    <div
      className="settings-ai-panel flex w-full flex-col gap-6"
      style={{ maxWidth: profileDetailOpen ? 760 : 1120, margin: profileDetailOpen ? '0 auto' : undefined }}
    >
      {saveStatus === 'error' && (
        <div
          className="flex items-center gap-2 rounded-xl border px-3 py-2 text-[12px]"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-red) 22%, transparent)',
            background: 'color-mix(in srgb, var(--color-red-light) 28%, transparent)',
            color: 'var(--color-red)',
          }}
        >
          <XCircle className="h-4 w-4 shrink-0" />
          <span>{saveMessage || '设置保存失败，请重试。'}</span>
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]"
        style={{
          borderTop: '1px solid color-mix(in srgb, var(--surface-border) 16%, transparent)',
          borderBottom: '1px solid color-mix(in srgb, var(--surface-border) 16%, transparent)',
          padding: '18px 0',
          color: 'var(--text-light)',
        }}
      >
        <span>
          当前默认 <strong style={{ color: 'var(--text-title)', fontWeight: 600 }}>{activeProfile?.name || '未设置'}</strong>
        </span>
        <span>{activeProfile?.config.model || '未设置模型'}</span>
        <span>{activeProfile ? formatInterfaceLabel(activeProfile.config) : '未设置接口'}</span>
        <span style={{ color: selectedTestColor }}>{selectedTestLabel}</span>
        {selectedProfile && (
          <button
            type="button"
            onClick={() => void testConnection(selectedProfile.id)}
            disabled={testStatus === 'testing'}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full text-[13px] font-semibold transition-[filter,opacity] hover:brightness-110 disabled:opacity-50"
            style={{ color: 'var(--color-blue)' }}
          >
            {testStatus === 'testing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            测试当前
            {typeof testLatency === 'number' && testStatus === 'success' ? ` · ${testLatency}ms` : ''}
          </button>
        )}
      </div>

      {!profileDetailOpen && (
        <section
          className="rounded-2xl border"
          style={{
            borderColor: 'color-mix(in srgb, var(--surface-border) 12%, transparent)',
            background: 'color-mix(in srgb, var(--surface-card-bg) 3%, transparent)',
          }}
        >
          <div className="flex items-start justify-between gap-5" style={{ padding: '32px 42px 22px' }}>
            <div>
              <div className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>模型入口列表</div>
              <div className="mt-1.5 text-[13px]" style={{ color: 'var(--text-light)' }}>
                管理聊天和 Agent 可使用的模型预设。
              </div>
            </div>
            <button
              type="button"
              onClick={handleCreateProfile}
              className="rounded-full text-[13px] font-semibold transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
              style={{
                ...SETTINGS_FLAT_BUTTON_STYLE,
                minWidth: 0,
                padding: '10px 16px',
                borderRadius: 999,
                color: 'var(--color-blue)',
              }}
            >
              添加模型
            </button>
          </div>

          <div className="flex flex-wrap gap-2" style={{ padding: '0 42px 24px' }}>
            {providerFilters.map((filter) => {
              const active = profileFilter === filter.id
              return (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setProfileFilter(filter.id)}
                  className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${active ? '' : 'hover:bg-[var(--bg-hover)]'}`}
                  style={{
                    ...(active ? { background: 'color-mix(in srgb, var(--color-blue-light) 42%, transparent)' } : {}),
                    color: active ? 'var(--color-blue)' : 'var(--text-muted)',
                  }}
                >
                  {filter.label}{filter.meta ? ` ${filter.meta}` : ''}
                </button>
              )
            })}
          </div>

          <div className="overflow-x-auto">
            <div style={{ minWidth: 880 }}>
              <div
                className="grid items-center gap-7 text-[12px] font-medium"
                style={{
                  gridTemplateColumns: 'minmax(360px,1.6fr) minmax(160px,.55fr) 120px 88px',
                  padding: '14px 42px',
                  borderTop: '1px solid color-mix(in srgb, var(--surface-border) 12%, transparent)',
                  borderBottom: '1px solid color-mix(in srgb, var(--surface-border) 12%, transparent)',
                  background: 'color-mix(in srgb, var(--surface-card-bg) 4%, transparent)',
                  color: 'var(--text-light)',
                }}
              >
                <span>模型入口</span>
                <span>接口</span>
                <span>状态</span>
                <span className="text-right">操作</span>
              </div>
              {visibleProfiles.map((profile) => {
                const selected = profile.id === selectedProfile?.id
                const current = profile.id === activeProfile?.id
                const rowTestLabel = selected ? selectedTestLabel : '未测试'
                return (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => openProfileDetail(profile.id)}
                    className={`grid w-full items-center gap-7 text-left transition-colors duration-150 ${selected ? '' : 'hover:bg-[var(--bg-hover)]'}`}
                    style={{
                      gridTemplateColumns: 'minmax(360px,1.6fr) minmax(160px,.55fr) 120px 88px',
                      minHeight: 88,
                      padding: '18px 42px',
                      borderBottom: '1px solid color-mix(in srgb, var(--surface-border) 10%, transparent)',
                      ...(selected ? { background: 'color-mix(in srgb, var(--color-blue-light) 14%, transparent)' } : {}),
                    }}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[15px] font-semibold" style={{ color: selected ? 'var(--color-blue)' : 'var(--text-title)' }}>{profile.name}</span>
                        {current && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--color-green)' }} />}
                      </span>
                      <span className="mt-1.5 block truncate text-[12px]" style={{ color: 'var(--text-light)' }}>
                        {profile.config.model || '未设置模型'} · {profile.category === 'custom' ? '自定义' : profile.category}
                      </span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]" style={{ color: 'var(--text-body)' }}>{formatInterfaceLabel(profile.config)}</span>
                    </span>
                    <span className="text-[13px]" style={{ color: selected ? selectedTestColor : 'var(--text-muted)' }}>{rowTestLabel}</span>
                    <span className="text-right text-[13px] font-semibold" style={{ color: 'var(--color-blue)' }}>
                      配置
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {profileDetailOpen && selectedProfile && (
        <section style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
          <button
            type="button"
            onClick={() => {
              setProfileDetailOpen(false)
              setEditorTab('basic')
            }}
            className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-semibold"
            style={{ color: 'var(--text-light)' }}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            返回模型列表
          </button>

          <div
            className="rounded-2xl border"
            style={{
              borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
              background: 'color-mix(in srgb, var(--surface-card-bg) 4%, transparent)',
            }}
          >
            <div className="flex items-start justify-between gap-4" style={{ padding: '28px 30px 18px' }}>
              <div className="min-w-0">
                <div className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>编辑 {selectedProfile.name}</div>
                <div className="mt-1.5 truncate text-[13px]" style={{ color: 'var(--text-light)' }}>
                  {selectedConfig.model || '未设置模型'} · {formatInterfaceLabel(selectedConfig)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!selectedIsActive && (
                  <button
                    type="button"
                    onClick={() => activateProfile(selectedProfile.id)}
                    className="rounded-lg px-2 py-1 text-[13px] font-semibold transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--color-blue)' }}
                  >
                    设为默认
                  </button>
                )}
                {!selectedProfile.builtIn && (
                  <button
                    type="button"
                    onClick={() => removeCustomProfile(selectedProfile.id)}
                    className="rounded-lg px-2 py-1 text-[13px] font-semibold transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'color-mix(in srgb, var(--color-red) 68%, var(--text-muted) 32%)' }}
                  >
                    删除
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void testConnection(selectedProfile.id)}
                  disabled={testStatus === 'testing'}
                  className="rounded-full text-[13px] font-semibold transition-[filter,transform] hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                  style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '10px 15px', borderRadius: 999 }}
                >
                  {testStatus === 'testing' ? '测试中' : '测试'}
                </button>
              </div>
            </div>

            <div style={{ padding: '0 30px 28px' }}>
              <div
                role="tablist"
                aria-label="模型配置分区"
                className="inline-grid grid-cols-4 items-center gap-1.5 rounded-2xl border p-1.5"
                style={{
                  width: 304,
                  borderColor: 'color-mix(in srgb, var(--surface-border) 24%, transparent)',
                  background: 'color-mix(in srgb, var(--surface-card-bg) 22%, transparent)',
                }}
              >
              {editorTabs.map((tab) => {
                const active = editorTab === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setEditorTab(tab.id)}
                    className={`rounded-xl px-3 py-2.5 text-[14px] font-semibold leading-none transition-colors ${active ? '' : 'hover:bg-[var(--bg-hover)]'}`}
                    style={{
                      minHeight: 36,
                      ...(active ? { background: 'color-mix(in srgb, var(--color-blue-light) 66%, var(--surface-floating-bg) 34%)' } : {}),
                      color: active ? 'var(--color-blue)' : 'var(--text-muted)',
                      boxShadow: active ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 16%, transparent)' : 'none',
                    }}
                  >
                    {tab.label}
                  </button>
                )
              })}
              </div>
            </div>

            <div style={{ padding: '0 30px 30px' }}>
              {editorTab === 'basic' && (
                <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
                  <AISettingsFieldCard
                    title="预设名称"
                    description="聊天区和设置页里看到的名字。"
                    control={(
                      <input
                        type="text"
                        value={selectedProfile.name}
                        onChange={(event) => renameProfile(selectedProfile.id, event.target.value)}
                        placeholder="给这个预设起个容易识别的名字"
                        className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30"
                        style={stackedInputStyle}
                      />
                    )}
                  />
                  <AISettingsFieldCard
                    title="API 格式"
                    description={`当前解析为 ${resolvedAgentInterfaceLabel}。`}
                    control={(
                      <select
                        value={selectedConfig.agentProtocol || 'auto'}
                        onChange={(event) => updateField('agentProtocol', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.agentProtocol)}
                        className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                        style={stackedSelectStyle}
                      >
                        <option value="auto">自动</option>
                        <option value="openai">OpenAI 兼容</option>
                        <option value="anthropic">Anthropic 兼容</option>
                      </select>
                    )}
                  />
                  <AISettingsFieldCard
                    title="API 地址"
                    wide
                    description={currentProvider?.helpUrl ? (
                      <>
                        服务端点 URL，<a href={currentProvider.helpUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>查看文档</a>
                      </>
                    ) : '自定义供应商地址；OpenAI 兼容服务只填域名或 IP 时会自动使用 /v1'}
                    control={(
                      <input
                        type="text"
                        value={selectedConfig.baseUrl}
                        onChange={(event) => updateField('baseUrl', event.target.value)}
                        placeholder={currentProvider?.baseUrl || 'https://...'}
                        className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30"
                        style={stackedInputStyle}
                      />
                    )}
                  />
                  <AISettingsFieldCard
                    title="API Key"
                    wide
                    description={currentProvider?.apiKeyPlaceholder || 'sk-...'}
                    control={(
                      <div className="flex items-center gap-2">
                        <input
                          type={showKey ? 'text' : 'password'}
                          value={selectedConfig.apiKey}
                          onChange={(event) => updateField('apiKey', event.target.value)}
                          placeholder={currentProvider?.apiKeyPlaceholder || 'sk-...'}
                          className="min-w-0 flex-1 rounded-lg border font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30"
                          style={stackedInputStyle}
                        />
                        <button
                          type="button"
                          onClick={() => setShowKey((value) => !value)}
                          className="shrink-0 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {showKey ? '隐藏' : '显示'}
                        </button>
                      </div>
                    )}
                  />
                  <div
                    className="flex items-center justify-between gap-3 pb-4 md:col-span-2"
                    style={{ borderBottom: '1px solid color-mix(in srgb, var(--surface-border) 12%, transparent)' }}
                  >
                    <span className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>在切换面板显示</span>
                    <SettingsSwitch
                      checked={selectedProfile.showInChatSwitcher}
                      onChange={(checked) => setProfileVisibility(selectedProfile.id, checked)}
                    />
                  </div>
                </div>
              )}

              {editorTab === 'models' && (
                <div className="grid gap-4">
                  <AISettingsFieldCard
                    title="默认模型"
                    description="从下面维护的模型 ID 里选择这个预设默认调用的模型。"
                    control={(
                      <select
                        value={selectedConfig.model}
                        onChange={(event) => updateField('model', event.target.value)}
                        disabled={defaultModelOptions.length === 0}
                        className="rounded-lg border font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 disabled:opacity-50"
                        style={stackedSelectStyle}
                      >
                        {defaultModelOptions.length > 0 ? defaultModelOptions.map((modelId) => (
                          <option key={modelId} value={modelId}>
                            {modelId}
                          </option>
                        )) : (
                          <option value="">先添加模型 ID</option>
                        )}
                      </select>
                    )}
                  />
                  <AISettingsFieldCard
                    title="模型列表"
                    description="给当前预设维护多个模型 ID；设为默认会切换实际调用的主模型。"
                    control={(
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-2">
                          {managedModelIds.length > 0 ? managedModelIds.map((modelId) => {
                            const isDefaultModel = selectedConfig.model === modelId
                            return (
                              <div
                                key={modelId}
                                className="flex items-center gap-2.5 rounded-full border py-2 pl-3.5 pr-2.5 transition-colors"
                                style={SETTINGS_FLAT_CHIP_STYLE}
                              >
                                <span className="font-mono text-[12px]" style={{ color: 'var(--text-body)' }}>{modelId}</span>
                                {isDefaultModel ? (
                                  <span className="rounded-full px-2 py-1 text-[11px] font-semibold" style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green-light) 42%, transparent)' }}>默认</span>
                                ) : (
                                  <button type="button" onClick={() => updateField('model', modelId)} className="rounded-full px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--color-blue)' }}>设默认</button>
                                )}
                                <button type="button" onClick={() => removeModelId(modelId)} className="rounded-full px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--color-red)]" style={{ color: 'var(--text-muted)' }}>删除</button>
                              </div>
                            )
                          }) : (
                            <span className="text-[11px]" style={{ color: 'var(--text-light)' }}>还没有添加模型 ID。</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={pendingModelId}
                            onChange={(event) => setPendingModelId(event.target.value)}
                            placeholder="添加模型 ID，例如 k2.6-code-preview"
                            className="min-w-0 flex-1 rounded-lg border font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30"
                            style={stackedInputStyle}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              addModelId(pendingModelId)
                              setPendingModelId('')
                            }}
                            disabled={!pendingModelId.trim()}
                            className="rounded-full text-[12px] font-semibold transition-[filter,transform] hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '10px 13px' }}
                          >
                            添加模型 ID
                          </button>
                        </div>
                      </div>
                    )}
                  />
                  <AISettingsFieldCard
                    title="上下文窗口"
                    description="覆盖这个模型的上下文 token 上限；留空则使用模型默认值。"
                    control={(
                      <div className="flex flex-col gap-2">
                        <input
                          type="number"
                          min={1}
                          max={2_000_000}
                          step={1000}
                          value={selectedConfig.contextWindowOverride ?? ''}
                          onChange={(event) => updateContextWindowOverride(event.target.value)}
                          placeholder={contextWindowPlaceholder}
                          className="rounded-lg border font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30"
                          style={stackedInputStyle}
                        />
                        {showCustomContextWindowWarning && (
                          <span className="text-[11px] leading-5" style={{ color: 'var(--color-orange)' }}>
                            自定义服务缺少明确上下文窗口，Ready 会先按保守值估算；建议填写服务文档里的 token 上限。
                          </span>
                        )}
                      </div>
                    )}
                  />
                  <AISettingsFieldCard
                    title="单次最大输出 token"
                    description="覆盖单次回复允许生成的 token 上限；留空则使用模型默认值。"
                    control={(
                      <input
                        type="number"
                        min={1}
                        max={1_000_000}
                        step={1000}
                        value={selectedConfig.maxOutputTokensOverride ?? ''}
                        onChange={(event) => updateMaxOutputTokensOverride(event.target.value)}
                        placeholder="自动"
                        className="rounded-lg border font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30"
                        style={stackedInputStyle}
                      />
                    )}
                  />
                  {remoteModels.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {remoteModels.map((modelId) => (
                        <button
                          key={modelId}
                          type="button"
                          onClick={() => addModelId(modelId)}
                          disabled={managedModelIdSet.has(modelId)}
                          className="rounded-full border px-3 py-1 text-[11px] disabled:opacity-50"
                          style={SETTINGS_FLAT_CHIP_STYLE}
                        >
                          {managedModelIdSet.has(modelId) ? `${modelId} 已加入` : `${modelId} 加入预设`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {editorTab === 'capabilities' && (
                <div className="grid gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {capabilities?.agentProtocol === 'openai' && (
                      <AISettingsFieldCard
                        title="OpenAI API 形式"
                        description="在 chat/completions 和 responses 之间切换。"
                        control={(
                          <select
                            value={selectedConfig.wireApi || 'auto'}
                            onChange={(event) => updateField('wireApi', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.wireApi)}
                            className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                            style={stackedSelectStyle}
                          >
                            <option value="auto">自动</option>
                            <option value="chat/completions">chat/completions</option>
                            <option value="responses">responses</option>
                          </select>
                        )}
                      />
                    )}
                    <AISettingsFieldCard
                      title="工具调用"
                      description={toolUsePresentation.description}
                      control={(
                        <select
                          value={selectedConfig.toolUseMode || 'auto'}
                          onChange={(event) => updateField('toolUseMode', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.toolUseMode)}
                          className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                          style={stackedSelectStyle}
                        >
                          <option value="auto">{toolUsePresentation.autoOptionLabel}</option>
                          <option value="on">强制开启</option>
                          <option value="off">关闭</option>
                        </select>
                      )}
                    />
                    <AISettingsFieldCard
                      title="网页视觉"
                      description={`浏览器自动化视觉分析当前为 ${capabilities?.supportsVision ? '开启' : '关闭'}。`}
                      control={(
                        <select
                          value={selectedConfig.visionMode || 'auto'}
                          onChange={(event) => updateField('visionMode', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.visionMode)}
                          className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                          style={stackedSelectStyle}
                        >
                          <option value="auto">自动</option>
                          <option value="on">强制开启</option>
                          <option value="off">关闭</option>
                        </select>
                      )}
                    />
                    {showReasoningEffort && (
                      <AISettingsFieldCard
                        title="思考强度"
                        description="只在 responses 风格接口下显示。"
                        control={(
                          <select
                            value={selectedConfig.reasoningEffort || 'high'}
                            onChange={(event) => updateField('reasoningEffort', event.target.value as typeof selectedConfig.reasoningEffort)}
                            className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                            style={stackedSelectStyle}
                          >
                            <option value="minimal">minimal</option>
                            <option value="low">low</option>
                            <option value="medium">medium</option>
                            <option value="high">high</option>
                          </select>
                        )}
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div>
                      <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>能力分组</div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-light)' }}>需要诊断当前状态时再手动刷新。</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshCapabilityRuntimeSnapshot()}
                      disabled={capabilityRuntimeLoading}
                      className="inline-flex items-center gap-1.5 rounded-full text-[12px] font-semibold disabled:opacity-50"
                      style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '8px 12px', borderRadius: 999 }}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${capabilityRuntimeLoading ? 'animate-spin' : ''}`} />
                      {capabilityRuntimeLoading ? '刷新中' : '刷新状态'}
                    </button>
                  </div>
                  <div className="grid gap-2">
                    {capabilityGroups.map((group) => {
                      const runtimeDisplay = resolveCapabilityRuntimeDisplay(group.id)
                      return (
                        <div
                          key={group.id}
                          className="grid items-center gap-3 rounded-xl border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_96px_72px]"
                          style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 18%, transparent)' }}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>{group.label}</div>
                            <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>{group.description}</div>
                          </div>
                          <select
                            value={getCapabilityModeValue(group.id)}
                            onChange={(event) => updateCapabilityMode(group.id, event.target.value as 'auto' | 'on' | 'off')}
                            className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                            style={{ ...compactSelectStyle, width: 96, padding: '7px 24px 7px 10px' }}
                          >
                            <option value="auto">自动</option>
                            <option value="on">开启</option>
                            <option value="off">关闭</option>
                          </select>
                          <span
                            className="text-right text-[11px] font-semibold"
                            style={{ color: runtimeDisplay.tone === 'positive' ? 'var(--color-green)' : 'var(--text-muted)' }}
                          >
                            {runtimeDisplay.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {editorTab === 'conversation' && (
                <div className="grid gap-3">
                  <div
                    className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
                    style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 18%, transparent)' }}
                  >
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>启用连续消息合并</span>
                    <SettingsSwitch
                      checked={messageCoalesceEnabled}
                      onChange={(next) => {
                        setMessageCoalesceEnabled(next)
                        persistBridgeSetting('agent_message_coalesce_enabled', String(next))
                      }}
                    />
                  </div>
                  <label
                    className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3"
                    style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 18%, transparent)' }}
                  >
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>合并窗口</span>
                    <select
                      value={messageCoalesceWindowMs}
                      onChange={(event) => {
                        setMessageCoalesceWindowMs(event.target.value)
                        persistBridgeSetting('agent_message_coalesce_window_ms', event.target.value)
                      }}
                      className="text-[12px] outline-none cursor-pointer"
                      style={{ ...compactSelectStyle, width: 128, marginTop: 0, textAlign: 'center', textAlignLast: 'center' }}
                    >
                      <option value="600">0.6 秒</option>
                      <option value="1000">1.0 秒</option>
                      <option value="1200">1.2 秒</option>
                      <option value="1800">1.8 秒</option>
                      <option value="2500">2.5 秒</option>
                    </select>
                  </label>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {profileDetailOpen && currentProvider && (
        <div className="px-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-light)', marginTop: -10 }}>
          {selectedConfig.provider === 'anthropic' && (
            <>Anthropic API 使用 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>x-api-key</code> 认证头，系统会自动处理。</>
          )}
          {selectedConfig.provider === 'gemini' && (
            <>Gemini API 使用 OpenAI 兼容层，API Key 在 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>Google AI Studio</a> 获取。</>
          )}
          {selectedConfig.provider === 'volcengine' && (
            <>火山方舟需要先在<a href="https://console.volcengine.com/ark" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>控制台</a>创建推理接入点。</>
          )}
          {selectedConfig.provider === 'moonshot' && (
            <>Moonshot API 完全兼容 OpenAI SDK，在<a href="https://platform.moonshot.cn/console" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>月之暗面控制台</a>获取 API Key。</>
          )}
          {selectedConfig.provider === 'openai' && (
            <>输入任意 OpenAI 或 Anthropic 兼容 API 的地址和密钥；需要浏览器 / 文档工具可用时，再到能力页同步设置。</>
          )}
        </div>
      )}
    </div>
  )
}
