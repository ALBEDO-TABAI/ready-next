import { useState, useEffect, useCallback, type ReactNode } from 'react'
import {
  ChevronLeft, User, Bell, Shield, Database,
  Palette, Keyboard, Globe, Info, Moon, Sun, Bot, Monitor, Droplets,
  ChevronRight, ExternalLink, HardDrive, Trash2, CheckCircle2, XCircle, Loader2, MessageSquare, Brain, Users, Sparkles
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme, type ThemeSkin } from '../stores/useTheme'
import { resolveAIConfigCapabilities } from '../../shared/ai-providers'
import type { CapabilityRuntimeSnapshot } from '../../shared/ai-capability-runtime'
import { listSettingsCapabilityGroups, type CapabilityGroupId } from '../../shared/ai-capability-groups'
import { useSettings, AI_PROVIDERS, getProviderDef } from '../stores/useSettings'
import type { AIProviderType } from '../stores/useSettings'
import RemoteIMSettingsPanel from '../components/settings/RemoteIMSettingsPanel'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_READONLY_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
  settingsListItemStyle,
} from '../components/settings/settings-theme'
import { MemoryListPanel, TriggerManager, MemoryStatsCard, MemoryCreator } from '../components/memory'
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
    id: 'memory',
    title: '记忆系统',
    icon: Brain,
    description: '管理 Agent 的记忆和触发器',
    settings: [] // Rendered dynamically via Memory components
  },
  {
    id: 'personalities',
    title: 'Agent 人格',
    icon: Sparkles,
    description: '定义每个 Agent 的人格和行为特征',
    settings: [] // Rendered dynamically via PersonalityEditor
  },
  {
    id: 'user-profiles',
    title: '用户档案',
    icon: Users,
    description: '管理用户偏好和个性化设置',
    settings: [] // Rendered dynamically via UserProfileEditor
  },
  {
    id: 'rss-storage',
    title: 'RSS 底稿',
    icon: HardDrive,
    description: '管理 RSS 底稿仓库、增量收件箱和刷新重置',
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
    settings: [
      { id: 'cacheSize', label: '缓存大小', description: '当前缓存占用空间', type: 'readonly', value: '256 MB', slotWidth: 'short' },
      { id: 'clearCache', label: '清除缓存', description: '清除浏览器和文件预览缓存', type: 'button', buttonLabel: '清除', buttonVariant: 'danger', slotWidth: 'short' }
    ]
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
  { value: 'liquid-glass', label: 'Liquid Glass', icon: Droplets, description: '高质感玻璃化层叠界面' },
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
      className={`glass-surface-card rounded-2xl border ${wide ? 'md:col-span-2' : ''}`}
      style={{
        ...SETTINGS_CARD_STYLE,
        padding: '14px 16px',
      }}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>{title}</div>
        <div className="text-[11px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>{description}</div>
      </div>
      <div className="mt-3 min-w-0">{control}</div>
    </div>
  )
}

function AISettingsCapabilityChip({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'positive' | 'muted'
}) {
  const color = tone === 'positive'
    ? 'var(--color-green)'
    : tone === 'muted'
      ? 'var(--text-muted)'
      : 'var(--color-blue)'

  return (
    <div
      className="glass-surface-floating flex items-center gap-2 rounded-full border"
      style={{
        padding: '6px 10px',
        borderColor: 'color-mix(in srgb, var(--lg-border-soft) 88%, transparent)',
        background: 'color-mix(in srgb, var(--surface-floating-bg) 74%, transparent)',
      }}
    >
      <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-light)' }}>{label}</span>
      <span className="text-[11px] font-semibold" style={{ color }}>{value}</span>
    </div>
  )
}

function AISettingsInfoChip({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div
      className="glass-surface-floating rounded-xl border"
      style={{
        padding: '10px 12px',
        borderColor: 'color-mix(in srgb, var(--lg-border-soft) 88%, transparent)',
        background: 'color-mix(in srgb, var(--surface-floating-bg) 78%, transparent)',
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-light)' }}>{label}</div>
      <div className="mt-1 text-[12px] font-medium leading-5" style={{ color: 'var(--text-body)' }}>{value}</div>
    </div>
  )
}

// ── AI Settings Panel (dynamic, wired to backend) ──────────────────────────
function AISettingsPanel() {
  const {
    config, loaded, testStatus, testMessage, testLatency,
    loadConfig, updateField, updateCapabilityMode, switchProvider, testConnection,
    savedConfigs,
  } = useSettings()

  const [showKey, setShowKey] = useState(false)
  const [customModel, setCustomModel] = useState('')
  const [remoteChannelsEnabled, setRemoteChannelsEnabled] = useState(true)
  const [sidecarAutostart, setSidecarAutostart] = useState(true)
  const [sidecarHost, setSidecarHost] = useState('127.0.0.1')
  const [sidecarPort, setSidecarPort] = useState('auto')
  const [messageCoalesceEnabled, setMessageCoalesceEnabled] = useState(true)
  const [messageCoalesceWindowMs, setMessageCoalesceWindowMs] = useState('1200')
  const [runtimeSummary, setRuntimeSummary] = useState<{
    sidecarStatus?: string
    sidecarPort?: number
    channelCount?: number
    scheduleCount?: number
    activeTasks?: number
    feishuConnected?: boolean
  } | null>(null)
  const [capabilityRuntimeSnapshot, setCapabilityRuntimeSnapshot] = useState<CapabilityRuntimeSnapshot | null>(null)

  const persistBridgeSetting = useCallback((key: string, value: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    void window.electronAPI.settings.set(key, value)
  }, [])

  const refreshRuntimeSummary = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    const result = await window.electronAPI.agent.getRuntimeStatus()
    if (!result.success || !result.data) return
    setRuntimeSummary({
      sidecarStatus: result.data.sidecar.status,
      sidecarPort: result.data.sidecar.port,
      channelCount: result.data.channels.total,
      scheduleCount: result.data.schedules.total,
      activeTasks: result.data.heartbeat.orchestrator.activeTasks,
      feishuConnected: Array.isArray(result.data.heartbeat.adapters)
        ? result.data.heartbeat.adapters.some((adapter) => adapter.type === 'feishu-app' && adapter.healthy)
        : false,
    })
  }, [])

  const refreshCapabilityRuntimeSnapshot = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    const result = await window.electronAPI.agent.getCapabilityRuntimeSnapshot(config)
    if (!result.success || !result.data) return
    setCapabilityRuntimeSnapshot(result.data)
  }, [config])

  useEffect(() => {
    if (!loaded) loadConfig()
  }, [loaded, loadConfig])

  useEffect(() => {
    let cancelled = false
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return

    ;(async () => {
      const keys = [
        'remote_channels_enabled',
        'sidecar_autostart',
        'sidecar_bind_host',
        'sidecar_bind_port',
        'agent_message_coalesce_enabled',
        'agent_message_coalesce_window_ms',
      ] as const
      const results = await Promise.all(keys.map((key) => window.electronAPI.settings.get(key)))
      if (cancelled) return

      const [enabledRes, autostartRes, hostRes, portRes, coalesceEnabledRes, coalesceWindowRes] = results
      if (enabledRes.success && enabledRes.data) setRemoteChannelsEnabled(enabledRes.data !== 'false')
      if (autostartRes.success && autostartRes.data) setSidecarAutostart(autostartRes.data !== 'false')
      if (hostRes.success && hostRes.data) setSidecarHost(hostRes.data)
      if (portRes.success && portRes.data) setSidecarPort(portRes.data)
      if (coalesceEnabledRes.success && coalesceEnabledRes.data) setMessageCoalesceEnabled(coalesceEnabledRes.data !== 'false')
      if (coalesceWindowRes.success && coalesceWindowRes.data) setMessageCoalesceWindowMs(coalesceWindowRes.data)
      await refreshRuntimeSummary()
      await refreshCapabilityRuntimeSnapshot()
    })()

    return () => { cancelled = true }
  }, [refreshCapabilityRuntimeSnapshot, refreshRuntimeSummary])

  useEffect(() => {
    void refreshCapabilityRuntimeSnapshot()
  }, [refreshCapabilityRuntimeSnapshot])

  const currentProvider = getProviderDef(config.provider)
  const capabilities = resolveAIConfigCapabilities(config)
  const models = currentProvider?.models || []
  const isCustomProvider = config.provider === 'openai-compatible'
  const showReasoningEffort = capabilities?.agentProtocol === 'openai' && capabilities?.wireApi === 'responses'
  const resolvedAgentInterfaceLabel = capabilities?.agentProtocol === 'anthropic'
    ? 'Anthropic /v1/messages'
    : capabilities?.wireApi === 'responses'
      ? 'OpenAI /responses'
      : 'OpenAI /chat/completions'
  const compactInputStyle = {
    ...SETTINGS_INPUT_STYLE,
    padding: '6px 12px',
  }
  const compactSelectStyle = {
    ...SETTINGS_INPUT_STYLE,
    padding: '6px 28px 6px 12px',
  }
  const stackedInputStyle = {
    ...compactInputStyle,
    width: '100%',
    textAlign: 'left' as const,
  }
  const stackedSelectStyle = {
    ...compactSelectStyle,
    width: '100%',
  }
  const toolTransportLabel = capabilities?.toolCallTransport === 'text'
    ? '文本桥接'
    : capabilities?.toolCallTransport === 'native'
      ? '原生'
      : '关闭'
  const capabilityGroups = listSettingsCapabilityGroups()

  const getCapabilityModeValue = useCallback((groupId: CapabilityGroupId): 'auto' | 'on' | 'off' => {
    const current = config.capabilityModes?.[groupId]
    return current === 'on' || current === 'off' || current === 'auto' ? current : 'auto'
  }, [config.capabilityModes])

  const resolveCapabilityRuntimeDisplay = useCallback((groupId: CapabilityGroupId) => {
    const snapshot = capabilityRuntimeSnapshot?.groups[groupId]
    if (!snapshot) {
      return { label: '读取中', tone: 'muted' as const }
    }
    if (snapshot.status === 'inactive') {
      return { label: '保留占位', tone: 'muted' as const }
    }
    if (snapshot.status === 'host_only') {
      return { label: '宿主内部', tone: 'muted' as const }
    }
    if (snapshot.status === 'environment_unavailable') {
      return { label: '因环境不可用而关闭', tone: 'muted' as const }
    }
    if (snapshot.status === 'run_intent_suppressed') {
      return { label: '因本轮任务抑制', tone: 'muted' as const }
    }
    if (snapshot.status === 'closed') {
      if (snapshot.reason === 'provider_disabled_tools') {
        return { label: '因接口能力关闭', tone: 'muted' as const }
      }
      if (snapshot.reason === 'disabled_by_config') {
        return { label: '已关闭', tone: 'muted' as const }
      }
      return { label: '当前场景未启用', tone: 'muted' as const }
    }
    return {
      label: snapshot.mode === 'on' ? '已启用' : '自动启用',
      tone: 'positive' as const,
    }
  }, [capabilityRuntimeSnapshot])

  return (
    <div className="flex flex-col gap-6">
      {/* Provider Quick Select */}
      <div>
        <h4
          className="text-[11px] font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-light)' }}
        >
          API 提供商
        </h4>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          {AI_PROVIDERS.map((p) => {
            const isActive = config.provider === p.id
            const hasSaved = !!(savedConfigs[p.id as AIProviderType]?.apiKey)
            return (
              <button
                key={p.id}
                onClick={() => switchProvider(p.id as AIProviderType)}
                className="glass-surface-card flex items-center gap-2 rounded-xl border transition-all duration-200 text-left relative"
                style={{
                  padding: '9px 11px',
                  ...(isActive ? {
                    borderColor: 'color-mix(in srgb, var(--color-blue) 34%, var(--lg-border-soft) 66%)',
                    background: 'color-mix(in srgb, var(--color-blue-light) 74%, var(--surface-card-bg) 26%)',
                    boxShadow: 'var(--lg-shadow-contact), inset 0 0 0 1px color-mix(in srgb, var(--color-blue) 20%, transparent)',
                  } : SETTINGS_CARD_STYLE),
                }}
              >
                {hasSaved && !isActive && (
                  <span
                    className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
                    style={{ background: 'var(--color-green, #22c55e)' }}
                    title="已配置"
                  />
                )}
                <span className="text-[16px]">{p.icon}</span>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12px] font-medium truncate"
                    style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-title)' }}
                  >
                    {p.label.split('(')[0].trim()}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--text-light)' }}>
                    {p.labelEn}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div
        className="glass-surface-card rounded-2xl border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '14px 16px',
        }}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-light)' }}>
          当前兼容状态
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <AISettingsCapabilityChip label="接口" value={resolvedAgentInterfaceLabel} />
          <AISettingsCapabilityChip label="工具传输" value={toolTransportLabel} tone={capabilities?.supportsToolCalls ? 'positive' : 'muted'} />
          <AISettingsCapabilityChip label="工具调用" value={capabilities?.supportsToolCalls ? '开启' : '关闭'} tone={capabilities?.supportsToolCalls ? 'positive' : 'muted'} />
          <AISettingsCapabilityChip label="网页视觉" value={capabilities?.supportsVision ? '开启' : '关闭'} tone={capabilities?.supportsVision ? 'positive' : 'muted'} />
        </div>
      </div>

      <div
        className="glass-surface-card rounded-2xl border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '14px 16px',
        }}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-light)' }}>
          能力分组
        </div>
        <div className="text-[11px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
          控制哪些业务能力默认暴露给模型；当前状态会显示是已启用，还是因环境不可用而关闭。
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {capabilityGroups.map((group) => {
            const runtimeDisplay = resolveCapabilityRuntimeDisplay(group.id)
            return (
              <div
                key={group.id}
                className="glass-surface-card rounded-xl border"
                style={{
                  ...SETTINGS_SUBTLE_CARD_STYLE,
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
                    onChange={(e) => updateCapabilityMode(group.id, e.target.value as 'auto' | 'on' | 'off')}
                    className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
                    style={{
                      ...compactSelectStyle,
                      width: 112,
                    }}
                  >
                    <option value="auto">自动</option>
                    <option value="on">开启</option>
                    <option value="off">关闭</option>
                  </select>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-light)' }}>当前状态</span>
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

      <div className="grid gap-3 md:grid-cols-2">
        <AISettingsFieldCard
          wide
          title="API 地址"
          description={currentProvider?.helpUrl ? (
            <>
              服务端点 URL，<a href={currentProvider.helpUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>查看文档</a>
            </>
          ) : '服务端点 URL'}
          control={(
            <input
              type="text"
              value={config.baseUrl}
              onChange={(e) => updateField('baseUrl', e.target.value)}
              placeholder={currentProvider?.baseUrl || 'https://...'}
              className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all"
              style={stackedInputStyle}
            />
          )}
        />

        <AISettingsFieldCard
          wide
          title="API Key"
          description={currentProvider?.apiKeyPlaceholder || 'sk-...'}
          control={(
            <div className="flex items-center gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={config.apiKey}
                onChange={(e) => updateField('apiKey', e.target.value)}
                placeholder={currentProvider?.apiKeyPlaceholder || 'sk-...'}
                className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all font-mono min-w-0 flex-1"
                style={stackedInputStyle}
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="text-[11px] px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          )}
        />

        <AISettingsFieldCard
          title="配置名称"
          description="聊天面板里显示的别名，可选。"
          control={(
            <input
              type="text"
              value={config.displayName || ''}
              onChange={(e) => updateField('displayName', e.target.value)}
              placeholder="自适应配置"
              className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all"
              style={stackedInputStyle}
            />
          )}
        />

        {config.provider === 'volcengine' && (
          <AISettingsFieldCard
            title="推理接入点 ID"
            description="火山方舟控制台生成的 ep-xxx。"
            control={(
              <input
                type="text"
                value={config.endpointId || ''}
                onChange={(e) => updateField('endpointId', e.target.value)}
                placeholder="ep-20250101xxxxx"
                className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all font-mono"
                style={stackedInputStyle}
              />
            )}
          />
        )}

        <AISettingsFieldCard
          title="默认模型"
          description={models.find(m => m.id === config.model)?.description || '对话默认使用的模型。'}
          control={isCustomProvider || config.model === '__custom__' || (!models.some(m => m.id === config.model) && config.model !== '') ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={config.model === '__custom__' ? (customModel || '') : (customModel || config.model)}
                onChange={(e) => {
                  setCustomModel(e.target.value)
                  updateField('model', e.target.value)
                }}
                placeholder="模型 ID，如 kimi-for-coding"
                className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all font-mono min-w-0 flex-1"
                style={stackedInputStyle}
              />
              {!isCustomProvider && (
                <button
                  onClick={() => {
                    setCustomModel('')
                    updateField('model', models[0]?.id || '')
                  }}
                  className="text-[11px] px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors shrink-0"
                  style={{ color: 'var(--text-muted)' }}
                >
                  选列表
                </button>
              )}
            </div>
          ) : (
            <select
              value={config.model}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  setCustomModel('')
                  updateField('model', '__custom__')
                } else {
                  updateField('model', e.target.value)
                }
              }}
              className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
              style={stackedSelectStyle}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}K)` : ''}
                </option>
              ))}
            </select>
          )}
        />

        <AISettingsFieldCard
          title="Agent 接口"
          description={`当前解析为 ${resolvedAgentInterfaceLabel}。`}
          control={(
            <select
              value={config.agentProtocol || 'auto'}
              onChange={(e) => updateField('agentProtocol', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.agentProtocol)}
              className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
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
            description={(
              <>
                在 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/chat/completions</code> 和 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/responses</code> 之间切换。
              </>
            )}
            control={(
              <select
                value={config.wireApi || 'auto'}
                onChange={(e) => updateField('wireApi', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.wireApi)}
                className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
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
              value={config.toolUseMode || 'auto'}
              onChange={(e) => updateField('toolUseMode', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.toolUseMode)}
              className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
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
              value={config.visionMode || 'auto'}
              onChange={(e) => updateField('visionMode', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.visionMode)}
              className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
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
                value={config.reasoningEffort || 'high'}
                onChange={(e) => updateField('reasoningEffort', e.target.value as typeof config.reasoningEffort)}
                className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
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

        <AISettingsFieldCard
          wide
          title="测试连接"
          description="验证当前地址、密钥和模型是否能通。"
          control={(
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] flex items-center gap-1.5 min-w-0" style={{ color: testStatus === 'success' ? 'var(--color-green)' : testStatus === 'error' ? 'var(--color-red)' : 'var(--text-light)' }}>
                {testStatus === 'testing' && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
                {testStatus === 'success' && <CheckCircle2 className="w-3 h-3 shrink-0" />}
                {testStatus === 'error' && <XCircle className="w-3 h-3 shrink-0" />}
                <span className="truncate">{testMessage || '验证 API 配置是否有效'}</span>
                {typeof testLatency === 'number' && testStatus === 'success' && (
                  <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>{testLatency} ms</span>
                )}
              </div>
              <button
                onClick={() => testConnection()}
                disabled={testStatus === 'testing'}
                className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-all hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                style={{
                  ...SETTINGS_PRIMARY_BUTTON_STYLE,
                  padding: '7px 16px',
                }}
              >
                {testStatus === 'testing' ? '测试中...' : '测试'}
              </button>
            </div>
          )}
        />
      </div>

      {/* Message Coalescing */}
      <div
        className="glass-surface-card rounded-2xl border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '14px 16px',
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>对话发送</div>
          <div className="text-[11px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            当用户在很短时间内连续发送多条消息时，先合并再统一交给 Agent，减少逐次等待。
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(180px,0.8fr)]">
          <label className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2" style={SETTINGS_SUBTLE_CARD_STYLE}>
            <span className="text-[12px]" style={{ color: 'var(--text-body)' }}>启用连续消息合并</span>
            <input
              type="checkbox"
              checked={messageCoalesceEnabled}
              onChange={(e) => {
                const next = e.target.checked
                setMessageCoalesceEnabled(next)
                persistBridgeSetting('agent_message_coalesce_enabled', String(next))
              }}
            />
          </label>
          <label className="rounded-xl border px-3 py-2" style={SETTINGS_SUBTLE_CARD_STYLE}>
            <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-light)' }}>合并窗口</div>
            <select
              value={messageCoalesceWindowMs}
              onChange={(e) => {
                setMessageCoalesceWindowMs(e.target.value)
                persistBridgeSetting('agent_message_coalesce_window_ms', e.target.value)
              }}
              className="mt-1 w-full bg-transparent text-[12px] outline-none cursor-pointer"
              style={{ color: 'var(--text-body)' }}
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

      {/* Agent Runtime */}
      <div
        className="glass-surface-card rounded-2xl border overflow-hidden"
        style={SETTINGS_CARD_STYLE}
      >
        <div className="flex items-center justify-between gap-3" style={{ padding: '12px 16px', borderBottom: '1px solid color-mix(in srgb, var(--lg-border-soft) 88%, transparent)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>Agent Runtime</div>
            <div className="text-[11px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
              Claude SDK 单核编排，Python sidecar 提供 Channels / Heartbeat / cron
            </div>
          </div>
          <button
            className="rounded-lg border text-[12px] hover:bg-[var(--bg-hover)] transition-colors"
            style={{
              ...SETTINGS_SECONDARY_BUTTON_STYLE,
              padding: '6px 10px',
            }}
            onClick={() => {
              void refreshRuntimeSummary()
            }}
          >
            刷新状态
          </button>
        </div>
        <div className="grid gap-2 md:grid-cols-2" style={{ padding: '12px 16px', borderBottom: '1px solid color-mix(in srgb, var(--lg-border-soft) 88%, transparent)' }}>
          <label className="glass-surface-card flex items-center justify-between gap-3 rounded-xl border px-3 py-2" style={SETTINGS_SUBTLE_CARD_STYLE}>
            <span className="text-[12px]" style={{ color: 'var(--text-body)' }}>启用远程 Channels</span>
            <input
              type="checkbox"
              checked={remoteChannelsEnabled}
              onChange={(e) => {
                const next = e.target.checked
                setRemoteChannelsEnabled(next)
                persistBridgeSetting('remote_channels_enabled', String(next))
              }}
            />
          </label>
          <label className="glass-surface-card flex items-center justify-between gap-3 rounded-xl border px-3 py-2" style={SETTINGS_SUBTLE_CARD_STYLE}>
            <span className="text-[12px]" style={{ color: 'var(--text-body)' }}>启动时自动拉起 Sidecar</span>
            <input
              type="checkbox"
              checked={sidecarAutostart}
              onChange={(e) => {
                const next = e.target.checked
                setSidecarAutostart(next)
                persistBridgeSetting('sidecar_autostart', String(next))
              }}
            />
          </label>
        </div>
        <div className="grid gap-2 md:grid-cols-2" style={{ padding: '12px 16px', borderBottom: '1px solid color-mix(in srgb, var(--lg-border-soft) 88%, transparent)' }}>
          <div className="glass-surface-card rounded-xl border px-3 py-2" style={SETTINGS_SUBTLE_CARD_STYLE}>
            <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-light)' }}>Bind Host</div>
            <input
              type="text"
              value={sidecarHost}
              onChange={(e) => setSidecarHost(e.target.value)}
              onBlur={() => persistBridgeSetting('sidecar_bind_host', sidecarHost)}
              className="mt-1 w-full bg-transparent text-[12px] outline-none"
              style={{ color: 'var(--text-body)' }}
            />
          </div>
          <div className="glass-surface-card rounded-xl border px-3 py-2" style={SETTINGS_SUBTLE_CARD_STYLE}>
            <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-light)' }}>Bind Port</div>
            <input
              type="text"
              value={sidecarPort}
              onChange={(e) => setSidecarPort(e.target.value)}
              onBlur={() => persistBridgeSetting('sidecar_bind_port', sidecarPort)}
              className="mt-1 w-full bg-transparent text-[12px] outline-none"
              style={{ color: 'var(--text-body)' }}
            />
          </div>
        </div>
        <div style={{ padding: '12px 16px' }}>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            <AISettingsInfoChip
              label="编排内核"
              value={<span style={{ color: 'var(--color-blue)' }}>Claude SDK</span>}
            />
            <AISettingsInfoChip
              label="Sidecar"
              value={`${runtimeSummary?.sidecarStatus || 'unknown'}${runtimeSummary?.sidecarPort ? ` · ${runtimeSummary.sidecarPort}` : ''}`}
            />
            <AISettingsInfoChip
              label="Channels / Schedules"
              value={`${runtimeSummary?.channelCount ?? 0} / ${runtimeSummary?.scheduleCount ?? 0}`}
            />
            <AISettingsInfoChip
              label="活跃任务"
              value={String(runtimeSummary?.activeTasks ?? 0)}
            />
          </div>
        </div>
      </div>

      {/* Provider Notes */}
      {currentProvider && (
        <div
          className="text-[11px] leading-relaxed"
          style={{ padding: '2px 0 0', color: 'var(--text-light)' }}
        >
          {config.provider === 'anthropic' && (
            <>注意：Anthropic API 使用 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>x-api-key</code> 认证头（非 Bearer），且 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>max_tokens</code> 为必填字段。系统已自动处理。</>
          )}
          {config.provider === 'gemini' && (
            <>Gemini API 已使用 OpenAI 兼容层 (<code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/v1beta/openai/</code>)，API Key 在 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>Google AI Studio</a> 获取。</>
          )}
          {config.provider === 'volcengine' && (
            <>火山方舟需要先在<a href="https://console.volcengine.com/ark" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>控制台</a>创建推理接入点，获取 ep-xxx 格式的 Endpoint ID。Seedance/Seedream 为异步任务模式。</>
          )}
          {config.provider === 'moonshot' && (
            <>Moonshot API 完全兼容 OpenAI SDK，在<a href="https://platform.moonshot.cn/console" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>月之暗面控制台</a>获取 API Key。支持最多 128K 上下文和文件上传。</>
          )}
          {config.provider === 'openai' && (
            <>在 <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>OpenAI Dashboard</a> 获取 API Key。推理模型 (o1/o3) 不支持 temperature 参数，系统已自动处理。</>
          )}
          {config.provider === 'fox' && (
            <>FoxCode / NewCLI Codex 使用 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/responses</code> 接口，并通过 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>Authorization: Bearer ...</code> 认证。默认地址为 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>https://code.newcli.com/codex/v1</code>。若切换其它供应商，可在上方把 Agent 接口、OpenAI API 形式与工具调用能力调成对应模式。</>
          )}
          {config.provider === 'openai-compatible' && (
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
            className="flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-all hover:brightness-95 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
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
                  className="flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-all hover:brightness-95 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
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

interface SettingsPageProps {
  initialSection?: string
}

export default function Settings({ initialSection }: SettingsPageProps = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const routeSection = new URLSearchParams(location.search).get('section') || undefined
  const [activeSection, setActiveSection] = useState(initialSection || routeSection || 'account')
  const [settings, setSettings] = useState(settingsData)
  const { theme, setTheme, skin, setSkin } = useTheme()

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
    ? ['ai', 'remote-im', 'memory', 'personalities', 'user-profiles', 'rss-storage'].includes(currentSection.id)
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
                  className="flex items-center gap-3 rounded-[18px] transition-all duration-200 text-left group"
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
                    <div className="mb-7" style={{ padding: '4px 0 0' }}>
                      <h2 className="text-[22px] font-semibold leading-7 tracking-[-0.01em]" style={{ color: 'var(--text-title)' }}>
                        {currentSection.title}
                      </h2>
                      <p className="mt-1 text-[13px] leading-6" style={{ color: 'var(--text-muted)', maxWidth: 720 }}>
                        {currentSection.description}
                      </p>
                    </div>

                {/* AI Settings Panel — dynamic, wired to backend */}
                {currentSection.id === 'ai' && <AISettingsPanel />}
                {currentSection.id === 'rss-storage' && <RSSDraftStoreSettingsPanel />}
                {currentSection.id === 'remote-im' && <RemoteIMSettingsPanel />}
                {currentSection.id === 'memory' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 360px) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
                        <MemoryStatsCard />
                        <MemoryCreator />
                      </div>
                      <div style={{ minHeight: 500 }}>
                        <MemoryListPanel />
                      </div>
                    </div>
                    <div style={{ minHeight: 400 }}>
                      <TriggerManager />
                    </div>
                  </div>
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
                    <div className="mb-8">
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
                              className="glass-surface-card flex-1 flex flex-col items-center gap-2.5 rounded-[24px] border transition-all duration-200"
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

                    <div className="mb-8">
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
                              className="glass-surface-card flex items-center gap-3 rounded-[24px] border text-left transition-all duration-200"
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
                            className="absolute bg-white rounded-full shadow-sm transition-all duration-200"
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
                          value={setting.value as string}
                          onChange={(e) => updateSetting(currentSection.id, setting.id, e.target.value)}
                          className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
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
                          className="flex-shrink-0 rounded-lg border text-[12px] text-right focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all"
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
                          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-all hover:brightness-95 active:scale-[0.98]"
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
