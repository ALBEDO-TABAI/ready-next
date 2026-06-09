import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  ChevronLeft, User, Bell, Shield, Database,
  Palette, Keyboard, Globe, Info, Moon, Sun, Bot, Monitor, Droplets,
  ChevronRight, ExternalLink, HardDrive, Trash2, RefreshCw, CheckCircle2, XCircle, Loader2, MessageSquare, Brain, Users, Sparkles, Cat,
  Plug2, Boxes, FileArchive
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme, type ThemeAccent, type ThemeSkin } from '../stores/useTheme'
import { resolveAIConfigCapabilities, getActiveAIProfile } from '../../shared/ai-providers'
import { nextIntentId } from '../../shared/browser-view-intent'
import type { CapabilityRuntimeSnapshot } from '../../shared/ai-capability-runtime'
import { listSettingsCapabilityGroups, type CapabilityGroupId } from '../../shared/ai-capability-groups'
import { useSettings, getProviderDef } from '../stores/useSettings'
import type { AIProviderCategory } from '../stores/useSettings'
import type { ExternalServiceOptionValue, ExternalServiceUpdateInput, PublicExternalServiceProfile } from '../../shared/external-services'
import RemoteIMSettingsPanel from '../components/settings/RemoteIMSettingsPanel'
import PetSettingsPanel from '../components/settings/PetSettingsPanel'
import ModelsRuntimeSettingsPanel from '../components/settings/ModelsRuntimeSettingsPanel'
import { MODELS_RUNTIME_SETTINGS_SECTION } from '../../shared/model-pack-types'
import { FILE_EMERGENCE_SETTING_KEY } from '../../shared/file-emergence'
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

const AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY = 'agent.autoNarrationContinuation'

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

const SETTINGS_SURFACE_REFRESH_DELAY_MS = 120
const RSS_DRAFT_CONTENT_MAX_WIDTH = 1560
const RSS_DRAFT_GRID_COLUMNS = 'minmax(300px, 1fr) 72px 84px 72px 120px 128px'
const RSS_DRAFT_SOURCE_COLUMN_PADDING = 44
const RSS_DRAFT_LIGHT_BORDER = '1px solid color-mix(in srgb, var(--surface-border) 14%, transparent)'
const RSS_DRAFT_DIVIDER = '1px solid color-mix(in srgb, var(--surface-border) 12%, transparent)'

const RSS_DRAFT_SUBTLE_SURFACE_STYLE: CSSProperties = {
  border: RSS_DRAFT_LIGHT_BORDER,
  borderRadius: 12,
  background: 'color-mix(in srgb, var(--surface-card-bg) 8%, transparent)',
  boxShadow: 'none',
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
    id: 'agent',
    title: 'Agent',
    icon: Sparkles,
    description: '控制 Agent 的后台任务提示与续跑',
    settings: [
      {
        id: AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY,
        label: '后台任务自动播报',
        description: '没有活跃对话运行时，后台任务完成后自动生成一条结果播报。',
        type: 'toggle',
        value: true,
      },
    ],
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
      {
        id: FILE_EMERGENCE_SETTING_KEY,
        label: '文件涌现',
        description: '根据日程、文件活动、最近对话和浏览记录，在文件管理顶部显示可能相关的项目。',
        type: 'toggle',
        value: true,
      },
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
      className={`settings-ai-light-card ${wide ? 'md:col-span-2' : ''}`}
      style={{
        borderBottom: '1px solid color-mix(in srgb, var(--surface-border) 12%, transparent)',
        padding: '0 0 18px',
      }}
    >
      <div className="min-w-0">
        <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>{title}</div>
        <div className="mt-1.5 text-[12px] leading-5" style={{ color: 'var(--text-light)', maxWidth: 560 }}>{description}</div>
      </div>
      <div className="mt-3.5 min-w-0">{control}</div>
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
  borderRadius: 14,
  padding: '13px 15px',
  width: '100%',
  textAlign: 'left' as const,
  fontSize: 14,
}
const stackedSelectStyle = {
  ...SETTINGS_FLAT_INPUT_STYLE,
  borderRadius: 14,
  padding: '13px 36px 13px 15px',
  width: '100%',
  fontSize: 14,
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
              <div className="text-[16px] font-semibold" style={{ color: 'var(--text-title)' }}>模型入口列表</div>
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
                  className="rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors"
                  style={{
                    background: active ? 'color-mix(in srgb, var(--color-blue-light) 42%, transparent)' : 'transparent',
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
                    className="grid w-full items-center gap-7 text-left transition-colors"
                    style={{
                      gridTemplateColumns: 'minmax(360px,1.6fr) minmax(160px,.55fr) 120px 88px',
                      minHeight: 88,
                      padding: '18px 42px',
                      borderBottom: '1px solid color-mix(in srgb, var(--surface-border) 10%, transparent)',
                      background: selected ? 'color-mix(in srgb, var(--color-blue-light) 14%, transparent)' : 'transparent',
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
                <div className="text-[18px] font-semibold" style={{ color: 'var(--text-title)' }}>编辑 {selectedProfile.name}</div>
                <div className="mt-1.5 truncate text-[13px]" style={{ color: 'var(--text-light)' }}>
                  {selectedConfig.model || '未设置模型'} · {formatInterfaceLabel(selectedConfig)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!selectedIsActive && (
                  <button
                    type="button"
                    onClick={() => activateProfile(selectedProfile.id)}
                    className="text-[13px] font-semibold"
                    style={{ color: 'var(--color-blue)' }}
                  >
                    设为默认
                  </button>
                )}
                {!selectedProfile.builtIn && (
                  <button
                    type="button"
                    onClick={() => removeCustomProfile(selectedProfile.id)}
                    className="text-[13px] font-semibold"
                    style={{ color: 'color-mix(in srgb, var(--color-red) 68%, var(--text-muted) 32%)' }}
                  >
                    删除
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void testConnection(selectedProfile.id)}
                  disabled={testStatus === 'testing'}
                  className="rounded-full text-[13px] font-semibold disabled:opacity-50"
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
                    className="rounded-xl px-3 py-2.5 text-[14px] font-semibold leading-none transition-colors"
                    style={{
                      minHeight: 36,
                      background: active ? 'color-mix(in srgb, var(--color-blue-light) 66%, var(--surface-floating-bg) 34%)' : 'transparent',
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
                    ) : '自定义供应商地址'}
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
                    <AISettingsSwitch
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
                                className="flex items-center gap-2 rounded-full border px-3 py-1.5"
                                style={SETTINGS_FLAT_CHIP_STYLE}
                              >
                                <span className="font-mono text-[11px]" style={{ color: 'var(--text-body)' }}>{modelId}</span>
                                {isDefaultModel ? (
                                  <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green-light) 42%, transparent)' }}>默认</span>
                                ) : (
                                  <button type="button" onClick={() => updateField('model', modelId)} className="text-[10px] font-semibold" style={{ color: 'var(--color-blue)' }}>设默认</button>
                                )}
                                <button type="button" onClick={() => removeModelId(modelId)} className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>删除</button>
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
                            className="rounded-full text-[12px] font-semibold disabled:opacity-50"
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
                      description={`当前为 ${capabilities?.supportsToolCalls ? '开启' : '关闭'}。`}
                      control={(
                        <select
                          value={selectedConfig.toolUseMode || 'auto'}
                          onChange={(event) => updateField('toolUseMode', (event.target.value === 'auto' ? undefined : event.target.value) as typeof selectedConfig.toolUseMode)}
                          className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                          style={stackedSelectStyle}
                        >
                          <option value="auto">自动</option>
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
                    <AISettingsSwitch
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
function RSSDraftStoreSettingsPanel() {
  const [sources, setSources] = useState<RSSDraftStoreSourceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const summary = useMemo(
    () => ({
      sourceCount: sources.length,
      storedCount: sources.reduce((total, source) => total + source.storedCount, 0),
      inboxCount: sources.reduce((total, source) => total + source.inboxCount, 0),
      starredCount: sources.reduce((total, source) => total + source.starredCount, 0),
    }),
    [sources],
  )

  const summaryItems = [
    { label: '源', value: `${summary.sourceCount} 个` },
    { label: '底稿', value: `${summary.storedCount} 条` },
    { label: '收件箱', value: `${summary.inboxCount} 条` },
    { label: '收藏', value: `${summary.starredCount} 条` },
  ]

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
    const confirmed = window.confirm(
      sourceId
        ? `确认重新完整抓取「${sourceName || '当前源'}」吗？\n\n这会清空该源已缓存的底稿，下次刷新会重新走首次完整抓取。`
        : '确认清空全部 RSS 底稿吗？\n\n这会清空所有源已缓存的底稿，下次刷新会重新走首次完整抓取。',
    )
    if (!confirmed) return
    setBusyKey(sourceId || 'all')
    try {
      const result = await window.electronAPI.rss.clearDraftStore(sourceId ? { sourceId } : undefined)
      if (!result.success || !result.data) {
        setMessage(result.error || '重置 RSS 底稿仓库失败')
        return
      }
      await loadSources()
      setMessage(
        sourceId
          ? `${sourceName || '当前源'} 已重置，下次刷新会重新走首次完整抓取`
          : '全部 RSS 底稿已重置，下次刷新会重新走首次完整抓取',
      )
    } finally {
      setBusyKey(null)
    }
  }, [loadSources])

  return (
    <div className="flex w-full flex-col gap-5" style={{ maxWidth: RSS_DRAFT_CONTENT_MAX_WIDTH }}>
      <div
        style={{
          borderTop: RSS_DRAFT_DIVIDER,
          borderBottom: RSS_DRAFT_DIVIDER,
          padding: '22px 0 18px',
        }}
      >
        <div className="flex flex-wrap items-center gap-x-10 gap-y-4">
          {summaryItems.map((item, index) => (
            <div
              key={item.label}
              className="flex items-baseline gap-2"
              style={{
                paddingLeft: index === 0 ? 0 : 40,
                borderLeft: index === 0 ? 'none' : RSS_DRAFT_DIVIDER,
              }}
            >
              <strong className="text-[20px] font-semibold leading-none" style={{ color: 'var(--text-title)' }}>{item.value}</strong>
              <span className="text-[12px]" style={{ color: 'var(--text-light)' }}>{item.label}</span>
            </div>
          ))}
          <span
            className="ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium"
            style={{
              border: RSS_DRAFT_LIGHT_BORDER,
              background: 'color-mix(in srgb, var(--surface-card-bg) 10%, transparent)',
              color: 'var(--text-muted)',
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--color-green)' }} />
            默认增量刷新
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 px-0.5 text-[12px] leading-6" style={{ color: 'var(--text-light)' }}>
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span>
          重置底稿不会删除 RSS 源、收藏或收件箱内容，只会让下次刷新重新完整抓取。
        </span>
      </div>
      {message && (
        <div
          className="rounded-lg px-3 py-2 text-[12px]"
          style={{
            border: RSS_DRAFT_LIGHT_BORDER,
            background: 'color-mix(in srgb, var(--surface-panel-bg) 8%, transparent)',
            color: 'var(--text-muted)',
          }}
        >
          {message}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-3" style={{ ...RSS_DRAFT_SUBTLE_SURFACE_STYLE, padding: '16px 18px' }}>
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-blue)' }} />
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取 RSS 底稿列表…</span>
        </div>
      ) : sources.length === 0 ? (
        <div style={{ ...RSS_DRAFT_SUBTLE_SURFACE_STYLE, padding: '18px' }}>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>还没有底稿内容</div>
          <div className="mt-1 text-[12px]" style={{ color: 'var(--text-light)' }}>等你添加源并刷新后，这里会显示每个源的存量和当前刷新状态。</div>
        </div>
      ) : (
        <div className="overflow-x-auto" style={RSS_DRAFT_SUBTLE_SURFACE_STYLE}>
          <div style={{ minWidth: 920 }}>
            <div
              className="grid items-center gap-6 text-[12px] font-medium"
              style={{
                gridTemplateColumns: RSS_DRAFT_GRID_COLUMNS,
                color: 'var(--text-light)',
                borderBottom: RSS_DRAFT_DIVIDER,
                padding: '28px 0 18px',
              }}
            >
              <span style={{ paddingLeft: RSS_DRAFT_SOURCE_COLUMN_PADDING }}>来源</span>
              <span>底稿</span>
              <span>收件箱</span>
              <span>收藏</span>
              <span>刷新方式</span>
              <span style={{ textAlign: 'left' }}>操作</span>
            </div>
            {sources.map((source, index) => (
              <div
                key={source.sourceId}
                className="grid min-h-[86px] items-center gap-6 px-6 py-4"
                style={{
                  gridTemplateColumns: RSS_DRAFT_GRID_COLUMNS,
                  borderTop: index === 0 ? 'none' : RSS_DRAFT_DIVIDER,
                }}
              >
                <div className="min-w-0" style={{ paddingLeft: RSS_DRAFT_SOURCE_COLUMN_PADDING }}>
                  <div className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-title)' }} title={source.sourceName}>
                    {source.sourceName}
                  </div>
                  <div className="mt-1 truncate text-[12px]" style={{ color: 'var(--text-light)' }} title={source.sourceUrl}>
                    {source.sourceUrl}
                  </div>
                </div>
                <strong className="text-[14px] font-medium" style={{ color: 'var(--text-title)' }}>{source.storedCount}</strong>
                <strong className="text-[14px] font-medium" style={{ color: 'var(--text-title)' }}>{source.inboxCount}</strong>
                <span className="text-[14px]" style={{ color: 'var(--text-muted)' }}>{source.starredCount}</span>
                <span
                  className="inline-flex w-fit items-center gap-2 rounded-full px-2.5 py-1 text-[12px] font-medium"
                  style={{
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: source.refreshMode === 'incremental' ? 'var(--color-green)' : 'var(--color-orange)' }}
                  />
                  {source.refreshMode === 'incremental' ? '增量刷新' : '首次完整'}
                </span>
                <button
                  onClick={() => void handleClear(source.sourceId, source.sourceName)}
                  disabled={busyKey !== null}
                  className="ml-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: 'color-mix(in srgb, var(--color-red) 42%, var(--text-muted) 58%)',
                  }}
                >
                  {busyKey === source.sourceId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  重新完整抓取
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        aria-label="清空全部底稿"
        onClick={() => void handleClear()}
        disabled={busyKey !== null}
        className="w-full text-left transition-[filter,transform,opacity] duration-200 hover:brightness-110 active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          ...RSS_DRAFT_SUBTLE_SURFACE_STYLE,
          padding: `20px 24px 20px ${RSS_DRAFT_SOURCE_COLUMN_PADDING}px`,
        }}
      >
        <div className="flex items-center gap-3 text-[13px] font-semibold" style={{ color: 'var(--color-red)' }}>
          {busyKey === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          清空全部底稿
        </div>
        <div className="mt-2 text-[12px]" style={{ color: 'var(--text-light)' }}>
          清空后会移除所有历史底稿数据，下一次刷新将重新完整抓取。
        </div>
      </button>
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
  const [diagnosticExporting, setDiagnosticExporting] = useState<boolean>(false)
  const [diagnosticResult, setDiagnosticResult] = useState<{ path?: string; bytes?: number; error?: string } | null>(null)
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

  const exportDiagnosticPack = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.app?.exportDiagnosticPack) {
      setDiagnosticResult({ error: 'IPC 不可用' })
      return
    }
    setDiagnosticExporting(true)
    setDiagnosticResult(null)
    try {
      const result = await window.electronAPI.app.exportDiagnosticPack()
      if (result.success && result.data) {
        setDiagnosticResult({
          path: result.data.path,
          bytes: result.data.bytes,
        })
      } else {
        setDiagnosticResult({ error: result.error || '导出失败' })
      }
    } catch (err) {
      // silent-catch: export failures are surfaced in the diagnostics panel.
      setDiagnosticResult({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setDiagnosticExporting(false)
    }
  }, [])

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

      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
            报错信息包
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            导出最近日志、运行状态和脱敏配置，方便定位打包版问题
          </div>
          {diagnosticResult && (
            <div
              className="mt-2 text-[11px] leading-5 break-all"
              style={{ color: diagnosticResult.error ? 'var(--color-red, #d44)' : 'var(--text-muted)' }}
            >
              {diagnosticResult.error
                ? diagnosticResult.error
                : `已导出：${diagnosticResult.path}${diagnosticResult.bytes ? `（${formatBytes(diagnosticResult.bytes)}）` : ''}`}
            </div>
          )}
        </div>
        <button
          onClick={() => { void exportDiagnosticPack() }}
          disabled={diagnosticExporting}
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
          style={{
            ...SETTINGS_SECONDARY_BUTTON_STYLE,
            width: SETTING_SLOT_WIDTHS.short,
            justifyContent: 'center',
            opacity: diagnosticExporting ? 0.6 : 1,
            cursor: diagnosticExporting ? 'not-allowed' : 'pointer',
          }}
        >
          {diagnosticExporting
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <FileArchive className="w-3 h-3" />}
          {diagnosticExporting ? '导出中…' : '导出'}
        </button>
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
  const [settingErrors, setSettingErrors] = useState<Record<string, string>>({})
  const { theme, setTheme, skin, setSkin, accent, setAccent } = useTheme()
  const didMountRef = useRef(false)
  const settingsSurfaceRefreshTimerRef = useRef<number | null>(null)

  const currentSection = settings.find(s => s.id === activeSection)
  const isAiSection = currentSection?.id === 'ai'

  useEffect(() => {
    window.electronAPI?.browser?.sendIntent({
      kind: 'hide-all',
      intentId: nextIntentId(),
      reason: 'overlay-open',
    })
  }, [])

  useEffect(() => {
    const nextSection = initialSection || routeSection
    if (!nextSection) return
    const exists = settingsData.some((section) => section.id === nextSection)
    if (exists) {
      setActiveSection(nextSection)
    }
  }, [initialSection, routeSection])

  const requestSettingsSurfaceRefresh = useCallback(() => {
    const refresh = window.electronAPI?.window?.refreshTransparentSurface
    if (!refresh) return
    void refresh()
  }, [])

  const scheduleSettingsSurfaceRefresh = useCallback(() => {
    if (settingsSurfaceRefreshTimerRef.current !== null) {
      window.clearTimeout(settingsSurfaceRefreshTimerRef.current)
    }
    settingsSurfaceRefreshTimerRef.current = window.setTimeout(() => {
      settingsSurfaceRefreshTimerRef.current = null
      requestSettingsSurfaceRefresh()
    }, SETTINGS_SURFACE_REFRESH_DELAY_MS)
  }, [requestSettingsSurfaceRefresh])

  const handleSettingsSurfaceScroll = useCallback(() => {
    scheduleSettingsSurfaceRefresh()
  }, [scheduleSettingsSurfaceRefresh])

  const handleSettingsSurfaceMotion = useCallback(() => {
    scheduleSettingsSurfaceRefresh()
  }, [scheduleSettingsSurfaceRefresh])

  useEffect(() => {
    return () => {
      if (settingsSurfaceRefreshTimerRef.current !== null) {
        window.clearTimeout(settingsSurfaceRefreshTimerRef.current)
        settingsSurfaceRefreshTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      requestSettingsSurfaceRefresh()
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [activeSection, requestSettingsSurfaceRefresh])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings?.get) return
    let cancelled = false
    void (async () => {
      const result = await window.electronAPI.settings.get(FILE_EMERGENCE_SETTING_KEY)
      if (cancelled) return
      if (result?.success) {
        updateSetting('privacy', FILE_EMERGENCE_SETTING_KEY, result.data !== 'false')
      }
      const autoNarrationResult = window.electronAPI.settings.getAgentAutoNarrationContinuation
        ? await window.electronAPI.settings.getAgentAutoNarrationContinuation()
        : await window.electronAPI.settings.get(AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY)
      if (cancelled) return
      if (autoNarrationResult?.success) {
        updateSetting(
          'agent',
          AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY,
          typeof autoNarrationResult.data === 'boolean'
            ? autoNarrationResult.data
            : autoNarrationResult.data !== 'false',
        )
      }
    })()
    return () => { cancelled = true }
  }, [])

  const updateSetting = (sectionId: string, settingId: string, value: boolean | string) => {
    setSettings((current) => current.map(section =>
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

  const handleToggleSetting = async (sectionId: string, setting: SettingItem) => {
    const nextValue = !setting.value
    if (
      setting.id !== FILE_EMERGENCE_SETTING_KEY &&
      setting.id !== AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY
    ) {
      updateSetting(sectionId, setting.id, nextValue)
      return
    }
    if (typeof window === 'undefined' || !window.electronAPI?.settings?.set) {
      setSettingErrors((prev) => ({ ...prev, [setting.id]: '设置 IPC 不可用' }))
      return
    }
    const result = setting.id === AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY && window.electronAPI.settings.setAgentAutoNarrationContinuation
      ? await window.electronAPI.settings.setAgentAutoNarrationContinuation(nextValue)
      : await window.electronAPI.settings.set(setting.id, nextValue ? 'true' : 'false')
    if (result.success) {
      setSettingErrors((prev) => {
        const next = { ...prev }
        delete next[setting.id]
        return next
      })
      updateSetting(sectionId, setting.id, nextValue)
    } else {
      setSettingErrors((prev) => ({ ...prev, [setting.id]: result.error || '设置保存失败' }))
    }
  }

  const getSettingControlWidth = (setting: SettingItem): number | undefined => {
    if (!setting.slotWidth) return undefined
    return SETTING_SLOT_WIDTHS[setting.slotWidth]
  }

  const isDynamicSection = currentSection
    ? ['ai', 'remote-im', 'external-services', 'mcp', 'memory', 'personalities', 'user-profiles', 'pet', 'rss-storage', MODELS_RUNTIME_SETTINGS_SECTION, 'storage'].includes(currentSection.id)
    : false

  return (
    <div className="settings-page-shell flex h-full flex-col overflow-hidden">
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
          onMouseMove={handleSettingsSurfaceMotion}
          onScroll={handleSettingsSurfaceScroll}
          onMouseLeave={scheduleSettingsSurfaceRefresh}
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
                Ready v0.1.0 · Electron 42
              </span>
            </div>
          </div>
        </div>

        {/* Settings Content Panel */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div
            key={currentSection?.id || 'unknown'}
            data-liquid-shell="settings-content"
            className="h-full overflow-auto"
          >
          <div
            className="w-full mx-auto"
            style={{
              maxWidth: isAiSection ? 1220 : 1040,
              padding: isAiSection ? '34px 46px 72px' : '30px 34px 64px',
            }}
          >
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
                          onClick={() => { void handleToggleSetting(currentSection.id, setting) }}
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
                      {settingErrors[setting.id] && (
                        <div className="ml-3 text-[11px]" style={{ color: 'var(--color-red, #d44)' }}>
                          {settingErrors[setting.id]}
                        </div>
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
