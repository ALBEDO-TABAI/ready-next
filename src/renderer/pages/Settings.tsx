import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  ChevronLeft, User, Bell, Shield, Database,
  Palette, Keyboard, Globe, Info, Moon, Sun, Bot, Monitor, Droplets,
  ChevronRight, ExternalLink, HardDrive, Trash2, CheckCircle2, XCircle, Loader2, MessageSquare, Brain, Users, Sparkles, Cat,
  Plug2, Boxes
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme, type ThemeAccent, type ThemeSkin } from '../stores/useTheme'
import { resolveAIConfigCapabilities, getActiveAIProfile } from '../../shared/ai-providers'
import type { CapabilityRuntimeSnapshot } from '../../shared/ai-capability-runtime'
import { listSettingsCapabilityGroups, type CapabilityGroupId } from '../../shared/ai-capability-groups'
import { useSettings, getProviderDef } from '../stores/useSettings'
import type { AIProviderCategory } from '../stores/useSettings'
import type { ExternalServiceOptionValue, ExternalServiceUpdateInput, PublicExternalServiceProfile } from '../../shared/external-services'
import RemoteIMSettingsPanel from '../components/settings/RemoteIMSettingsPanel'
import PetSettingsPanel from '../components/settings/PetSettingsPanel'
import ModelsRuntimeSettingsPanel from '../components/settings/ModelsRuntimeSettingsPanel'
import { MODELS_RUNTIME_SETTINGS_SECTION } from '../../shared/model-pack-types'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_FLAT_CARD_STYLE,
  SETTINGS_FLAT_CHIP_STYLE,
  SETTINGS_FLAT_INPUT_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_READONLY_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
  settingsListItemStyle,
} from '../components/settings/settings-theme'
import { MemoryListPanel, TriggerManager, MemoryStatsCard, MemoryCreator } from '../components/memory'
import { useMemories, useMemoryLifecycle, useMemoryStats } from '../hooks/useMemory'
import type { MemoryQueryFilters } from '../types/electron'
import PersonalityEditor from '../components/personality/PersonalityEditor'
import UserProfileEditor from '../components/profile/UserProfileEditor'

interface SettingSection {
  id: string
  title: string
  icon: React.ElementType
  description: string
  settings: SettingItem[]
}

interface SettingItem {
  id: string
  label: string
  description?: string
  type: 'toggle' | 'select' | 'text' | 'button' | 'readonly'
  value?: boolean | string
  options?: { value: string; label: string }[]
  buttonLabel?: string
  buttonVariant?: 'default' | 'danger' | 'primary'
  slotWidth?: 'short' | 'medium' | 'wide'
}

interface RSSDraftStoreSourceRow {
  sourceId: string
  sourceName: string
  sourceUrl: string
  platform: string
  storedCount: number
  inboxCount: number
  starredCount: number
  refreshMode: 'full' | 'incremental'
  lastFetchedAt: string | null
}

const settingsData: SettingSection[] = [
  {
    id: 'account',
    title: '帐号',
    icon: User,
    description: '管理你的帐号信息和个人资料',
    settings: [
      { id: 'username', label: '用户名', description: '显示在应用中的名称', type: 'text', value: 'Ready User' },
      { id: 'email', label: '邮箱', description: '用于接收通知和同步', type: 'text', value: 'user@ready.app' }
    ]
  },
  {
    id: 'ai',
    title: 'AI 模型',
    icon: Bot,
    description: '配置 AI 助手的模型和连接参数',
    settings: [] // Rendered dynamically via AISettingsPanel
  },
  {
    id: 'remote-im',
    title: '远程 IM',
    icon: MessageSquare,
    description: '连接飞书/Telegram，让 Agent 远程执行任务',
    settings: [] // Rendered dynamically via RemoteIMSettingsPanel
  },
  {
    id: 'external-services',
    title: '外部服务',
    icon: ExternalLink,
    description: '统一管理 Tavily、Jina、RSSHub、Bilibili、GitHub、高德地图与读图模型',
    settings: []
  },
  {
    id: 'mcp',
    title: 'MCP',
    icon: Plug2,
    description: '本版本暂未发布 MCP transport / MCP not shipped in this release',
    settings: [] // Rendered dynamically via McpSettingsPanel — Y0.7 §11.0b labeling branch
  },
  {
    id: 'memory',
    title: '记忆系统',
    icon: Brain,
    description: '查看 Agent 已沉淀的记忆，高级工具按需展开',
    settings: [] // Rendered dynamically via Memory components
  },
  {
    id: 'personalities',
    title: 'Agent 人格',
    icon: Sparkles,
    description: '定义聊天面板可切换 Agent 的人格和语气',
    settings: [] // Rendered dynamically via PersonalityEditor
  },
  {
    id: 'user-profiles',
    title: '我的偏好',
    icon: Users,
    description: '保存本机默认用户的语言、风格和长期偏好',
    settings: [] // Rendered dynamically via UserProfileEditor
  },
  {
    id: 'pet',
    title: '宠物',
    icon: Cat,
    description: '管理桌面悬浮宠物和工作气泡',
    settings: []
  },
  {
    id: 'rss-storage',
    title: 'RSS 底稿',
    icon: HardDrive,
    description: '管理 RSS 底稿仓库、增量收件箱和刷新重置',
    settings: []
  },
  {
    id: MODELS_RUNTIME_SETTINGS_SECTION,
    title: '模型与运行时',
    icon: Boxes,
    description: '按需下载语音识别与标点模型，支持国内 / 国外源自动切换与断点续传',
    settings: []
  },
  {
    id: 'appearance',
    title: '外观',
    icon: Palette,
    description: '自定义应用的主题和视觉风格',
    settings: [
      { id: 'theme', label: '主题色', description: '应用的强调色', type: 'select', value: 'blue', options: [
        { value: 'blue', label: '蓝色' },
        { value: 'green', label: '绿色' },
        { value: 'purple', label: '紫色' },
        { value: 'orange', label: '橙色' }
      ]}
    ]
  },
  {
    id: 'notifications',
    title: '通知',
    icon: Bell,
    description: '控制推送通知和声音提示',
    settings: [
      { id: 'pushEnabled', label: '推送通知', description: '接收任务完成和 RSS 更新通知', type: 'toggle', value: true },
      { id: 'soundEnabled', label: '声音提示', description: '操作完成时播放提示音', type: 'toggle', value: true }
    ]
  },
  {
    id: 'privacy',
    title: '隐私',
    icon: Shield,
    description: '管理数据收集和隐私偏好',
    settings: [
      { id: 'analytics', label: '使用分析', description: '帮助我们改善产品体验（匿名数据）', type: 'toggle', value: false },
      { id: 'crashReports', label: '崩溃报告', description: '自动发送崩溃信息协助排查问题', type: 'toggle', value: true }
    ]
  },
  {
    id: 'storage',
    title: '存储',
    icon: Database,
    description: '管理本地缓存和存储空间',
    settings: [] // Rendered dynamically via StorageSettingsPanel
  },
  {
    id: 'shortcuts',
    title: '快捷键',
    icon: Keyboard,
    description: '查看和自定义键盘快捷键',
    settings: [
      { id: 'newTask', label: '新建任务', type: 'readonly', value: '⌘ N', slotWidth: 'short' },
      { id: 'sendMessage', label: '发送消息', type: 'readonly', value: '⌘ Enter', slotWidth: 'short' },
      { id: 'search', label: '全局搜索', type: 'readonly', value: '⌘ K', slotWidth: 'short' },
      { id: 'toggleSidebar', label: '切换侧边栏', type: 'readonly', value: '⌘ B', slotWidth: 'short' },
      { id: 'switchMode', label: '切换模式', type: 'readonly', value: '⌘ 1-6', slotWidth: 'short' }
    ]
  },
  {
    id: 'language',
    title: '语言',
    icon: Globe,
    description: '设置界面显示语言',
    settings: [
      { id: 'language', label: '界面语言', description: '更改后需重启应用', type: 'select', value: 'zh-CN', options: [
        { value: 'zh-CN', label: '简体中文' },
        { value: 'en-US', label: 'English' },
        { value: 'ja-JP', label: '日本語' }
      ]}
    ]
  },
  {
    id: 'about',
    title: '关于',
    icon: Info,
    description: '应用版本信息和更新',
    settings: [
      { id: 'version', label: '当前版本', type: 'readonly', value: 'Ready v0.1.0', slotWidth: 'short' },
      { id: 'checkUpdate', label: '检查更新', description: '查看是否有新版本可用', type: 'button', buttonLabel: '检查更新', buttonVariant: 'primary', slotWidth: 'short' }
    ]
  }
]

// Theme mode options
const themeOptions: { value: 'light' | 'dark' | 'system'; label: string; icon: React.ElementType; description: string }[] = [
  { value: 'light', label: '浅色', icon: Sun, description: '始终使用浅色主题' },
  { value: 'dark', label: '深色', icon: Moon, description: '始终使用深色主题' },
  { value: 'system', label: '跟随系统', icon: Monitor, description: '自动跟随系统设置' }
]

const skinOptions: { value: ThemeSkin; label: string; icon: React.ElementType; description: string }[] = [
  { value: 'liquid-glass', label: '通透玻璃', icon: Droplets, description: '真半透明液态玻璃，背后透出 macOS 桌面壁纸（默认）' },
  { value: 'ready-glass', label: '稳定玻璃', icon: Droplets, description: 'Ready 自持稳定底色，不透出桌面（更稳定但失去通透感）' },
]

const SETTING_SLOT_WIDTHS = {
  short: 136,
  medium: 180,
  wide: 240,
} as const

function AISettingsFieldCard({
  title,
  description,
  control,
  wide = false,
}: {
  title: string
  description: ReactNode
  control: ReactNode
  wide?: boolean
}) {
  return (
    <div
      className={`settings-ai-light-card rounded-2xl border ${wide ? 'md:col-span-2' : ''}`}
      style={{
        ...SETTINGS_FLAT_CARD_STYLE,
        padding: '16px 18px',
      }}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>{title}</div>
        <div className="text-[11px] mt-1 leading-5" style={{ color: 'var(--text-light)', maxWidth: 560 }}>{description}</div>
      </div>
      <div className="mt-3 min-w-0">{control}</div>
    </div>
  )
}

function AISettingsSwitch({
  checked,
  onChange,
  label,
  stopPropagation = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  stopPropagation?: boolean
}) {
  return (
    <label
      className="inline-flex items-center gap-2 text-[11px] font-medium"
      style={{ color: 'var(--text-light)' }}
      onClick={(event) => {
        if (stopPropagation) event.stopPropagation()
      }}
    >
      {label && <span>{label}</span>}
      <span
        className="relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-[background-color,border-color]"
        style={{
          borderColor: checked
            ? 'color-mix(in srgb, var(--color-blue) 42%, transparent)'
            : 'color-mix(in srgb, var(--surface-border) 68%, transparent)',
          background: checked
            ? 'color-mix(in srgb, var(--color-blue) 78%, var(--surface-floating-bg) 22%)'
            : 'color-mix(in srgb, var(--surface-floating-bg) 72%, var(--bg-content) 28%)',
        }}
      >
        <span
          className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: checked ? 'translateX(20px)' : 'translateX(3px)' }}
        />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
    </label>
  )
}

// ── AI Settings Panel (dynamic, wired to backend) ──────────────────────────
const compactSelectStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  borderRadius: 14,
  padding: '8px 28px 8px 12px',
}
const stackedInputStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  borderRadius: 16,
  padding: '11px 14px',
  width: '100%',
  textAlign: 'left' as const,
}
const stackedSelectStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  borderRadius: 16,
  padding: '11px 34px 11px 14px',
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

function AISettingsPanel() {
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
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [pendingModelId, setPendingModelId] = useState('')
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [messageCoalesceEnabled, setMessageCoalesceEnabled] = useState(true)
  const [messageCoalesceWindowMs, setMessageCoalesceWindowMs] = useState('1200')
  const [capabilityRuntimeSnapshot, setCapabilityRuntimeSnapshot] = useState<CapabilityRuntimeSnapshot | null>(null)
  const requestedCapabilitySnapshotKey = useRef<string | null>(null)

  const selectedProfile = useMemo(
    () => workspace.profiles.find((profile) => profile.id === (selectedProfileId || workspace.activeProfileId)) || null,
    [workspace, selectedProfileId]
  )
  const activeProfile = useMemo(() => getActiveAIProfile(workspace), [workspace])
  const selectedConfig = selectedProfile?.config || activeConfig
  const activeCategory = (selectedProfile?.category || 'custom') as AIProviderCategory
  const currentProvider = getProviderDef(selectedConfig.provider, selectedConfig.baseUrl)
  const capabilities = useMemo(() => resolveAIConfigCapabilities(selectedConfig), [selectedConfig])
  const models = currentProvider?.models || []
  const showReasoningEffort = capabilities?.agentProtocol === 'openai' && capabilities?.wireApi === 'responses'
  const capabilityGroups = listSettingsCapabilityGroups()
  const customProfiles = workspace.profiles.filter((profile) => profile.category === 'custom')
  const builtinProfiles = workspace.profiles.filter((profile) => profile.builtIn)
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
  const managedModelIds = selectedConfig.modelIds || (selectedConfig.model ? [selectedConfig.model] : [])
  const managedModelIdSet = new Set(managedModelIds)
  const isCustomModelInput = selectedProfile?.category === 'custom'
    || !knownModel
    || selectedConfig.model === '__custom__'
    || selectedConfig.model === 'custom'

  const persistBridgeSetting = useCallback((key: string, value: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    void window.electronAPI.settings.set(key, value)
  }, [])

  const refreshCapabilityRuntimeSnapshot = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    const result = await window.electronAPI.agent.getCapabilityRuntimeSnapshot(capabilityRuntimeConfig)
    if (!result.success || !result.data) return
    setCapabilityRuntimeSnapshot(result.data)
  }, [capabilityRuntimeConfig])

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
    // 配置详情默认折叠，折叠时不渲染能力分组，也无需拉取运行态快照；
    // 仅在用户展开详情后才按当前 key 拉取，避免切入页面时的同步重渲染卡顿。
    if (!loaded || !detailExpanded) return
    if (requestedCapabilitySnapshotKey.current === capabilitySnapshotKey) return
    requestedCapabilitySnapshotKey.current = capabilitySnapshotKey
    const timer = window.setTimeout(() => {
      void refreshCapabilityRuntimeSnapshot()
    }, 80)
    return () => window.clearTimeout(timer)
  }, [loaded, detailExpanded, capabilitySnapshotKey, refreshCapabilityRuntimeSnapshot])

  useEffect(() => {
    setShowAdvanced(false)
    setDetailExpanded(false)
  }, [selectedProfile?.id])

  useEffect(() => {
    setPendingModelId('')
  }, [selectedProfile?.id])

  const selectCategory = useCallback((category: AIProviderCategory) => {
    if (category === 'custom') {
      const firstCustom = customProfiles[0]
      if (firstCustom) {
        selectProfile(firstCustom.id)
      } else {
        addCustomProfile()
      }
      return
    }

    const builtinProfile = builtinProfiles.find((profile) => profile.category === category)
    if (builtinProfile) {
      selectProfile(builtinProfile.id)
    }
  }, [addCustomProfile, builtinProfiles, customProfiles, selectProfile])

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

  const resolveCapabilityRuntimeDisplay = useCallback((groupId: CapabilityGroupId) => {
    const snapshot = capabilityRuntimeSnapshot?.groups[groupId]
    if (!snapshot) return { label: '待刷新', tone: 'muted' as const }
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
  }, [capabilityRuntimeSnapshot])

  const categoryTabs: Array<{ id: AIProviderCategory; label: string; meta: string }> = [
    { id: 'openai', label: 'OpenAI', meta: '官方 GPT / Responses' },
    { id: 'anthropic', label: 'Anthropic', meta: 'Claude / Messages' },
    { id: 'gemini', label: 'Gemini', meta: 'Google Gemini' },
    { id: 'custom', label: '自定义', meta: `${customProfiles.length} 个预设` },
  ]

  return (
    <div className="settings-ai-panel flex flex-col gap-5">
      {saveStatus === 'error' && (
        <div
          className="settings-ai-light-card flex items-center gap-2 rounded-2xl border"
          style={{
            ...SETTINGS_FLAT_CARD_STYLE,
            padding: '12px 14px',
            borderColor: 'color-mix(in srgb, var(--color-red) 26%, var(--surface-border) 74%)',
            color: 'var(--color-red)',
          }}
        >
          <XCircle className="w-4 h-4 shrink-0" />
          <span className="text-[12px] leading-5">{saveMessage || '设置保存失败，请重试。'}</span>
        </div>
      )}
      <div
        className="glass-surface-card rounded-2xl border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '22px 24px',
        }}
      >
        <div className="flex items-start justify-between gap-5 flex-wrap" style={{ minHeight: 36 }}>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>模型入口</div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
          {categoryTabs.map((tab) => {
            const isActive = activeCategory === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => selectCategory(tab.id)}
                className="settings-ai-light-card settings-ai-provider-tab flex min-h-[76px] flex-col items-center justify-center rounded-2xl border text-center transition-[background-color,border-color,color] duration-200"
                style={{
                  ...SETTINGS_FLAT_CARD_STYLE,
                  padding: '15px 17px',
                  ...(isActive ? {
                    borderColor: 'color-mix(in srgb, var(--color-blue) 34%, var(--lg-border-soft) 66%)',
                    background: 'color-mix(in srgb, var(--color-blue-light) 74%, var(--surface-card-bg) 26%)',
                    boxShadow: 'var(--lg-shadow-contact)',
                  } : {
                    boxShadow: 'none',
                  }),
                }}
              >
                <div className="text-[13px] font-semibold" style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-title)' }}>{tab.label}</div>
                <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-light)' }}>{tab.meta}</div>
              </button>
            )
          })}
        </div>
      </div>

      {activeCategory === 'custom' && (
        <div
          className="glass-surface-card rounded-2xl border"
          style={{
            ...SETTINGS_CARD_STYLE,
            padding: '22px 24px',
          }}
        >
          <div className="flex items-start justify-between gap-5 flex-wrap">
            <div className="min-w-0">
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>自定义预设</div>
            </div>
            <button
              onClick={() => addCustomProfile()}
              className="rounded-full text-[12px] font-semibold"
              style={{
                ...SETTINGS_FLAT_BUTTON_STYLE,
                background: 'color-mix(in srgb, var(--color-blue) 84%, var(--surface-floating-bg) 16%)',
                color: '#fff',
                padding: '9px 16px',
              }}
            >
              新建自定义预设
            </button>
          </div>

          <div className="mt-5 grid gap-3">
            {customProfiles.map((profile) => {
              const isSelected = profile.id === selectedProfile?.id
              const isCurrent = profile.id === activeProfile?.id
              return (
                <div
                  key={profile.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectProfile(profile.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      selectProfile(profile.id)
                    }
                  }}
                  className="settings-ai-light-card rounded-2xl border text-left transition-[background-color,border-color,color] duration-200"
                  style={{
                    ...SETTINGS_FLAT_CARD_STYLE,
                    padding: '14px 18px',
                    ...(isSelected ? {
                      borderColor: 'color-mix(in srgb, var(--color-blue) 32%, var(--lg-border-soft) 68%)',
                      borderTopColor: 'transparent',
                      background: 'color-mix(in srgb, var(--color-blue-light) 72%, var(--surface-card-bg) 28%)',
                      boxShadow: 'none',
                    } : SETTINGS_FLAT_CARD_STYLE),
                  }}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold" style={{ color: isSelected ? 'var(--color-blue)' : 'var(--text-title)' }}>{profile.name}</span>
                        {isCurrent && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                            style={{
                              color: 'var(--color-green)',
                              background: 'color-mix(in srgb, var(--color-green-light) 72%, transparent)',
                            }}
                          >
                            当前生效
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] mt-1.5 truncate" style={{ color: 'var(--text-light)' }}>
                        {profile.config.model || '未设置模型'} · {profile.config.baseUrl || '未设置地址'}
                      </div>
                    </div>
                    <AISettingsSwitch
                      label="切换面板显示"
                      checked={profile.showInChatSwitcher}
                      onChange={(checked) => setProfileVisibility(profile.id, checked)}
                      stopPropagation
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {selectedProfile && (
        <>
          <div
            className="glass-surface-card rounded-2xl border"
            style={{
              ...SETTINGS_CARD_STYLE,
              padding: '22px 24px',
            }}
          >
            <div className="flex items-start justify-between gap-5 flex-wrap">
              <button
                type="button"
                onClick={() => setDetailExpanded((value) => !value)}
                aria-expanded={detailExpanded}
                className="min-w-0 flex items-start gap-2 text-left"
              >
                <ChevronRight
                  className="w-4 h-4 mt-0.5 shrink-0 transition-transform duration-200"
                  style={{ color: 'var(--text-light)', transform: detailExpanded ? 'rotate(90deg)' : 'none' }}
                />
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>{selectedProfile.name}</span>
                  <span className="block text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)', maxWidth: 620 }}>
                    {detailExpanded
                      ? (activeProfile?.id === selectedProfile.id ? '当前默认正在使用这个预设。' : '你可以先调整这里的内容，再决定是否设为当前默认。')
                      : '点击展开模型配置详情进行调整。'}
                  </span>
                </span>
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => testConnection(selectedProfile.id)}
                  disabled={testStatus === 'testing'}
                  title={testMessage || '验证当前地址、密钥和模型是否能通。'}
                  className="flex items-center justify-center gap-1.5 rounded-full text-[12px] font-semibold transition-[filter,transform,opacity] duration-200 hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                  style={{
                    ...SETTINGS_FLAT_BUTTON_STYLE,
                    padding: '9px 14px',
                    color:
                      testStatus === 'success'
                        ? 'var(--color-green)'
                        : testStatus === 'error'
                          ? 'var(--color-red)'
                          : 'var(--text-body)',
                  }}
                >
                  {testStatus === 'testing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {testStatus === 'success' && <CheckCircle2 className="w-3.5 h-3.5" />}
                  {testStatus === 'error' && <XCircle className="w-3.5 h-3.5" />}
                  {testStatus === 'testing' ? '测试中...' : '测试'}
                  {typeof testLatency === 'number' && testStatus === 'success' && (
                    <span className="text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>
                      {testLatency}ms
                    </span>
                  )}
                </button>
                {activeProfile?.id !== selectedProfile.id && (
                  <button
                    onClick={() => activateProfile(selectedProfile.id)}
                    className="rounded-full text-[12px] font-semibold"
                    style={{
                      ...SETTINGS_FLAT_BUTTON_STYLE,
                      padding: '9px 14px',
                    }}
                  >
                    设为当前默认
                  </button>
                )}
                {!selectedProfile.builtIn && (
                  <button
                    onClick={() => removeCustomProfile(selectedProfile.id)}
                    className="rounded-full text-[12px] font-semibold"
                    style={{
                      ...SETTINGS_FLAT_BUTTON_STYLE,
                      borderColor: 'color-mix(in srgb, var(--color-red) 34%, var(--surface-border) 66%)',
                      borderTopColor: 'transparent',
                      background: 'color-mix(in srgb, var(--color-red-light) 70%, var(--surface-card-bg) 30%)',
                      color: 'var(--color-red)',
                      padding: '9px 14px',
                    }}
                  >
                    删除预设
                  </button>
                )}
              </div>
            </div>

            {detailExpanded && (
            <div className="mt-5 grid gap-3 md:grid-cols-2">
            <AISettingsFieldCard
              title="预设名称"
              description="聊天区和设置页里看到的名字。"
              control={(
                <input
                  type="text"
                  value={selectedProfile.name}
                  onChange={(event) => renameProfile(selectedProfile.id, event.target.value)}
                  placeholder="给这个预设起个容易识别的名字"
                  className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200"
                  style={stackedInputStyle}
                />
              )}
            />

            <div
              className="settings-ai-light-card flex items-center justify-between gap-3 rounded-2xl border"
              style={{
                ...SETTINGS_FLAT_CARD_STYLE,
                padding: '16px 18px',
              }}
            >
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>在切换面板显示</div>
              <AISettingsSwitch
                checked={selectedProfile.showInChatSwitcher}
                onChange={(checked) => setProfileVisibility(selectedProfile.id, checked)}
              />
            </div>

            {selectedProfile.category === 'custom' && (
              <AISettingsFieldCard
                wide
                title="API 地址"
                description={currentProvider?.helpUrl ? (
                  <>
                    服务端点 URL，<a href={currentProvider.helpUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>查看文档</a>
                  </>
                ) : '自定义供应商地址'}
                control={(
                  <input
                    type="text"
                    value={selectedConfig.baseUrl}
                    onChange={(event) => updateField('baseUrl', event.target.value)}
                    placeholder={currentProvider?.baseUrl || 'https://...'}
                    className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200"
                    style={stackedInputStyle}
                  />
                )}
              />
            )}

            <AISettingsFieldCard
              wide={selectedProfile.category !== 'custom'}
              title="API Key"
              description={currentProvider?.apiKeyPlaceholder || 'sk-...'}
              control={(
                <div className="flex items-center gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={selectedConfig.apiKey}
                    onChange={(event) => updateField('apiKey', event.target.value)}
                    placeholder={currentProvider?.apiKeyPlaceholder || 'sk-...'}
                    className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 font-mono min-w-0 flex-1"
                    style={stackedInputStyle}
                  />
                  <button
                    onClick={() => setShowKey((value) => !value)}
                    className="text-[11px] px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {showKey ? '隐藏' : '显示'}
                  </button>
                </div>
              )}
            />

            <AISettingsFieldCard
              title="默认模型"
              description={knownModel?.description || '这个预设默认要使用的模型。'}
              control={isCustomModelInput ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={selectedConfig.model === '__custom__' ? '' : selectedConfig.model}
                    onChange={(event) => updateField('model', event.target.value)}
                    placeholder="模型 ID，如 gpt-5.4 / kimi-for-coding"
                    className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 font-mono min-w-0 flex-1"
                    style={stackedInputStyle}
                  />
                  {selectedProfile.category !== 'custom' && models.length > 0 && (
                    <button
                      onClick={() => updateField('model', models[0]?.id || '')}
                      className="text-[11px] px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors shrink-0"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      用推荐列表
                    </button>
                  )}
                </div>
              ) : (
                <select
                  value={selectedConfig.model}
                  onChange={(event) => {
                    if (event.target.value === '__custom__' || event.target.value === 'custom') {
                      updateField('model', '')
                    } else {
                      updateField('model', event.target.value)
                    }
                  }}
                  className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
                  style={stackedSelectStyle}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}{model.contextWindow ? ` (${Math.round(model.contextWindow / 1000)}K)` : ''}
                    </option>
                  ))}
                </select>
              )}
            />

            <AISettingsFieldCard
              wide
              title="模型列表"
              description="给当前预设维护多个模型 ID；“设为默认”会切换实际调用的主模型。"
              control={(
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2.5">
                    {managedModelIds.length > 0 ? managedModelIds.map((modelId) => {
                      const isDefaultModel = selectedConfig.model === modelId
                      return (
                        <div
                          key={modelId}
                          className="settings-ai-light-chip flex items-center gap-2.5 rounded-full border"
                          style={{
                            ...SETTINGS_FLAT_CHIP_STYLE,
                            padding: '5px 8px 5px 14px',
                          }}
                        >
                          <span className="text-[11px] font-mono" style={{ color: 'var(--text-body)' }}>{modelId}</span>
                          <span
                            aria-hidden
                            style={{ width: 1, alignSelf: 'stretch', margin: '3px 0', background: 'color-mix(in srgb, var(--surface-border) 58%, transparent)' }}
                          />
                          <div className="flex items-center gap-1">
                            {isDefaultModel ? (
                              <span className="rounded-full text-[10px] font-semibold" style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green-light) 58%, transparent)', padding: '2px 8px' }}>默认</span>
                            ) : (
                              <button
                                onClick={() => updateField('model', modelId)}
                                className="rounded-full text-[10px] font-semibold transition-colors hover:bg-[var(--bg-hover)]"
                                style={{ color: 'var(--color-blue)', padding: '2px 8px' }}
                              >
                                设为默认
                              </button>
                            )}
                            <button
                              onClick={() => removeModelId(modelId)}
                              className="rounded-full text-[10px] font-semibold transition-colors hover:bg-[var(--bg-hover)]"
                              style={{ color: 'var(--text-muted)', padding: '2px 8px' }}
                            >
                              删除
                            </button>
                          </div>
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
                      className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 font-mono min-w-0 flex-1"
                      style={stackedInputStyle}
                    />
                    <button
                      onClick={() => {
                        addModelId(pendingModelId)
                        setPendingModelId('')
                      }}
                      disabled={!pendingModelId.trim()}
                      className="rounded-full text-[12px] font-semibold disabled:opacity-50"
                      style={{
                        ...SETTINGS_FLAT_BUTTON_STYLE,
                        padding: '10px 14px',
                      }}
                    >
                      添加模型 ID
                    </button>
                  </div>
                </div>
              )}
            />

            {selectedProfile.category !== 'custom' && (
              <AISettingsFieldCard
                wide
                title="API 地址"
                description="内置供应商默认不会常改；如需代理或镜像地址，可在这里手动覆盖。"
                control={(
                  <input
                    type="text"
                    value={selectedConfig.baseUrl}
                    onChange={(event) => updateField('baseUrl', event.target.value)}
                    placeholder={currentProvider?.baseUrl || 'https://...'}
                    className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200"
                    style={stackedInputStyle}
                  />
                )}
              />
            )}

            {selectedConfig.provider === 'volcengine' && (
              <AISettingsFieldCard
                title="推理接入点 ID"
                description="火山方舟控制台生成的 ep-xxx。"
                control={(
                  <input
                    type="text"
                    value={selectedConfig.endpointId || ''}
                    onChange={(event) => updateField('endpointId', event.target.value)}
                    placeholder="ep-20250101xxxxx"
                    className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 font-mono"
                    style={stackedInputStyle}
                  />
                )}
              />
            )}
          </div>
          )}
          </div>

          {detailExpanded && (
          <>
          <div
            className="glass-surface-card rounded-2xl border"
            style={{
              ...SETTINGS_CARD_STYLE,
              padding: '18px 20px',
            }}
          >
            <button
              onClick={() => setShowAdvanced((value) => !value)}
              className="w-full flex items-center justify-between gap-3 text-left"
            >
              <div>
                <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>高级设置</div>
                <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)', maxWidth: 680 }}>
                  接口形式、工具调用、网页视觉、上下文窗口和思考强度默认收起，需要时再展开。
                </div>
              </div>
              <ChevronRight
                className="w-4 h-4"
                style={{
                  color: 'var(--text-muted)',
                  transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 160ms ease',
                }}
              />
            </button>

            {showAdvanced && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <AISettingsFieldCard
                  title="Agent 接口"
                  description={`当前解析为 ${resolvedAgentInterfaceLabel}。`}
                  control={(
                    <select
                      value={selectedConfig.agentProtocol || 'auto'}
                      onChange={(event) => updateField('agentProtocol', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.agentProtocol)}
                      className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
                      style={stackedSelectStyle}
                    >
                      <option value="auto">自动</option>
                      <option value="openai">OpenAI 兼容</option>
                      <option value="anthropic">Anthropic 兼容</option>
                    </select>
                  )}
                />

                {capabilities?.agentProtocol === 'openai' && (
                  <AISettingsFieldCard
                    title="OpenAI API 形式"
                    description="在 chat/completions 和 responses 之间切换。"
                    control={(
                      <select
                        value={selectedConfig.wireApi || 'auto'}
                        onChange={(event) => updateField('wireApi', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.wireApi)}
                        className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
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
                  description={`当前为 ${capabilities?.supportsToolCalls ? '开启' : '关闭'}。`}
                  control={(
                    <select
                      value={selectedConfig.toolUseMode || 'auto'}
                      onChange={(event) => updateField('toolUseMode', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.toolUseMode)}
                      className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
                      style={stackedSelectStyle}
                    >
                      <option value="auto">自动</option>
                      <option value="on">强制开启</option>
                      <option value="off">关闭</option>
                    </select>
                  )}
                />

                <AISettingsFieldCard
                  title="上下文窗口"
                  description="覆盖这个模型的上下文 token 上限；留空则使用模型默认值。"
                  control={(
                    <input
                      type="number"
                      min={1}
                      max={2_000_000}
                      step={1000}
                      value={selectedConfig.contextWindowOverride ?? ''}
                      onChange={(event) => updateContextWindowOverride(event.target.value)}
                      placeholder={contextWindowPlaceholder}
                      className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 font-mono"
                      style={stackedInputStyle}
                    />
                  )}
                />

                <AISettingsFieldCard
                  title="网页视觉"
                  description={`浏览器自动化视觉分析当前为 ${capabilities?.supportsVision ? '开启' : '关闭'}。`}
                  control={(
                    <select
                      value={selectedConfig.visionMode || 'auto'}
                      onChange={(event) => updateField('visionMode', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.visionMode)}
                      className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
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
                        className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
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
            )}
          </div>

          <div
            className="glass-surface-card rounded-2xl border"
            style={{
              ...SETTINGS_CARD_STYLE,
              padding: '18px 20px',
            }}
          >
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
              能力分组
            </div>
            <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)', maxWidth: 680 }}>
              控制哪些业务能力默认暴露给模型；当前状态会显示是已启用，还是因环境不可用而关闭。
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {capabilityGroups.map((group) => {
                const runtimeDisplay = resolveCapabilityRuntimeDisplay(group.id)
                return (
                  <div
                    key={group.id}
                    className="settings-ai-light-card rounded-xl border"
                    style={{
                      ...SETTINGS_FLAT_CARD_STYLE,
                      padding: '12px 14px',
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>{group.label}</div>
                        <div className="text-[11px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>{group.description}</div>
                      </div>
                      <select
                        value={getCapabilityModeValue(group.id)}
                        onChange={(event) => updateCapabilityMode(group.id, event.target.value as 'auto' | 'on' | 'off')}
                        className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
                        style={{
                          ...compactSelectStyle,
                          width: 112,
                          padding: '8px 28px',
                          textAlign: 'center',
                          textAlignLast: 'center',
                        }}
                      >
                        <option value="auto">自动</option>
                        <option value="on">开启</option>
                        <option value="off">关闭</option>
                      </select>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>当前状态</span>
                      <span
                        className="text-[11px] font-semibold"
                        style={{
                          color: runtimeDisplay.tone === 'positive' ? 'var(--color-green)' : 'var(--text-muted)',
                        }}
                      >
                        {runtimeDisplay.label}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {remoteModels.length > 0 && (
            <div
              className="glass-surface-card rounded-2xl border"
              style={{
                ...SETTINGS_CARD_STYLE,
                padding: '18px 20px',
              }}
            >
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
                远端返回的模型列表
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {remoteModels.map((modelId) => (
                  <div
                    key={modelId}
                    className="settings-ai-light-chip flex items-center gap-2 rounded-full border px-3 py-1"
                    style={{
                      ...SETTINGS_FLAT_CHIP_STYLE,
                    }}
                  >
                    <span className="text-[11px] font-mono" style={{ color: 'var(--text-body)' }}>
                      {modelId}
                    </span>
                    {!managedModelIdSet.has(modelId) && (
                      <button
                        onClick={() => addModelId(modelId)}
                        className="text-[10px] font-semibold transition-colors hover:opacity-80"
                        style={{ color: 'var(--color-blue)' }}
                      >
                        加入预设
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          </>
          )}
        </>
      )}

      <div
        className="glass-surface-card rounded-2xl border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '18px 20px',
        }}
      >
        <div className="flex-1 min-w-0" style={{ minHeight: 36 }}>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>对话发送</div>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(260px,0.8fr)]">
          <div
            className="flex items-center justify-between gap-3 rounded-2xl border"
            style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '14px 18px' }}
          >
            <span className="text-[12px]" style={{ color: 'var(--text-body)' }}>启用连续消息合并</span>
            <AISettingsSwitch
              checked={messageCoalesceEnabled}
              onChange={(next) => {
                setMessageCoalesceEnabled(next)
                persistBridgeSetting('agent_message_coalesce_enabled', String(next))
              }}
            />
          </div>
          <label
            className="flex items-center justify-between gap-3 rounded-2xl border"
            style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '14px 18px' }}
          >
            <span className="text-[12px] shrink-0" style={{ color: 'var(--text-body)' }}>合并窗口</span>
            <select
              value={messageCoalesceWindowMs}
              onChange={(event) => {
                setMessageCoalesceWindowMs(event.target.value)
                persistBridgeSetting('agent_message_coalesce_window_ms', event.target.value)
              }}
              className="min-w-0 text-[12px] outline-none cursor-pointer"
              style={{
                ...fieldSlotStyle,
                width: 152,
                marginTop: 0,
                padding: '8px 28px',
                textAlign: 'center',
                textAlignLast: 'center',
              }}
            >
              <option value="600">0.6 秒</option>
              <option value="1000">1.0 秒</option>
              <option value="1200">1.2 秒</option>
              <option value="1800">1.8 秒</option>
              <option value="2500">2.5 秒</option>
            </select>
          </label>
        </div>
      </div>

      {currentProvider && (
        <div
          className="text-[11px] leading-relaxed"
          style={{ padding: '2px 0 0', color: 'var(--text-light)' }}
        >
          {selectedConfig.provider === 'anthropic' && (
            <>注意：Anthropic API 使用 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>x-api-key</code> 认证头（非 Bearer），且 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>max_tokens</code> 为必填字段。系统已自动处理。</>
          )}
          {selectedConfig.provider === 'gemini' && (
            <>Gemini API 已使用 OpenAI 兼容层 (<code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/v1beta/openai/</code>)，API Key 在 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>Google AI Studio</a> 获取。</>
          )}
          {selectedConfig.provider === 'volcengine' && (
            <>火山方舟需要先在<a href="https://console.volcengine.com/ark" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>控制台</a>创建推理接入点，获取 ep-xxx 格式的 Endpoint ID。Seedance/Seedream 为异步任务模式。</>
          )}
          {selectedConfig.provider === 'moonshot' && (
            <>Moonshot API 完全兼容 OpenAI SDK，在<a href="https://platform.moonshot.cn/console" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>月之暗面控制台</a>获取 API Key。支持最多 128K 上下文和文件上传。</>
          )}
          {selectedConfig.provider === 'openai' && (
            <>在 <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>OpenAI Dashboard</a> 获取 API Key。推理模型 (o1/o3) 不支持 temperature 参数，系统已自动处理。</>
          )}
          {selectedConfig.provider === 'fox' && (
            <>FoxCode / NewCLI Codex 使用 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/responses</code> 接口，并通过 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>Authorization: Bearer ...</code> 认证。默认地址为 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>https://code.newcli.com/codex/v1</code>。</>
          )}
          {selectedConfig.provider === 'openai-compatible' && (
            <>输入任意 OpenAI 或 Anthropic 兼容 API 的地址和密钥。支持 LM Studio、Ollama、vLLM、FastChat 等本地或第三方服务；若要让浏览器 / 文档工具继续可用，请在上方同步设置 Agent 接口、API 形式与工具调用能力。</>
          )}
        </div>
      )}
    </div>
  )
}

function RSSDraftStoreSettingsPanel() {
  const [sources, setSources] = useState<RSSDraftStoreSourceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadSources = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.rss?.getDraftStoreSources) return
    setLoading(true)
    try {
      const result = await window.electronAPI.rss.getDraftStoreSources()
      if (!result.success || !result.data) {
        setMessage(result.error || '读取 RSS 底稿仓库失败')
        setSources([])
        return
      }
      setSources(result.data)
      setMessage(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  const handleClear = useCallback(async (sourceId?: string, sourceName?: string) => {
    if (!window.electronAPI?.rss?.clearDraftStore) return
    setBusyKey(sourceId || 'all')
    try {
      const result = await window.electronAPI.rss.clearDraftStore(sourceId ? { sourceId } : undefined)
      if (!result.success || !result.data) {
        setMessage(result.error || '重置 RSS 底稿仓库失败')
        return
      }
      setMessage(
        sourceId
          ? `${sourceName || '当前源'} 已重置，下次刷新会重新走首次完整抓取`
          : '全部 RSS 底稿已重置，下次刷新会重新走首次完整抓取',
      )
      await loadSources()
    } finally {
      setBusyKey(null)
    }
  }, [loadSources])

  return (
    <div className="flex flex-col gap-6">
      <div
        className="glass-surface-card rounded-[24px] border"
        style={{ ...SETTINGS_CARD_STYLE, padding: '20px 22px' }}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>底稿仓库说明</div>
            <div className="text-[12px] mt-1 leading-6" style={{ color: 'var(--text-light)', maxWidth: 760 }}>
              首次刷新会尽量补齐历史内容，之后只做轻量检查。清空 RSS 页面列表不会删掉这里的底稿；如果你在这里重置某个源或全部底稿，下次刷新会重新回到首次抓取方式。
            </div>
          </div>
          <button
            onClick={() => void handleClear()}
            disabled={busyKey !== null}
            className="flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
            style={SETTINGS_DANGER_BUTTON_STYLE}
          >
            {busyKey === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            清空全部底稿
          </button>
        </div>
        {message && (
          <div className="text-[12px] mt-4" style={{ color: 'var(--text-muted)' }}>
            {message}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {loading ? (
          <div className="glass-surface-card rounded-[24px] border flex items-center gap-3" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-blue)' }} />
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取 RSS 底稿列表…</span>
          </div>
        ) : sources.length === 0 ? (
          <div className="glass-surface-card rounded-[24px] border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>还没有底稿内容</div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--text-light)' }}>等你添加源并刷新后，这里会显示每个源的存量和当前刷新状态。</div>
          </div>
        ) : (
          sources.map((source) => (
            <div
              key={source.sourceId}
              className="glass-surface-card rounded-[24px] border"
              style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}
            >
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-title)' }}>{source.sourceName}</div>
                  <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--text-light)' }}>{source.sourceUrl}</div>
                </div>
                <button
                  onClick={() => void handleClear(source.sourceId, source.sourceName)}
                  disabled={busyKey !== null}
                  className="flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
                  style={SETTINGS_DANGER_BUTTON_STYLE}
                >
                  {busyKey === source.sourceId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  重置此源
                </button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                {[
                  { label: '底稿总数', value: String(source.storedCount) },
                  { label: '界面收件箱', value: String(source.inboxCount) },
                  { label: '已收藏', value: String(source.starredCount) },
                  { label: '刷新方式', value: source.refreshMode === 'incremental' ? '后续轻量' : '首次完整' },
                ].map((entry) => (
                  <div
                    key={entry.label}
                    className="rounded-[18px]"
                    style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '12px 14px' }}
                  >
                    <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-light)' }}>{entry.label}</div>
                    <div className="text-[13px] font-semibold mt-2" style={{ color: 'var(--text-title)' }}>{entry.value}</div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// Storage / cache panel — wired to app:getCacheStats + app:clearCache.
// Replaces the legacy hardcoded "256 MB" display. Shows live breakdown of
// userData cache subdirectories and lets the user clear them.
type CacheQuotaOption = '256MB' | '1GB' | '5GB' | 'unlimited'

const CACHE_QUOTA_OPTIONS: { value: CacheQuotaOption; label: string }[] = [
  { value: '256MB', label: '256 MB' },
  { value: '1GB', label: '1 GB' },
  { value: '5GB', label: '5 GB' },
  { value: 'unlimited', label: '无限制' },
]

const DEFAULT_CACHE_QUOTA: CacheQuotaOption = '1GB'

function isValidQuota(value: string | null | undefined): value is CacheQuotaOption {
  return value === '256MB' || value === '1GB' || value === '5GB' || value === 'unlimited'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

interface CacheStatsView {
  codeCacheBytes: number
  cacheBytes: number
  puppeteerCacheBytes: number
  sharedCacheBytes: number
}

const ZERO_STATS: CacheStatsView = {
  codeCacheBytes: 0,
  cacheBytes: 0,
  puppeteerCacheBytes: 0,
  sharedCacheBytes: 0,
}

// Exported for the Y0.8 relabel behavior test (per sub-plan
// docs/superpowers/plans/archive/2026-05-23-Y0-8-cache-quota-relabel-implementation.md §6).
// Mounting the full Settings page would require a ~200 line electronAPI proxy
// harness; exporting this single panel keeps the test surgical.
export function StorageSettingsPanel() {
  const [stats, setStats] = useState<CacheStatsView | null>(null)
  const [statsLoading, setStatsLoading] = useState<boolean>(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [clearing, setClearing] = useState<'none' | 'standard' | 'puppeteer'>('none')
  const [confirmKind, setConfirmKind] = useState<'standard' | 'puppeteer' | null>(null)
  const [lastResult, setLastResult] = useState<{ kind: 'standard' | 'puppeteer'; clearedBytes: number; errors: string[] } | null>(null)
  const [quota, setQuota] = useState<CacheQuotaOption>(DEFAULT_CACHE_QUOTA)

  const refreshStats = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.app?.getCacheStats) {
      setStatsLoading(false)
      setStatsError('IPC 不可用')
      return
    }
    setStatsLoading(true)
    setStatsError(null)
    try {
      const result = await window.electronAPI.app.getCacheStats()
      if (result.success && result.data) {
        setStats(result.data)
      } else {
        setStats(ZERO_STATS)
        setStatsError(result.error || '读取缓存大小失败')
      }
    } catch (err) {
      setStats(ZERO_STATS)
      setStatsError(err instanceof Error ? err.message : String(err))
    } finally {
      setStatsLoading(false)
    }
  }, [])

  // Load on mount + load persisted quota choice.
  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    let cancelled = false
    void (async () => {
      const result = await window.electronAPI.settings.get('cache_quota_bytes')
      if (cancelled) return
      if (result?.success && isValidQuota(result.data)) {
        setQuota(result.data)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleQuotaChange = useCallback(async (next: CacheQuotaOption) => {
    setQuota(next)
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    // TODO(D1-quota): wire actual eviction. For now we just persist the choice
    // — Chromium cache cannot be hard-bounded via Electron API directly.
    void window.electronAPI.settings.set('cache_quota_bytes', next)
  }, [])

  const performClear = useCallback(async (includePuppeteer: boolean) => {
    if (typeof window === 'undefined' || !window.electronAPI?.app?.clearCache) return
    setClearing(includePuppeteer ? 'puppeteer' : 'standard')
    setConfirmKind(null)
    try {
      const result = await window.electronAPI.app.clearCache({ includePuppeteer })
      if (result.success && result.data) {
        setLastResult({
          kind: includePuppeteer ? 'puppeteer' : 'standard',
          clearedBytes: result.data.clearedBytes,
          errors: result.data.errors,
        })
      } else {
        setLastResult({
          kind: includePuppeteer ? 'puppeteer' : 'standard',
          clearedBytes: 0,
          errors: [result.error || '清除失败'],
        })
      }
      await refreshStats()
    } catch (err) {
      setLastResult({
        kind: includePuppeteer ? 'puppeteer' : 'standard',
        clearedBytes: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      })
    } finally {
      setClearing('none')
    }
  }, [refreshStats])

  const totalBytes = stats
    ? stats.codeCacheBytes + stats.cacheBytes + stats.puppeteerCacheBytes + stats.sharedCacheBytes
    : 0

  const breakdownRows: { id: string; label: string; description: string; bytes: number }[] = stats
    ? [
        { id: 'codeCache', label: 'Code Cache', description: 'Chromium V8 编译缓存', bytes: stats.codeCacheBytes },
        { id: 'cache', label: 'HTTP Cache', description: 'Electron 网络缓存', bytes: stats.cacheBytes },
        { id: 'sharedCache', label: 'Shared Dictionary', description: 'Brotli 压缩字典', bytes: stats.sharedCacheBytes },
        { id: 'puppeteerCache', label: 'Puppeteer Cache', description: 'Puppeteer 下载的 Chrome 二进制', bytes: stats.puppeteerCacheBytes },
      ]
    : []

  return (
    <div className="flex flex-col gap-7">
      {/* Cache breakdown summary */}
      <div
        className="glass-surface-card rounded-2xl border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '18px 20px',
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
              缓存占用
            </div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-light)' }}>
              当前 userData 下的缓存合计大小
            </div>
          </div>
          <div className="text-[18px] font-mono font-semibold" style={{ color: 'var(--text-title)' }}>
            {statsLoading ? '…' : formatBytes(totalBytes)}
          </div>
        </div>
        {statsError && (
          <div className="text-[11px] mt-2" style={{ color: 'var(--color-red, #d44)' }}>
            {statsError}
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2">
          {breakdownRows.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12px] font-medium" style={{ color: 'var(--text-body)' }}>
                  {row.label}
                </div>
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-light)' }}>
                  {row.description}
                </div>
              </div>
              <div className="text-[12px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {statsLoading ? '…' : formatBytes(row.bytes)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quota selector — relabel-only per Stage Y0.8 plan §11.0a path-(b).
          The configured value still persists via cache_quota_bytes so it
          carries forward into Stage Z's real eviction landing; this UI is
          honest that no enforcement happens today. EN equivalent for future
          locale work: "Cache size limit (configured but NOT enforced —
          manual cleanup required)". */}
      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
            缓存大小上限
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            仅记录配置，未强制执行 — 需要手动清理（使用下方的「清除缓存」按钮）
          </div>
        </div>
        <select
          value={quota}
          onChange={(e) => { void handleQuotaChange(e.target.value as CacheQuotaOption) }}
          className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
          style={{
            ...SETTINGS_INPUT_STYLE,
            padding: '9px 32px 9px 14px',
            width: 180,
          }}
        >
          {CACHE_QUOTA_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Standard clear */}
      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
            清除缓存
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            清除 Code Cache / HTTP Cache / Shared Dictionary 与会话级 Chromium 缓存
          </div>
        </div>
        <button
          onClick={() => setConfirmKind('standard')}
          disabled={clearing !== 'none' || statsLoading}
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
          style={{
            ...SETTINGS_DANGER_BUTTON_STYLE,
            width: SETTING_SLOT_WIDTHS.short,
            justifyContent: 'center',
            opacity: clearing !== 'none' || statsLoading ? 0.6 : 1,
            cursor: clearing !== 'none' || statsLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {clearing === 'standard'
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Trash2 className="w-3 h-3" />}
          {clearing === 'standard' ? '清除中…' : '清除'}
        </button>
      </div>

      {/* Puppeteer clear (gated separately) */}
      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
            包括浏览器缓存
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            额外清除 puppeteer-cache（会重新下载 Chrome，约数百 MB）
          </div>
        </div>
        <button
          onClick={() => setConfirmKind('puppeteer')}
          disabled={clearing !== 'none' || statsLoading}
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
          style={{
            ...SETTINGS_SECONDARY_BUTTON_STYLE,
            width: SETTING_SLOT_WIDTHS.short,
            justifyContent: 'center',
            opacity: clearing !== 'none' || statsLoading ? 0.6 : 1,
            cursor: clearing !== 'none' || statsLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {clearing === 'puppeteer'
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Trash2 className="w-3 h-3" />}
          {clearing === 'puppeteer' ? '清除中…' : '清除全部'}
        </button>
      </div>

      {/* Result toast */}
      {lastResult && (
        <div
          className="glass-surface-card rounded-2xl border"
          style={{
            ...SETTINGS_SUBTLE_CARD_STYLE,
            padding: '12px 14px',
          }}
        >
          <div className="flex items-center gap-2">
            {lastResult.errors.length === 0
              ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--color-green)' }} />
              : <XCircle className="w-3.5 h-3.5" style={{ color: 'var(--color-red, #d44)' }} />}
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-body)' }}>
              {lastResult.errors.length === 0
                ? `已清除 ${formatBytes(lastResult.clearedBytes)}`
                : `部分失败：清除 ${formatBytes(lastResult.clearedBytes)}，${lastResult.errors.length} 个错误`}
            </span>
          </div>
          {lastResult.errors.length > 0 && (
            <ul className="mt-2 ml-5 list-disc text-[11px]" style={{ color: 'var(--text-light)' }}>
              {lastResult.errors.slice(0, 5).map((err, idx) => (
                <li key={idx}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Confirmation modal */}
      {confirmKind && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.32)' }}
          onClick={() => setConfirmKind(null)}
        >
          <div
            className="glass-surface-card rounded-2xl border"
            style={{
              ...SETTINGS_CARD_STYLE,
              padding: '20px 22px',
              width: 360,
              maxWidth: 'calc(100vw - 48px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
              确认清除缓存
            </div>
            <div className="text-[12px] mt-2 leading-5" style={{ color: 'var(--text-light)' }}>
              {confirmKind === 'puppeteer'
                ? '此操作会删除所有缓存，包括 puppeteer-cache。下次启动浏览器自动化时会重新下载 Chrome（数百 MB），耗时较长。是否继续？'
                : '此操作会删除 Code Cache、HTTP Cache 与 Shared Dictionary。下次启动应用时会重新生成。是否继续？'}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmKind(null)}
                className="rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                style={{
                  ...SETTINGS_SECONDARY_BUTTON_STYLE,
                  padding: '8px 14px',
                }}
              >
                取消
              </button>
              <button
                onClick={() => { void performClear(confirmKind === 'puppeteer') }}
                className="rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                style={{
                  ...SETTINGS_DANGER_BUTTON_STYLE,
                  padding: '8px 14px',
                }}
              >
                确认清除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const EXTERNAL_SERVICE_SECRET_LABELS: Record<string, string> = {
  apiKey: 'API Key',
  token: 'Token',
  sessdata: 'SESSDATA',
  biliJct: 'bili_jct',
}

const EXTERNAL_SERVICE_DESCRIPTIONS: Partial<Record<PublicExternalServiceProfile['kind'], string>> = {
  tavily: '供网页研究使用',
  duckduckgo: '供备用搜索使用',
  jina: '供网页正文读取使用',
  rsshub: '供 RSS 订阅抓取使用',
  bilibili: '供视频分析技能使用',
  github: '供代码仓库操作使用',
  amap: '供路线规划 Agent 使用',
  'vision-model': '供视觉分析独立使用',
}

type ExternalServiceFeedback = {
  kind: 'info' | 'success' | 'error'
  serviceId?: string
  text: string
}

function serviceSecretKeys(profile: PublicExternalServiceProfile): string[] {
  const keys = Object.keys(profile.secretStatus || {})
  if (keys.length > 0) return keys
  if (profile.kind === 'tavily' || profile.kind === 'jina' || profile.kind === 'vision-model') return ['apiKey']
  if (profile.kind === 'github') return ['token']
  if (profile.kind === 'bilibili') return ['sessdata', 'biliJct']
  return []
}

function serviceNeedsBaseUrl(profile: PublicExternalServiceProfile): boolean {
  return profile.kind !== 'bilibili'
}

function normalizeServiceOptionValue(value: unknown): ExternalServiceOptionValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return ''
}

function externalServiceDescription(profile: PublicExternalServiceProfile): string {
  return EXTERNAL_SERVICE_DESCRIPTIONS[profile.kind] || profile.kind
}

function buildExternalServicePayload(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  clearSecrets?: string[],
): ExternalServiceUpdateInput {
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(secretDraft || {})) {
    if (value.trim()) secrets[key] = value.trim()
  }
  const payload: ExternalServiceUpdateInput = {
    id: profile.id,
    kind: profile.kind,
    name: profile.name,
    enabled: profile.enabled,
    baseUrl: profile.baseUrl,
    options: profile.options,
    secrets,
  }
  if (clearSecrets?.length) payload.clearSecrets = clearSecrets
  return payload
}

function externalServiceStatusStyle(enabled: boolean): CSSProperties {
  return {
    borderColor: enabled ? 'color-mix(in srgb, var(--color-green) 44%, transparent)' : 'color-mix(in srgb, var(--surface-border) 76%, transparent)',
    color: enabled ? 'var(--color-green)' : 'var(--text-muted)',
    background: 'transparent',
  }
}

function externalServiceStatusButtonStyle(enabled: boolean): CSSProperties {
  return {
    ...externalServiceStatusStyle(enabled),
    minWidth: 58,
    height: 24,
    padding: '0 8px',
  }
}

function externalServiceButtonStyle(variant: 'plain' | 'secondary' | 'primary', disabled: boolean): CSSProperties {
  if (variant === 'primary') {
    return {
      minWidth: 76,
      height: 38,
      padding: '0 15px',
      borderRadius: 10,
      border: '1px solid color-mix(in srgb, var(--color-blue) 72%, transparent)',
      background: 'color-mix(in srgb, var(--color-blue) 82%, var(--surface-card-bg) 18%)',
      color: '#fff',
      opacity: disabled ? 0.62 : 1,
      boxShadow: 'none',
    }
  }
  return {
    minWidth: variant === 'plain' ? 58 : 76,
    height: 38,
    padding: '0 13px',
    borderRadius: 10,
    border: variant === 'plain' ? '1px solid transparent' : '1px solid color-mix(in srgb, var(--surface-border) 70%, transparent)',
    background: 'transparent',
    color: variant === 'plain' ? 'var(--text-muted)' : 'var(--text-body)',
    opacity: disabled ? 0.62 : 1,
    boxShadow: 'none',
  }
}

function externalServiceFeedbackStyle(kind: ExternalServiceFeedback['kind']): CSSProperties {
  return {
    color: kind === 'error' ? 'var(--color-red)' : kind === 'success' ? 'var(--color-green)' : 'var(--text-muted)',
    background: 'transparent',
  }
}

function externalServiceInputStyle(): CSSProperties {
  return {
    ...SETTINGS_FLAT_INPUT_STYLE,
    minHeight: 42,
    borderRadius: 10,
    padding: '9px 11px',
    boxShadow: 'none',
  }
}

function externalServiceDraftSummary(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  clearSecrets: string[] = [],
): string {
  if (clearSecrets.length > 0) return `将清除 ${clearSecrets.length} 项密钥 · 保存后生效`
  const hasDraftSecret = Object.values(secretDraft || {}).some((value) => value.trim())
  if (hasDraftSecret) return '有未保存密钥 · 测试会使用当前输入 · 保存后生效'
  const secretKeys = serviceSecretKeys(profile)
  if (secretKeys.length === 0) return profile.enabled ? '服务已启用' : '服务未启用'
  const configured = secretKeys.filter((key) => profile.secretStatus[key]?.configured).length
  if (configured === secretKeys.length) return `已保存 ${configured} 项密钥`
  if (configured > 0) return `已保存 ${configured}/${secretKeys.length} 项密钥`
  return '密钥未配置'
}

function hasExternalServiceSecret(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  key: string,
  clearSecrets: string[] = [],
): boolean {
  if (clearSecrets.includes(key)) return Boolean(String(secretDraft?.[key] || '').trim())
  return Boolean(String(secretDraft?.[key] || '').trim()) || profile.secretStatus[key]?.configured === true
}

function requiredExternalServiceSecretKeys(profile: PublicExternalServiceProfile): string[] {
  if (profile.kind === 'tavily' || profile.kind === 'amap' || profile.kind === 'vision-model') return ['apiKey']
  if (profile.kind === 'github') return ['token']
  if (profile.kind === 'bilibili') return ['sessdata']
  return []
}

function externalServiceMissingRequirements(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  clearSecrets: string[] = [],
): string[] {
  const missing: string[] = []
  const baseUrl = String(profile.baseUrl || '').trim()
  if (serviceNeedsBaseUrl(profile) && !baseUrl) missing.push('服务地址')
  for (const key of requiredExternalServiceSecretKeys(profile)) {
    if (!hasExternalServiceSecret(profile, secretDraft, key, clearSecrets)) {
      missing.push(EXTERNAL_SERVICE_SECRET_LABELS[key] || key)
    }
  }
  if (profile.kind === 'vision-model') {
    if (!String(profile.options.model || '').trim()) missing.push('Model')
  }
  return missing
}

// Y1.1 §11.1: exported so the relabel behavior test can mount this panel in
// jsdom without instantiating the full Settings shell (mirrors Y0.8
// StorageSettingsPanel export precedent).
export function ExternalServicesSettingsPanel() {
  const [profiles, setProfiles] = useState<PublicExternalServiceProfile[]>([])
  const [secretDrafts, setSecretDrafts] = useState<Record<string, Record<string, string>>>({})
  const [secretClearRequests, setSecretClearRequests] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<ExternalServiceFeedback | null>(null)

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings?.listExternalServices) {
      setLoading(false)
      setFeedback({ kind: 'error', text: '外部服务 IPC 不可用' })
      return
    }
    setLoading(true)
    try {
      const res = await window.electronAPI.settings.listExternalServices()
      if (res.success && res.data) {
        setProfiles(res.data as PublicExternalServiceProfile[])
        setFeedback(null)
      } else {
        setFeedback({ kind: 'error', text: res.error || '读取外部服务配置失败' })
      }
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (profiles.length === 0) return
    setSelectedId((current) => {
      if (current && profiles.some((profile) => profile.id === current)) return current
      return profiles.find((profile) => profile.kind === 'amap')?.id || profiles[0]?.id || null
    })
  }, [profiles])

  const patchProfile = useCallback((id: string, patch: Partial<PublicExternalServiceProfile>) => {
    setProfiles((prev) => prev.map((profile) => profile.id === id ? { ...profile, ...patch } : profile))
    setFeedback({ kind: 'info', serviceId: id, text: '有未保存更改。测试会使用当前表单值，保存后才会生效。' })
  }, [])

  const patchOptions = useCallback((id: string, patch: Record<string, ExternalServiceOptionValue>) => {
    setProfiles((prev) => prev.map((profile) => (
      profile.id === id
        ? { ...profile, options: { ...(profile.options || {}), ...patch } }
        : profile
    )))
    setFeedback({ kind: 'info', serviceId: id, text: '有未保存更改。测试会使用当前表单值，保存后才会生效。' })
  }, [])

  const updateSecretDraft = useCallback((id: string, key: string, value: string) => {
    setSecretDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        [key]: value,
      },
    }))
    if (value.trim()) {
      setSecretClearRequests((prev) => ({
        ...prev,
        [id]: (prev[id] || []).filter((item) => item !== key),
      }))
    }
    setFeedback({ kind: 'info', serviceId: id, text: '有未保存更改。测试会使用当前表单值，保存后才会生效。' })
  }, [])

  const markSecretForClear = useCallback((id: string, key: string) => {
    setSecretDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        [key]: '',
      },
    }))
    setSecretClearRequests((prev) => ({
      ...prev,
      [id]: Array.from(new Set([...(prev[id] || []), key])),
    }))
    setFeedback({ kind: 'info', serviceId: id, text: '密钥已标记清除。测试会按清除后的表单值执行，保存后才会生效。' })
  }, [])

  const unmarkSecretForClear = useCallback((id: string, key: string) => {
    setSecretClearRequests((prev) => ({
      ...prev,
      [id]: (prev[id] || []).filter((item) => item !== key),
    }))
    setFeedback({ kind: 'info', serviceId: id, text: '密钥将继续保留。' })
  }, [])

  const toggleProfileEnabled = useCallback((profile: PublicExternalServiceProfile) => {
    setSelectedId(profile.id)
    if (!profile.enabled) {
      const missing = externalServiceMissingRequirements(profile, secretDrafts[profile.id], secretClearRequests[profile.id] || [])
      if (missing.length > 0) {
        const text = `请先完成配置：${missing.join('、')}。`
        setFeedback({
          kind: 'error',
          serviceId: profile.id,
          text,
        })
        window.alert(text)
        return
      }
    }
    patchProfile(profile.id, { enabled: !profile.enabled })
  }, [patchProfile, secretClearRequests, secretDrafts])

  const saveProfile = useCallback(async (profile: PublicExternalServiceProfile) => {
    if (!window.electronAPI?.settings?.updateExternalService) return
    setBusyId(profile.id)
    setFeedback({ kind: 'info', serviceId: profile.id, text: '正在保存配置...' })
    try {
      const res = await window.electronAPI.settings.updateExternalService(buildExternalServicePayload(profile, secretDrafts[profile.id], secretClearRequests[profile.id] || []))
      if (res.success && res.data) {
        setProfiles((prev) => prev.map((item) => item.id === profile.id ? res.data as PublicExternalServiceProfile : item))
        setSecretDrafts((prev) => ({ ...prev, [profile.id]: {} }))
        setSecretClearRequests((prev) => ({ ...prev, [profile.id]: [] }))
        setFeedback({ kind: 'success', serviceId: profile.id, text: `已保存：${profile.name}` })
      } else {
        setFeedback({ kind: 'error', serviceId: profile.id, text: res.error || `保存失败：${profile.name}` })
      }
    } catch (error) {
      setFeedback({ kind: 'error', serviceId: profile.id, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }, [secretClearRequests, secretDrafts])

  const resetProfile = useCallback(async (profile: PublicExternalServiceProfile) => {
    if (!window.electronAPI?.settings?.resetExternalService) return
    setBusyId(profile.id)
    setFeedback({ kind: 'info', serviceId: profile.id, text: '正在重置配置...' })
    try {
      const res = await window.electronAPI.settings.resetExternalService({ id: profile.id })
      if (res.success && res.data) {
        setProfiles((prev) => prev.map((item) => item.id === profile.id ? res.data as PublicExternalServiceProfile : item))
        setSecretDrafts((prev) => ({ ...prev, [profile.id]: {} }))
        setSecretClearRequests((prev) => ({ ...prev, [profile.id]: [] }))
        setFeedback({ kind: 'success', serviceId: profile.id, text: `已重置：${profile.name}` })
      } else {
        setFeedback({ kind: 'error', serviceId: profile.id, text: res.error || `重置失败：${profile.name}` })
      }
    } catch (error) {
      setFeedback({ kind: 'error', serviceId: profile.id, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }, [])

  const testProfile = useCallback(async (profile: PublicExternalServiceProfile) => {
    if (!window.electronAPI?.settings?.testExternalServiceDraft) return
    setTestingId(profile.id)
    setFeedback({ kind: 'info', serviceId: profile.id, text: '正在测试当前表单配置...' })
    try {
      const res = await window.electronAPI.settings.testExternalServiceDraft(buildExternalServicePayload(profile, secretDrafts[profile.id], secretClearRequests[profile.id] || []))
      const detail = res.data?.latencyMs ? `（${res.data.latencyMs}ms）` : ''
      setFeedback({
        kind: res.success ? 'success' : 'error',
        serviceId: profile.id,
        text: res.success ? `${profile.name}：${res.data?.message || '连接正常'}${detail}` : `${profile.name}：${res.error || '测试失败'}`,
      })
    } catch (error) {
      setFeedback({ kind: 'error', serviceId: profile.id, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setTestingId(null)
    }
  }, [secretClearRequests, secretDrafts])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        加载外部服务配置...
      </div>
    )
  }

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) || profiles[0] || null
  const selectedSecretKeys = selectedProfile ? serviceSecretKeys(selectedProfile) : []
  const selectedFeedback = feedback && (!feedback.serviceId || feedback.serviceId === selectedProfile?.id) ? feedback : null
  const selectedDraft = selectedProfile ? secretDrafts[selectedProfile.id] : undefined
  const selectedClearSecrets = selectedProfile ? secretClearRequests[selectedProfile.id] || [] : []
  const isSelectedBusy = Boolean(selectedProfile && busyId === selectedProfile.id)
  const isSelectedTesting = Boolean(selectedProfile && testingId === selectedProfile.id)
  const selectedSummary = selectedProfile ? externalServiceDraftSummary(selectedProfile, selectedDraft, selectedClearSecrets) : ''
  // Y1.1 §11.1 honest-label path: vision-model "test" only field-validates in
  // main-process (`external-service-store.ts:342-344,390` — no HTTP probe).
  // Renderer relabels the button so the user sees what the system actually does.
  // Other kinds (amap / jina / rsshub / duckduckgo) DO probe and stay labeled `测试`.
  const isSelectedVisionModel = selectedProfile?.kind === 'vision-model'
  const visionMissingRequirements = isSelectedVisionModel && selectedProfile
    ? externalServiceMissingRequirements(selectedProfile, selectedDraft, selectedClearSecrets)
    : []
  const isVisionTestDisabled = isSelectedVisionModel && visionMissingRequirements.length > 0

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-5 xl:grid-cols-[260px_minmax(0,760px)]">
        <nav className="flex flex-col gap-1" aria-label="外部服务列表">
          {profiles.map((profile) => {
            const active = profile.id === selectedProfile?.id
            const hovered = profile.id === hoveredId
            return (
              <div
                key={profile.id}
                onMouseEnter={() => setHoveredId(profile.id)}
                onMouseLeave={() => setHoveredId((current) => current === profile.id ? null : current)}
                className="w-full transition-[background-color,color] duration-150"
                style={{
                  padding: '10px 11px',
                  borderRadius: 12,
                  border: '1px solid transparent',
                  background: active
                    ? 'color-mix(in srgb, var(--color-blue) 8%, transparent)'
                    : hovered
                      ? 'color-mix(in srgb, var(--surface-card-bg) 48%, transparent)'
                      : 'transparent',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setSelectedId(profile.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
                      {profile.name}
                    </div>
                    <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
                      {externalServiceDescription(profile)}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleProfileEnabled(profile)}
                    className="inline-flex shrink-0 items-center justify-center rounded-[9px] border text-[11px] font-medium leading-none transition-[border-color,color,background-color] duration-150"
                    style={externalServiceStatusButtonStyle(profile.enabled)}
                  >
                    {profile.enabled ? '已启用' : '未启用'}
                  </button>
                </div>
              </div>
            )
          })}
        </nav>

        {selectedProfile && (
          <section
            className="self-start rounded-[18px] border"
            style={{
              borderColor: 'color-mix(in srgb, var(--surface-border) 58%, transparent)',
              background: 'color-mix(in srgb, var(--surface-card-bg) 88%, var(--bg-content) 12%)',
              boxShadow: 'none',
              padding: '18px 20px 16px',
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--text-title)' }}>
                  {selectedProfile.name}
                </div>
                <div className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                  {externalServiceDescription(selectedProfile)}
                </div>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2 text-[11px] leading-5" style={{ color: 'var(--text-light)' }}>
              <span>{selectedSummary}</span>
              {selectedProfile.updatedAt ? <span>· 更新于 {new Date(selectedProfile.updatedAt).toLocaleString()}</span> : null}
            </div>

            <div className="mt-4 flex max-w-[640px] flex-col gap-3.5">
              {serviceNeedsBaseUrl(selectedProfile) && (
                <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  服务地址
                  <input
                    value={selectedProfile.baseUrl || ''}
                    onChange={(event) => patchProfile(selectedProfile.id, { baseUrl: event.target.value })}
                    style={externalServiceInputStyle()}
                    placeholder={selectedProfile.kind === 'vision-model' ? 'https://api.example.com/v1' : 'https://...'}
                  />
                </label>
              )}

              {selectedProfile.kind === 'vision-model' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    Provider
                    <input
                      value={String(selectedProfile.options.provider || '')}
                      onChange={(event) => patchOptions(selectedProfile.id, { provider: event.target.value })}
                      style={externalServiceInputStyle()}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    Model
                    <input
                      value={String(selectedProfile.options.model || '')}
                      onChange={(event) => patchOptions(selectedProfile.id, { model: event.target.value })}
                      style={externalServiceInputStyle()}
                      placeholder="gpt-4o / qwen-vl..."
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    API 格式
                    <select
                      value={String(selectedProfile.options.apiKind || 'openai-completions')}
                      onChange={(event) => patchOptions(selectedProfile.id, { apiKind: event.target.value })}
                      style={externalServiceInputStyle()}
                    >
                      <option value="openai-completions">OpenAI Chat</option>
                      <option value="openai-responses">OpenAI Responses</option>
                      <option value="anthropic-messages">Anthropic Messages</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 self-end pb-2 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    <input
                      type="checkbox"
                      checked={Array.isArray(selectedProfile.options.inputModes) && selectedProfile.options.inputModes.includes('image')}
                      onChange={(event) => patchOptions(selectedProfile.id, { inputModes: event.target.checked ? ['text', 'image'] : ['text'] })}
                    />
                    支持图片输入
                  </label>
                </div>
              )}

              {selectedProfile.kind === 'bilibili' && (
                <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  Cookie 文件路径（可选）
                  <input
                    value={String(normalizeServiceOptionValue(selectedProfile.options.cookieFile))}
                    onChange={(event) => patchOptions(selectedProfile.id, { cookieFile: event.target.value })}
                    style={externalServiceInputStyle()}
                    placeholder="/path/to/cookies.txt"
                  />
                </label>
              )}

              {selectedSecretKeys.map((key) => {
                const status = selectedProfile.secretStatus[key]
                const markedForClear = selectedClearSecrets.includes(key)
                return (
                  <label key={key} className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    {EXTERNAL_SERVICE_SECRET_LABELS[key] || key}
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={secretDrafts[selectedProfile.id]?.[key] || ''}
                        onChange={(event) => updateSecretDraft(selectedProfile.id, key, event.target.value)}
                        style={{ ...externalServiceInputStyle(), flex: 1 }}
                        placeholder={markedForClear ? '保存后清除；输入新值可替换' : status?.configured ? `已配置 ${status.masked || ''}，留空则保留` : '未配置'}
                      />
                      {status?.configured ? (
                        <button
                          type="button"
                          data-external-secret-clear={`${selectedProfile.id}:${key}`}
                          onClick={() => markedForClear ? unmarkSecretForClear(selectedProfile.id, key) : markSecretForClear(selectedProfile.id, key)}
                          className="inline-flex items-center justify-center text-[12px] font-medium transition-[border-color,color,background-color,opacity] duration-150"
                          style={externalServiceButtonStyle('plain', isSelectedBusy || isSelectedTesting)}
                          disabled={isSelectedBusy || isSelectedTesting}
                        >
                          {markedForClear ? '保留' : '清除'}
                        </button>
                      ) : null}
                    </div>
                  </label>
                )
              })}

              <div className="min-h-5 text-[11px] leading-5" style={selectedFeedback ? externalServiceFeedbackStyle(selectedFeedback.kind) : { color: 'var(--text-light)' }}>
                {selectedFeedback ? (
                  <span className="inline-flex items-center gap-1.5">
                    {selectedFeedback.kind === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" /> : selectedFeedback.kind === 'error' ? <XCircle className="h-3.5 w-3.5" /> : null}
                    {selectedFeedback.text}
                  </span>
                ) : (
                  '测试不会保存配置；保存后 Agent 才会使用。'
                )}
              </div>

              {isSelectedVisionModel && (
                <div
                  data-vea-test-help
                  className="text-[11px] leading-5"
                  style={{ color: 'var(--text-light)' }}
                >
                  仅校验字段，不发起真实请求 / Validates fields only; no live request issued.
                  {visionMissingRequirements.length > 0 ? `（缺少：${visionMissingRequirements.join('、')}）` : ''}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-0.5">
                <button
                  type="button"
                  onClick={() => { void resetProfile(selectedProfile) }}
                  disabled={isSelectedBusy || isSelectedTesting}
                  className="inline-flex items-center justify-center gap-1.5 text-[12px] font-medium transition-[border-color,color,background-color,opacity] duration-150"
                  style={externalServiceButtonStyle('plain', isSelectedBusy || isSelectedTesting)}
                >
                  {isSelectedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {isSelectedBusy ? '重置中' : '重置'}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-vea-test-button={isSelectedVisionModel ? 'fields-only' : 'probe'}
                    onClick={() => { void testProfile(selectedProfile) }}
                    disabled={isSelectedTesting || isSelectedBusy || isVisionTestDisabled}
                    title={isSelectedVisionModel
                      ? '仅校验字段，不发起真实请求 / Validates fields only; no live request issued.'
                      : undefined}
                    className="inline-flex items-center justify-center gap-1.5 text-[12px] font-medium transition-[border-color,color,background-color,opacity] duration-150"
                    style={externalServiceButtonStyle('secondary', isSelectedTesting || isSelectedBusy || isVisionTestDisabled)}
                  >
                    {isSelectedTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {isSelectedVisionModel
                      ? (isSelectedTesting ? '校验中' : '仅校验字段')
                      : (isSelectedTesting ? '测试中' : '测试')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void saveProfile(selectedProfile) }}
                    disabled={isSelectedBusy || isSelectedTesting}
                    className="inline-flex items-center justify-center gap-1.5 text-[12px] font-medium transition-[border-color,color,background-color,opacity] duration-150"
                    style={externalServiceButtonStyle('primary', isSelectedBusy || isSelectedTesting)}
                  >
                    {isSelectedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {isSelectedBusy ? '保存中' : '保存'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// Y0.7 §11.0b labeling branch: Settings MCP section renders a "not shipped" label
// with all controls visibly inert. The Stage T authorization plumbing
// (`src/main/modules/mcp/*` + `src/__tests__/mcp-tools-authorization.test.ts`)
// stays in-tree; real transport landing is deferred to Stage Z per
// `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md` §5b.
function McpSettingsPanel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section
        aria-labelledby="mcp-not-shipped-heading"
        className="glass-surface-card rounded-2xl border"
        style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '18px 20px' }}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'var(--surface-muted)', color: 'var(--text-muted)' }}
          >
            <Plug2 className="h-4 w-4" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h3
              id="mcp-not-shipped-heading"
              className="text-[14px] font-semibold leading-6"
              style={{ color: 'var(--text-title)', margin: 0 }}
            >
              MCP 暂未发布 / MCP not shipped in this release
            </h3>
            <p
              className="text-[12px] leading-5"
              style={{ color: 'var(--text-muted)', margin: '4px 0 0', maxWidth: 640 }}
            >
              本版本不包含 MCP 客户端 transport；真实接入计划在 Stage Z 路线图中落地。See Stage Z roadmap for transport landing.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="mcp-install-disabled-heading"
        aria-disabled="true"
        className="rounded-2xl border"
        style={{
          ...SETTINGS_FLAT_CARD_STYLE,
          padding: '16px 18px',
          opacity: 0.55,
          pointerEvents: 'none',
        }}
      >
        <div className="min-w-0">
          <h4
            id="mcp-install-disabled-heading"
            className="text-[13px] font-medium"
            style={{ color: 'var(--text-title)', margin: 0 }}
          >
            MCP server install / configure (disabled)
          </h4>
          <p
            className="text-[11px] leading-5"
            style={{ color: 'var(--text-light)', margin: '4px 0 0', maxWidth: 640 }}
          >
            未发布期间不暴露安装与配置入口；占位组件保持未来界面的位置感，但所有操作不可点击。
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled
            aria-disabled="true"
            data-mcp-control="install-server"
            className="inline-flex items-center gap-1.5 rounded-xl border text-[12px] font-medium"
            style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '7px 12px', opacity: 0.6, cursor: 'not-allowed' }}
          >
            安装 MCP server（不可用）
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            data-mcp-control="configure-transport"
            className="inline-flex items-center gap-1.5 rounded-xl border text-[12px] font-medium"
            style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '7px 12px', opacity: 0.6, cursor: 'not-allowed' }}
          >
            配置 transport（不可用）
          </button>
        </div>
      </section>

      <section
        aria-labelledby="mcp-stage-t-plumbing-heading"
        className="rounded-2xl border"
        style={{ ...SETTINGS_FLAT_CARD_STYLE, padding: '14px 16px' }}
      >
        <h4
          id="mcp-stage-t-plumbing-heading"
          className="text-[12px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: 'var(--text-light)', margin: 0 }}
        >
          Stage T authorization plumbing — visibly inert
        </h4>
        <p
          className="text-[11px] leading-5"
          style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}
        >
          Stage T 已落地的 MCP 授权管道（<code>src/main/modules/mcp/*</code>）继续保留在仓库内并通过既有测试 <code>src/__tests__/mcp-tools-authorization.test.ts</code>。本版本不再向 UI 暴露任何 MCP 工具或登录入口；真实 transport 接入计划在 Stage Z 落地后再启用此处的入口。
        </p>
      </section>
    </div>
  )
}

function MemorySettingsSection() {
  const [filters, setFilters] = useState<MemoryQueryFilters>({ limit: 50 })
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const memories = useMemories(filters)
  const stats = useMemoryStats()
  const lifecycle = useMemoryLifecycle()

  const refreshMemorySection = useCallback(async () => {
    await Promise.all([memories.refresh(), stats.refresh()])
  }, [memories.refresh, stats.refresh])

  const handleRunMaintenance = useCallback(async () => {
    const result = await lifecycle.runMaintenance()
    await refreshMemorySection()
    return result
  }, [lifecycle.runMaintenance, refreshMemorySection])

  const handleDeleteMemory = useCallback(async (id: string) => {
    await memories.deleteMemory(id)
    await stats.refresh()
  }, [memories.deleteMemory, stats.refresh])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div
        className="glass-surface-card border"
        style={{
          ...SETTINGS_CARD_STYLE,
          borderRadius: 24,
          padding: '18px 22px'
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[16px] font-semibold" style={{ color: 'var(--text-title)', margin: 0 }}>
              最近记住了什么
            </h3>
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Agent 自动沉淀的偏好、任务经验和长期事实会出现在这里。
            </p>
          </div>
          {stats.stats && (
            <div
              className="text-[12px] rounded-xl"
              style={{
                color: 'var(--text-body)',
                background: 'color-mix(in srgb, var(--surface-panel-bg) 66%, transparent)',
                padding: '8px 12px'
              }}
            >
              共 {stats.stats.totalMemories} 条
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 340px) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
        <MemoryStatsCard
          stats={stats.stats}
          statsLoading={stats.loading}
          statsError={stats.error}
          status={lifecycle.status}
          lifecycleLoading={lifecycle.loading}
          lifecycleError={lifecycle.error}
          maintenanceRunning={lifecycle.maintenanceRunning}
          onRunMaintenance={handleRunMaintenance}
        />
        <div
          className="glass-surface-card border"
          style={{
            ...SETTINGS_CARD_STYLE,
            borderRadius: 24,
            minHeight: 520,
            overflow: 'hidden'
          }}
        >
          <MemoryListPanel
            memories={memories.memories}
            loading={memories.loading}
            error={memories.error}
            filters={filters}
            onFiltersChange={setFilters}
            onDeleteMemory={handleDeleteMemory}
          />
        </div>
      </div>

      <section
        className="glass-surface-card border"
        style={{
          ...SETTINGS_CARD_STYLE,
          borderRadius: 24,
          overflow: 'hidden'
        }}
      >
        <button
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          className="w-full flex items-center justify-between gap-3 text-left"
          style={{ padding: '16px 20px' }}
          aria-expanded={advancedOpen}
        >
          <div>
            <h3 className="text-[15px] font-medium" style={{ color: 'var(--text-title)', margin: 0 }}>
              高级记忆工具
            </h3>
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)', margin: '4px 0 0' }}>
              手动创建、原始详情和触发规则放在这里。
            </p>
          </div>
          <ChevronRight
            className="w-4 h-4 transition-transform"
            style={{
              color: 'var(--text-muted)',
              transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)'
            }}
          />
        </button>
        {advancedOpen && (
          <div
            className="border-t"
            style={{ borderColor: 'var(--border-default)', padding: 20 }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 340px) minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
              <MemoryCreator onCreated={refreshMemorySection} />
              <div
                className="border"
                style={{
                  ...SETTINGS_SUBTLE_CARD_STYLE,
                  borderRadius: 18,
                  minHeight: 420,
                  overflow: 'hidden'
                }}
              >
                <MemoryListPanel
                  memories={memories.memories}
                  loading={memories.loading}
                  error={memories.error}
                  filters={filters}
                  onFiltersChange={setFilters}
                  onDeleteMemory={handleDeleteMemory}
                  showAdvancedDetails
                />
              </div>
            </div>
            <div
              className="border"
              style={{
                ...SETTINGS_SUBTLE_CARD_STYLE,
                borderRadius: 18,
                marginTop: 20,
                minHeight: 360,
                overflow: 'hidden'
              }}
            >
              <TriggerManager />
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

interface SettingsPageProps {
  initialSection?: string
}

export default function Settings({ initialSection }: SettingsPageProps = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const routeSection = new URLSearchParams(location.search).get('section') || undefined
  const [activeSection, setActiveSection] = useState(initialSection || routeSection || 'account')
  const [settings, setSettings] = useState(settingsData)
  const { theme, setTheme, skin, setSkin, accent, setAccent } = useTheme()

  const currentSection = settings.find(s => s.id === activeSection)

  useEffect(() => {
    const nextSection = initialSection || routeSection
    if (!nextSection) return
    const exists = settingsData.some((section) => section.id === nextSection)
    if (exists) {
      setActiveSection(nextSection)
    }
  }, [initialSection, routeSection])

  const updateSetting = (sectionId: string, settingId: string, value: boolean | string) => {
    setSettings(settings.map(section =>
      section.id === sectionId
        ? {
          ...section,
          settings: section.settings.map(s =>
            s.id === settingId ? { ...s, value } : s
          )
        }
        : section
    ))
  }

  const getSettingControlWidth = (setting: SettingItem): number | undefined => {
    if (!setting.slotWidth) return undefined
    return SETTING_SLOT_WIDTHS[setting.slotWidth]
  }

  const isDynamicSection = currentSection
    ? ['ai', 'remote-im', 'external-services', 'mcp', 'memory', 'personalities', 'user-profiles', 'pet', 'rss-storage', MODELS_RUNTIME_SETTINGS_SECTION, 'storage'].includes(currentSection.id)
    : false

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'transparent' }}>
      {/* Header — macOS traffic light clearance with paddingLeft: 72 */}
      <div
        data-liquid-shell="settings-header"
        className="mx-3 mt-3 flex h-[46px] items-center rounded-[18px] drag-region"
        style={{
          background: 'transparent',
          paddingLeft: 72,
          paddingRight: 18,
          borderBottom: '1px solid transparent',
          boxShadow: 'none',
        }}
      >
        <button
          onClick={() => navigate('/')}
          className="no-drag flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <ChevronLeft className="w-4 h-4" strokeWidth={2} />
          <span className="text-[12px]">返回</span>
        </button>
        <span
          className="text-[13px] font-semibold ml-3"
          style={{ color: 'var(--text-title)' }}
        >
          设置
        </span>
      </div>

      {/* Content */}
      <div className="flex flex-1 gap-3 overflow-hidden px-3 pb-3 pt-3">
        {/* Sidebar Navigation */}
        <div
          data-liquid-shell="settings-sidebar"
          className="panel-hover-scrollbar flex-shrink-0 overflow-auto"
          style={{
            width: 252,
            background: 'transparent',
            padding: '10px 8px',
            scrollbarGutter: 'stable',
          }}
        >
          <div className="flex flex-col gap-1">
            {settings.map((section) => {
              const isActive = activeSection === section.id
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className="flex items-center gap-3 rounded-[18px] transition-[background-color,border-color,color] duration-200 text-left group"
                  style={settingsListItemStyle(isActive)}
                >
                  <div
                    className="w-8 h-8 flex items-center justify-center flex-shrink-0 transition-colors"
                  >
                    <Icon
                      className="w-3.5 h-3.5"
                      strokeWidth={2}
                      style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-muted)' }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-[13px] font-semibold truncate"
                      style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-title)' }}
                    >
                      {section.title}
                    </div>
                    <div
                      className="text-[11px] truncate mt-0.5"
                      style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-light)', opacity: isActive ? 0.7 : 1 }}
                    >
                      {section.description}
                    </div>
                  </div>
                  <ChevronRight
                    className="w-3.5 h-3.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-light)' }}
                  />
                </button>
              )
            })}
          </div>

          {/* Footer info */}
          <div className="mt-6 pt-1">
            <div className="flex items-center gap-2 px-1">
              <HardDrive className="w-3 h-3" style={{ color: 'var(--text-light)' }} />
              <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                Ready v0.1.0 · Electron 34
              </span>
            </div>
          </div>
        </div>

        {/* Settings Content Panel */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div
            data-liquid-shell="settings-content"
            className="h-full overflow-auto"
            style={{ background: 'transparent' }}
          >
          <div className="w-full max-w-[1040px] mx-auto" style={{ padding: '30px 34px 64px' }}>
                {currentSection && (
                  <>
                    {/* Section Header */}
                        <div style={{ padding: '4px 0 0', marginBottom: 20 }}>
                      <h2
                        className="text-[22px] font-semibold leading-7 tracking-[-0.01em]"
                        style={{ color: 'var(--text-title)', margin: 0 }}
                      >
                        {currentSection.title}
                      </h2>
                      <p
                        className="text-[13px] leading-6"
                        style={{ color: 'var(--text-muted)', maxWidth: 720, margin: '4px 0 0 0' }}
                      >
                        {currentSection.description}
                      </p>
                    </div>

                {/* AI Settings Panel — dynamic, wired to backend */}
                {currentSection.id === 'ai' && <AISettingsPanel />}
                {currentSection.id === 'rss-storage' && <RSSDraftStoreSettingsPanel />}
                {currentSection.id === MODELS_RUNTIME_SETTINGS_SECTION && <ModelsRuntimeSettingsPanel />}
                {currentSection.id === 'storage' && <StorageSettingsPanel />}
                {currentSection.id === 'remote-im' && <RemoteIMSettingsPanel />}
                {currentSection.id === 'external-services' && <ExternalServicesSettingsPanel />}
                {currentSection.id === 'mcp' && <McpSettingsPanel />}
                {currentSection.id === 'pet' && <PetSettingsPanel />}
                {currentSection.id === 'memory' && (
                  <MemorySettingsSection />
                )}

                {/* Agent Personalities — custom layout */}
                {currentSection.id === 'personalities' && (
                  <div>
                    <PersonalityEditor />
                  </div>
                )}

                {/* User Profiles — custom layout */}
                {currentSection.id === 'user-profiles' && (
                  <div>
                    <UserProfileEditor />
                  </div>
                )}

                {/* Theme Switcher — only in Appearance section */}
                {currentSection.id === 'appearance' && (
                  <>
                    <div style={{ marginBottom: 40 }}>
                      <h4
                        className="text-[12px] font-semibold uppercase tracking-[0.18em] mb-4"
                        style={{ color: 'var(--text-light)' }}
                      >
                        主题模式
                      </h4>
                      <div className="flex gap-4">
                        {themeOptions.map((opt) => {
                          const isActive = theme === opt.value
                          const OptIcon = opt.icon
                          return (
                            <button
                              key={opt.value}
                              onClick={() => setTheme(opt.value)}
                              className="glass-surface-card flex-1 flex flex-col items-center gap-2.5 rounded-[24px] border transition-[background-color,border-color,color] duration-200"
                              style={{
                                padding: '22px 18px',
                                ...(isActive ? {
                                  borderColor: 'color-mix(in srgb, var(--color-blue) 38%, var(--lg-border-soft) 62%)',
                                  background: 'color-mix(in srgb, var(--color-blue-light) 72%, var(--surface-card-bg) 28%)',
                                  boxShadow: 'var(--lg-shadow-contact), inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 22%, transparent)',
                                } : SETTINGS_CARD_STYLE),
                              }}
                            >
                              <div
                                className="glass-surface-floating w-10 h-10 rounded-xl flex items-center justify-center"
                                style={{
                                  background: isActive
                                    ? 'color-mix(in srgb, var(--color-blue) 84%, var(--surface-floating-bg) 16%)'
                                    : 'color-mix(in srgb, var(--surface-floating-bg) 60%, transparent)',
                                }}
                              >
                                <OptIcon
                                  className="w-5 h-5"
                                  strokeWidth={1.8}
                                  style={{ color: isActive ? '#FFFFFF' : 'var(--text-muted)' }}
                                />
                              </div>
                              <span
                                className="text-[14px] font-semibold"
                                style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-body)' }}
                              >
                                {opt.label}
                              </span>
                              <span className="text-[11px] leading-5 text-center" style={{ color: 'var(--text-light)' }}>
                                {opt.description}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div style={{ marginBottom: 40 }}>
                      <h4
                        className="text-[12px] font-semibold uppercase tracking-[0.18em] mb-4"
                        style={{ color: 'var(--text-light)' }}
                      >
                        视觉风格
                      </h4>
                      <div className="grid grid-cols-2 gap-3">
                        {skinOptions.map((opt) => {
                          const isActive = skin === opt.value
                          const OptIcon = opt.icon
                          return (
                            <button
                              key={opt.value}
                              onClick={() => setSkin(opt.value)}
                              className="glass-surface-card flex items-center gap-3 rounded-[24px] border text-left transition-[background-color,border-color,color] duration-200"
                              style={{
                                padding: '16px 16px',
                                ...(isActive ? {
                                  borderColor: 'color-mix(in srgb, var(--color-blue) 38%, var(--lg-border-soft) 62%)',
                                  background: 'color-mix(in srgb, var(--color-blue-light) 72%, var(--surface-card-bg) 28%)',
                                  boxShadow: 'var(--lg-shadow-contact), inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 22%, transparent)',
                                } : SETTINGS_CARD_STYLE),
                              }}
                            >
                              <div
                                className="glass-surface-floating h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                                style={{
                                  background: isActive
                                    ? 'color-mix(in srgb, var(--color-blue) 84%, var(--surface-floating-bg) 16%)'
                                    : 'color-mix(in srgb, var(--surface-floating-bg) 60%, transparent)',
                                }}
                              >
                                <OptIcon
                                  className="w-4.5 h-4.5"
                                  strokeWidth={1.8}
                                  style={{ color: isActive ? '#FFFFFF' : 'var(--text-muted)' }}
                                />
                              </div>
                              <div className="min-w-0">
                                <div
                                  className="text-[13px] font-semibold truncate"
                                  style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-body)' }}
                                >
                                  {opt.label}
                                </div>
                                <div className="text-[11px] mt-0.5 leading-5" style={{ color: 'var(--text-light)' }}>
                                  {opt.description}
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </>
                )}

                {/* Settings Items (skip for dynamic sections) */}
                {!isDynamicSection && <div className="flex flex-col gap-7">
                  {currentSection.settings.map((setting) => (
                    <div
                      key={setting.id}
                      className="flex items-center justify-between transition-colors"
                      style={{
                        padding: 0,
                      }}
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
                          {setting.label}
                        </div>
                        {setting.description && (
                          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
                            {setting.description}
                          </div>
                        )}
                      </div>

                      {/* Toggle */}
                      {setting.type === 'toggle' && (
                        <button
                          onClick={() => updateSetting(currentSection.id, setting.id, !setting.value)}
                          className="flex-shrink-0 transition-colors duration-200"
                          style={{
                            width: 48,
                            height: 28,
                            borderRadius: 999,
                            position: 'relative',
                            border: `1px solid ${setting.value
                              ? 'color-mix(in srgb, var(--color-blue) 34%, transparent)'
                              : 'color-mix(in srgb, var(--lg-border-soft) 88%, transparent)'}`,
                            background: setting.value
                              ? 'color-mix(in srgb, var(--color-blue) 82%, var(--surface-floating-bg) 18%)'
                              : 'color-mix(in srgb, var(--surface-panel-bg) 64%, transparent)',
                            boxShadow: 'var(--lg-shadow-contact), inset 0 1px 0 color-mix(in srgb, var(--lg-border-strong) 30%, transparent)',
                            backdropFilter: 'blur(calc(var(--lg-blur-soft) * 0.86)) saturate(calc(var(--surface-saturate) + 8%))',
                            WebkitBackdropFilter: 'blur(calc(var(--lg-blur-soft) * 0.86)) saturate(calc(var(--surface-saturate) + 8%))',
                          }}
                        >
                          <span
                            className="absolute bg-white rounded-full shadow-sm transition-[transform,left,right] duration-200"
                            style={{
                              top: 3,
                              width: 22,
                              height: 22,
                              left: setting.value ? 23 : 3,
                            }}
                          />
                        </button>
                      )}

                      {/* Select */}
                      {setting.type === 'select' && (
                        <select
                          value={currentSection.id === 'appearance' && setting.id === 'theme' ? accent : setting.value as string}
                          onChange={(e) => {
                            const nextValue = e.target.value
                            if (currentSection.id === 'appearance' && setting.id === 'theme') {
                              setAccent(nextValue as ThemeAccent)
                              return
                            }
                            updateSetting(currentSection.id, setting.id, nextValue)
                          }}
                          className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
                          style={{
                            ...SETTINGS_INPUT_STYLE,
                            padding: '9px 32px 9px 14px',
                            width: 180,
                          }}
                        >
                          {setting.options?.map(opt => (
                            <option key={typeof opt === 'string' ? opt : opt.value} value={typeof opt === 'string' ? opt : opt.value}>
                              {typeof opt === 'string' ? opt : opt.label}
                            </option>
                          ))}
                        </select>
                      )}

                      {/* Editable text */}
                      {setting.type === 'text' && (
                        <input
                          type={setting.id === 'apiKey' ? 'password' : 'text'}
                          value={setting.value as string}
                          onChange={(e) => updateSetting(currentSection.id, setting.id, e.target.value)}
                          className="flex-shrink-0 rounded-lg border text-[12px] text-center focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200"
                          style={{
                            ...SETTINGS_INPUT_STYLE,
                            padding: '9px 14px',
                            width: 240,
                          }}
                        />
                      )}

                      {/* Readonly value */}
                      {setting.type === 'readonly' && (
                        <span
                          className="flex-shrink-0 text-[12px] font-mono rounded-lg"
                          style={{
                            ...SETTINGS_READONLY_STYLE,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '8px 12px',
                            width: getSettingControlWidth(setting),
                            textAlign: 'center',
                          }}
                        >
                          {setting.value}
                        </span>
                      )}

                      {/* Button */}
                      {setting.type === 'button' && (
                        <button
                          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                          style={{
                            ...(setting.buttonVariant === 'primary'
                              ? SETTINGS_PRIMARY_BUTTON_STYLE
                              : setting.buttonVariant === 'danger'
                                ? SETTINGS_DANGER_BUTTON_STYLE
                                : SETTINGS_SECONDARY_BUTTON_STYLE),
                            width: getSettingControlWidth(setting),
                            justifyContent: 'center',
                          }}
                        >
                          {setting.buttonVariant === 'danger' && <Trash2 className="w-3 h-3" />}
                          {setting.buttonLabel || '执行'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>}

                {/* About section extra info */}
                {currentSection.id === 'about' && (
                  <div className="mt-6">
                    <button
                      className="flex items-center gap-2 text-[12px] hover:underline transition-colors"
                      style={{ color: 'var(--color-blue)' }}
                    >
                      <ExternalLink className="w-3 h-3" />
                      访问 Ready 官方网站
                    </button>
                    <p className="text-[11px] mt-4" style={{ color: 'var(--text-light)' }}>
                      Ready — 面向自媒体创作者的 AI 桌面工作台
                      <br />
                      Built with Electron · React · TypeScript
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
