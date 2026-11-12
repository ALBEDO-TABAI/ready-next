import { useState, useEffect, useCallback, useMemo } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw } from 'lucide-react'
import { resolveAIConfigCapabilities, getActiveAIProfile } from '../../../shared/ai-providers'
import {
  isKimiK3Config,
  KIMI_K3_REASONING_EFFORTS,
} from '../../../shared/ai-providers/kimi-k3'
import type { CapabilityRuntimeSnapshot } from '../../../shared/ai-capability-runtime'
import { listSettingsCapabilityGroups, type CapabilityGroupId } from '../../../shared/ai-capability-groups'
import { useSettings, getProviderDef } from '../../stores/useSettings'
import type { AIProviderCategory } from '../../stores/useSettings'
import { Button, Input, Segmented, Select, Switch, Tabs } from '../../components/ui'
import {
  AISettingsFieldCard,
  SettingsCard,
  SettingsNotice,
  SettingsStatus,
  type SettingsTone,
} from './settings-shared'
import { resolveToolUseModePresentation } from './tool-use-mode-copy'
import {
  isChatGptOAuthConfig,
  normalizeChatGptOAuthReasoningEffort,
} from '../../../shared/chatgpt-oauth'
import { ChatGptOAuthSettingsCard } from './ChatGptOAuthSettingsCard'

const AGENT_PROTOCOL_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic 兼容' },
]
const WIRE_API_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'chat/completions', label: 'chat/completions' },
  { value: 'responses', label: 'responses' },
]
const VISION_MODE_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'on', label: '强制开启' },
  { value: 'off', label: '关闭' },
]
const CAPABILITY_MODE_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
]

// ── AI Settings Panel (dynamic, wired to backend) ──────────────────────────
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
  const [editorTab, setEditorTab] = useState<'basic' | 'models' | 'capabilities'>('basic')
  const [profileFilter, setProfileFilter] = useState<'all' | AIProviderCategory>('all')
  const [profileDetailOpen, setProfileDetailOpen] = useState(false)
  const [capabilityRuntimeSnapshot, setCapabilityRuntimeSnapshot] = useState<CapabilityRuntimeSnapshot | null>(null)
  const [capabilityRuntimeSnapshotKey, setCapabilityRuntimeSnapshotKey] = useState<string | null>(null)
  const [capabilityRuntimeLoading, setCapabilityRuntimeLoading] = useState(false)

  const selectedProfile = useMemo(
    () => workspace.profiles.find((profile) => profile.id === (selectedProfileId || workspace.activeProfileId)) || null,
    [workspace, selectedProfileId]
  )
  const activeProfile = useMemo(() => getActiveAIProfile(workspace), [workspace])
  const selectedConfig = selectedProfile?.config || activeConfig
  const isChatGptOAuth = isChatGptOAuthConfig(selectedConfig)
  const currentProvider = getProviderDef(selectedConfig.provider, selectedConfig.baseUrl)
  const capabilities = useMemo(() => resolveAIConfigCapabilities(selectedConfig), [selectedConfig])
  const toolUsePresentation = useMemo(
    () => resolveToolUseModePresentation(selectedConfig),
    [selectedConfig]
  )
  const models = currentProvider?.models || []
  const isKimiK3 = isKimiK3Config(selectedConfig)
  const showReasoningEffort = isKimiK3 || (!isChatGptOAuth && capabilities?.agentProtocol === 'openai' && capabilities?.wireApi === 'responses')
  const reasoningEffortOptions = isKimiK3
    ? KIMI_K3_REASONING_EFFORTS
    : ['minimal', 'low', 'medium', 'high'] as const
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
      // 能力分组是密集列表，启用态用墨色点，避免一整列强调色。
      tone: 'ink' as const,
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
  ]

  const selectedTestLabel = testStatus === 'testing'
    ? '测试中'
    : testStatus === 'success'
      ? '已通过'
      : testStatus === 'error'
        ? '失败'
        : '未测试'
  // 测试状态只用圆点表达：通过 = 强调色点，失败 = 红点，其余中性；不使用成功绿。
  const selectedTestTone: SettingsTone = testStatus === 'success'
    ? 'accent'
    : testStatus === 'error'
      ? 'danger'
      : 'muted'

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
      className="settings-ai-panel flex w-full flex-col gap-5"
      style={{ maxWidth: profileDetailOpen ? 880 : 1120 }}
    >
      {saveStatus === 'error' && (
        <SettingsNotice tone="danger" title="设置保存失败">
          {saveMessage || '设置保存失败，请重试。'}
        </SettingsNotice>
      )}

      {/* 当前默认摘要：名称用墨色，状态只用一个小圆点表达 */}
      <SettingsCard>
        <div className="sx-row">
          <div className="sx-row__text">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[12px]" style={{ color: 'var(--rn-ink-2)' }}>当前默认</span>
              <span className="truncate text-[14px] font-semibold" style={{ color: 'var(--rn-ink)' }}>
                {activeProfile?.name || '未设置'}
              </span>
            </div>
            <div className="sx-row__desc flex flex-wrap items-center gap-x-2">
              <span className="sx-mono text-[11.5px]">{activeProfile?.config.model || '未设置模型'}</span>
              <span aria-hidden>·</span>
              <span>{activeProfile ? formatInterfaceLabel(activeProfile.config) : '未设置接口'}</span>
            </div>
          </div>
          <div className="sx-row__control gap-4">
            <SettingsStatus tone={selectedTestTone}>
              {selectedTestLabel}
              {typeof testLatency === 'number' && testStatus === 'success' ? ` · ${testLatency}ms` : ''}
            </SettingsStatus>
            {selectedProfile && (
              <Button
                size="sm"
                onClick={() => void testConnection(selectedProfile.id)}
                disabled={testStatus === 'testing'}
                aria-busy={testStatus === 'testing' ? true : undefined}
                icon={testStatus === 'testing' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              >
                测试当前
              </Button>
            )}
          </div>
        </div>
      </SettingsCard>

      {!profileDetailOpen && (
        <SettingsCard
          title="模型入口列表"
          description="管理聊天和 Agent 可使用的模型预设。"
          actions={(
            <Button size="sm" icon={<Plus />} onClick={handleCreateProfile}>
              添加模型
            </Button>
          )}
        >
          <div style={{ padding: '0 20px 14px' }}>
            <Segmented
              label="按供应商筛选模型入口"
              value={profileFilter}
              onChange={setProfileFilter}
              options={providerFilters.map((filter) => ({
                value: filter.id,
                label: filter.label,
                count: filter.meta,
              }))}
            />
          </div>

          <div className="sx-table">
            <div
              className="sx-table__head"
              style={{ gridTemplateColumns: 'minmax(360px,1.6fr) minmax(160px,.55fr) 120px 88px' }}
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
                  data-interactive="true"
                  onClick={() => openProfileDetail(profile.id)}
                  className="sx-table__row w-full text-left"
                  style={{ gridTemplateColumns: 'minmax(360px,1.6fr) minmax(160px,.55fr) 120px 88px', minHeight: 64 }}
                >
                  <span className="min-w-0 py-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13.5px] font-semibold" style={{ color: 'var(--rn-ink)' }}>{profile.name}</span>
                      {current && <span className="sx-dot sx-dot--accent" title="当前默认" aria-label="当前默认" />}
                    </span>
                    <span className="mt-1 block truncate text-[11.5px]" style={{ color: 'var(--rn-ink-2)' }}>
                      <span className="sx-mono">{profile.config.model || '未设置模型'}</span> · {profile.category === 'custom' ? '自定义' : profile.category}
                    </span>
                  </span>
                  <span className="min-w-0 truncate text-[12.5px]" style={{ color: 'var(--rn-ink)' }}>
                    {formatInterfaceLabel(profile.config)}
                  </span>
                  <SettingsStatus tone={selected ? selectedTestTone : 'muted'}>{rowTestLabel}</SettingsStatus>
                  <span className="flex justify-end">
                    {/* The whole row is the button; this is the ghost button's look on a span (no button inside a button). */}
                    <span className="rn-btn sx-table__action" data-variant="ghost" data-size="sm">
                      配置
                      <ChevronRight />
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </SettingsCard>
      )}

      {profileDetailOpen && selectedProfile && (
        <section className="flex flex-col gap-3" style={{ maxWidth: 880, width: '100%' }}>
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon={<ChevronLeft />}
              onClick={() => {
                setProfileDetailOpen(false)
                setEditorTab('basic')
              }}
              style={{ paddingLeft: 6 }}
            >
              返回模型列表
            </Button>
          </div>

          <SettingsCard
            title={<>编辑 {selectedProfile.name}</>}
            description={(
              <>
                <span className="sx-mono text-[11.5px]">{selectedConfig.model || '未设置模型'}</span> · {formatInterfaceLabel(selectedConfig)}
              </>
            )}
            actions={(
              <>
                {selectedIsActive ? (
                  <SettingsStatus tone="accent" className="mr-1">当前默认</SettingsStatus>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => activateProfile(selectedProfile.id)}>
                    设为默认
                  </Button>
                )}
                {!selectedProfile.builtIn && (
                  <Button variant="danger" size="sm" onClick={() => removeCustomProfile(selectedProfile.id)}>
                    删除
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => void testConnection(selectedProfile.id)}
                  disabled={testStatus === 'testing'}
                  aria-busy={testStatus === 'testing' ? true : undefined}
                  icon={testStatus === 'testing' ? <Loader2 className="animate-spin" /> : undefined}
                >
                  {testStatus === 'testing' ? '测试中' : '测试'}
                </Button>
              </>
            )}
          >
            <div className="sx-card__body" style={{ paddingTop: 16, paddingBottom: 22 }}>
              <Tabs
                label="模型配置分区"
                value={editorTab}
                onChange={(id) => setEditorTab(id as typeof editorTab)}
                items={editorTabs}
              />

              <div className="mt-6">
                {editorTab === 'basic' && (
                  <div className="grid gap-x-5 gap-y-6 md:grid-cols-2">
                    <AISettingsFieldCard
                      title="预设名称"
                      description="聊天区和设置页里看到的名字。"
                      control={(
                        <Input
                          type="text"
                          value={selectedProfile.name}
                          onChange={(event) => renameProfile(selectedProfile.id, event.target.value)}
                          placeholder="给这个预设起个容易识别的名字"
                        />
                      )}
                    />
                    {!isChatGptOAuth && (
                      <>
                        <AISettingsFieldCard
                          title="API 格式"
                          description={`当前解析为 ${resolvedAgentInterfaceLabel}。`}
                          control={(
                            <Select
                              className="w-full"
                              value={selectedConfig.agentProtocol || 'auto'}
                              onChange={(event) => updateField('agentProtocol', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.agentProtocol)}
                              options={AGENT_PROTOCOL_OPTIONS}
                            />
                          )}
                        />
                        <AISettingsFieldCard
                          title="API 地址"
                          wide
                          description={currentProvider?.helpUrl ? (
                            <>
                              服务端点 URL，<a href={currentProvider.helpUrl} target="_blank" rel="noreferrer" className="sx-link">查看文档</a>
                            </>
                          ) : '自定义供应商地址；OpenAI 兼容服务只填域名或 IP 时会自动使用 /v1'}
                          control={(
                            <Input
                              type="text"
                              value={selectedConfig.baseUrl}
                              onChange={(event) => updateField('baseUrl', event.target.value)}
                              placeholder={currentProvider?.baseUrl || 'https://...'}
                              className="sx-mono"
                            />
                          )}
                        />
                        <AISettingsFieldCard
                          title="API Key"
                          wide
                          description={currentProvider?.apiKeyPlaceholder || 'sk-...'}
                          control={(
                            <div className="flex items-center gap-2">
                              <Input
                                type={showKey ? 'text' : 'password'}
                                value={selectedConfig.apiKey}
                                onChange={(event) => updateField('apiKey', event.target.value)}
                                placeholder={currentProvider?.apiKeyPlaceholder || 'sk-...'}
                                className="sx-mono min-w-0 flex-1"
                              />
                              <Button variant="ghost" size="sm" onClick={() => setShowKey((value) => !value)}>
                                {showKey ? '隐藏' : '显示'}
                              </Button>
                            </div>
                          )}
                        />
                      </>
                    )}
                    {selectedConfig.provider === 'openai' && (
                      <ChatGptOAuthSettingsCard
                        active={isChatGptOAuth}
                        reasoningEffort={normalizeChatGptOAuthReasoningEffort(selectedConfig.reasoningEffort)}
                        onReasoningEffortChange={(effort) => updateField('reasoningEffort', effort)}
                        onConnected={async () => {
                          await loadConfig()
                        }}
                        onDisconnected={async () => {
                          await loadConfig()
                          setProfileDetailOpen(false)
                        }}
                      />
                    )}
                    <div
                      className="flex items-center justify-between gap-4 pt-3 md:col-span-2"
                    >
                      <div className="min-w-0">
                        <div className="sx-row__label">在切换面板显示</div>
                        <div className="sx-row__desc">关闭后这个预设不会出现在聊天区的模型切换菜单里。</div>
                      </div>
                      <Switch
                        checked={selectedProfile.showInChatSwitcher}
                        label="在切换面板显示"
                        onChange={(checked) => setProfileVisibility(selectedProfile.id, checked)}
                      />
                    </div>
                  </div>
                )}

                {editorTab === 'models' && (
                  <div className="grid gap-6">
                    <AISettingsFieldCard
                      title="默认模型"
                      description="从下面维护的模型 ID 里选择这个预设默认调用的模型。"
                      control={(
                        <Select
                          value={selectedConfig.model}
                          onChange={(event) => updateField('model', event.target.value)}
                          disabled={defaultModelOptions.length === 0}
                          className="sx-mono w-full"
                          options={defaultModelOptions.length > 0
                            ? defaultModelOptions.map((modelId) => ({ value: modelId, label: modelId }))
                            : [{ value: '', label: '先添加模型 ID' }]}
                        />
                      )}
                    />
                    <AISettingsFieldCard
                      title="模型列表"
                      description="给当前预设维护多个模型 ID；设为默认会切换实际调用的主模型。"
                      control={(
                        <div className="flex flex-col gap-3">
                          {managedModelIds.length > 0 ? (
                            <div className="sx-inset">
                              {managedModelIds.map((modelId, index) => {
                                const isDefaultModel = selectedConfig.model === modelId
                                return (
                                  <div
                                    key={modelId}
                                    className="flex items-center gap-3 px-3"
                                    style={{ minHeight: 40, borderTop: index > 0 ? '1px solid var(--rn-hair)' : undefined }}
                                  >
                                    <span className="sx-mono min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--rn-ink)' }}>{modelId}</span>
                                    {isDefaultModel ? (
                                      <span className="sx-badge">
                                        <span className="sx-dot sx-dot--accent" aria-hidden />
                                        默认
                                      </span>
                                    ) : (
                                      <Button variant="ghost" size="sm" onClick={() => updateField('model', modelId)}>设默认</Button>
                                    )}
                                    <Button variant="ghost" size="sm" onClick={() => removeModelId(modelId)}>删除</Button>
                                  </div>
                                )
                              })}
                            </div>
                          ) : (
                            <span className="sx-meta">还没有添加模型 ID。</span>
                          )}
                          <div className="flex items-center gap-2">
                            <Input
                              type="text"
                              value={pendingModelId}
                              onChange={(event) => setPendingModelId(event.target.value)}
                              placeholder="添加模型 ID，例如 k2.6-code-preview"
                              className="sx-mono min-w-0 flex-1"
                            />
                            <Button
                              icon={<Plus />}
                              onClick={() => {
                                addModelId(pendingModelId)
                                setPendingModelId('')
                              }}
                              disabled={!pendingModelId.trim()}
                            >
                              添加模型 ID
                            </Button>
                          </div>
                        </div>
                      )}
                    />
                    <div className="grid gap-x-5 gap-y-6 md:grid-cols-2">
                      <AISettingsFieldCard
                        title="上下文窗口"
                        description="覆盖这个模型的上下文 token 上限；留空则使用模型默认值。"
                        control={(
                          <div className="flex flex-col gap-2">
                            <Input
                              type="number"
                              min={1}
                              max={2_000_000}
                              step={1000}
                              value={selectedConfig.contextWindowOverride ?? ''}
                              onChange={(event) => updateContextWindowOverride(event.target.value)}
                              placeholder={contextWindowPlaceholder}
                              className="sx-mono"
                            />
                            {showCustomContextWindowWarning && (
                              <span className="sx-text-warning flex items-start gap-1.5 text-[11.5px] leading-5">
                                <AlertTriangle className="mt-[3px] h-3 w-3 shrink-0" />
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
                          <Input
                            type="number"
                            min={1}
                            max={1_000_000}
                            step={1000}
                            value={selectedConfig.maxOutputTokensOverride ?? ''}
                            onChange={(event) => updateMaxOutputTokensOverride(event.target.value)}
                            placeholder="自动"
                            className="sx-mono"
                          />
                        )}
                      />
                    </div>
                    {remoteModels.length > 0 && (
                      <div className="flex flex-col gap-2">
                        <div className="sx-field__label">服务端可用模型</div>
                        <div className="flex flex-wrap gap-2">
                          {remoteModels.map((modelId) => (
                            <Button
                              key={modelId}
                              size="sm"
                              className="sx-mono"
                              onClick={() => addModelId(modelId)}
                              disabled={managedModelIdSet.has(modelId)}
                            >
                              {managedModelIdSet.has(modelId) ? `${modelId} 已加入` : `${modelId} 加入预设`}
                            </Button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {editorTab === 'capabilities' && (
                  <div className="grid gap-6">
                    <div className="grid gap-x-5 gap-y-6 sm:grid-cols-2">
                      {capabilities?.agentProtocol === 'openai' && (
                        <AISettingsFieldCard
                          title="OpenAI API 形式"
                          description="在 chat/completions 和 responses 之间切换。"
                          control={(
                            <Select
                              className="w-full"
                              value={selectedConfig.wireApi || 'auto'}
                              onChange={(event) => updateField('wireApi', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.wireApi)}
                              options={WIRE_API_OPTIONS}
                            />
                          )}
                        />
                      )}
                      <AISettingsFieldCard
                        title="工具调用"
                        description={toolUsePresentation.description}
                        control={(
                          <Select
                            className="w-full"
                            value={selectedConfig.toolUseMode || 'auto'}
                            onChange={(event) => updateField('toolUseMode', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.toolUseMode)}
                            options={[
                              { value: 'auto', label: toolUsePresentation.autoOptionLabel },
                              { value: 'on', label: '强制开启' },
                              { value: 'off', label: '关闭' },
                            ]}
                          />
                        )}
                      />
                      <AISettingsFieldCard
                        title="网页视觉"
                        description={`浏览器自动化视觉分析当前为 ${capabilities?.supportsVision ? '开启' : '关闭'}。`}
                        control={(
                          <Select
                            className="w-full"
                            value={selectedConfig.visionMode || 'auto'}
                            onChange={(event) => updateField('visionMode', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.visionMode)}
                            options={VISION_MODE_OPTIONS}
                          />
                        )}
                      />
                      {showReasoningEffort && (
                        <AISettingsFieldCard
                          title="思考强度"
                          description={isKimiK3 ? 'K3 支持 low / high / max，默认 high。' : '只在 responses 风格接口下显示。'}
                          control={(
                            <Select
                              className="w-full"
                              value={selectedConfig.reasoningEffort || 'high'}
                              onChange={(event) => updateField('reasoningEffort', event.target.value as typeof selectedConfig.reasoningEffort)}
                              options={reasoningEffortOptions.map((effort) => ({ value: effort, label: effort }))}
                            />
                          )}
                        />
                      )}
                    </div>

                    <div className="flex flex-col gap-3 pt-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="sx-row__label">能力分组</div>
                          <div className="sx-row__desc">需要诊断当前状态时再手动刷新。</div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => void refreshCapabilityRuntimeSnapshot()}
                          disabled={capabilityRuntimeLoading}
                          aria-busy={capabilityRuntimeLoading ? true : undefined}
                          icon={<RefreshCw className={capabilityRuntimeLoading ? 'animate-spin' : ''} />}
                        >
                          {capabilityRuntimeLoading ? '刷新中' : '刷新状态'}
                        </Button>
                      </div>
                      <div className="sx-inset">
                        {capabilityGroups.map((group, index) => {
                          const runtimeDisplay = resolveCapabilityRuntimeDisplay(group.id)
                          return (
                            <div
                              key={group.id}
                              className="grid items-center gap-3 px-3.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_136px_112px]"
                              style={{ borderTop: index > 0 ? '1px solid var(--rn-hair)' : undefined }}
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[12.5px] font-medium" style={{ color: 'var(--rn-ink)' }}>{group.label}</div>
                                <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--rn-ink-2)' }}>{group.description}</div>
                              </div>
                              <Select
                                value={getCapabilityModeValue(group.id)}
                                onChange={(event) => updateCapabilityMode(group.id, event.target.value as 'auto' | 'on' | 'off')}
                                aria-label={`${group.label}模式`}
                                options={CAPABILITY_MODE_OPTIONS}
                              />
                              <span className="flex justify-end">
                                <SettingsStatus tone={runtimeDisplay.tone}>
                                  <span className="text-[11.5px]">{runtimeDisplay.label}</span>
                                </SettingsStatus>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </SettingsCard>

          {currentProvider && (
            <div className="px-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--rn-ink-2)' }}>
              {selectedConfig.provider === 'anthropic' && (
                <>Anthropic API 使用 <code className="sx-code">x-api-key</code> 认证头，系统会自动处理。</>
              )}
              {selectedConfig.provider === 'gemini' && (
                <>Gemini API 使用 OpenAI 兼容层，API Key 在 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="sx-link">Google AI Studio</a> 获取。</>
              )}
              {selectedConfig.provider === 'volcengine' && (
                <>火山方舟需要先在<a href="https://console.volcengine.com/ark" target="_blank" rel="noreferrer" className="sx-link">控制台</a>创建推理接入点。</>
              )}
              {selectedConfig.provider === 'moonshot' && (
                <>Moonshot API 完全兼容 OpenAI SDK，在<a href="https://platform.moonshot.cn/console" target="_blank" rel="noreferrer" className="sx-link">月之暗面控制台</a>获取 API Key。</>
              )}
              {selectedConfig.provider === 'openai' && !isChatGptOAuth && (
                <>输入任意 OpenAI 或 Anthropic 兼容 API 的地址和密钥；需要浏览器 / 文档工具可用时，再到能力页同步设置。</>
              )}
              {isChatGptOAuth && (
                <>这是非官方实验入口，只使用 Ready 自己保存的登录。断开后会回到原有 OpenAI API Key 预设。</>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
