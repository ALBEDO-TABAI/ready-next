import { useState, useEffect, useCallback } from 'react'
import {
  ChevronLeft, User, Bell, Shield, Database,
  Palette, Keyboard, Globe, Info, Moon, Sun, Bot, Monitor, Droplets, Layers,
  ChevronRight, ExternalLink, HardDrive, Trash2, CheckCircle2, XCircle, Loader2, MessageSquare
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTheme, type ThemeSkin } from '../stores/useTheme'
import { resolveAIConfigCapabilities } from '../../shared/ai-providers'
import { useSettings, AI_PROVIDERS, getProviderDef } from '../stores/useSettings'
import type { AIProviderType } from '../stores/useSettings'
import RemoteIMSettingsPanel from '../components/settings/RemoteIMSettingsPanel'

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
      { id: 'cacheSize', label: '缓存大小', description: '当前缓存占用空间', type: 'readonly', value: '256 MB' },
      { id: 'clearCache', label: '清除缓存', description: '清除浏览器和文件预览缓存', type: 'button', buttonLabel: '清除', buttonVariant: 'danger' }
    ]
  },
  {
    id: 'shortcuts',
    title: '快捷键',
    icon: Keyboard,
    description: '查看和自定义键盘快捷键',
    settings: [
      { id: 'newTask', label: '新建任务', type: 'readonly', value: '⌘ N' },
      { id: 'sendMessage', label: '发送消息', type: 'readonly', value: '⌘ Enter' },
      { id: 'search', label: '全局搜索', type: 'readonly', value: '⌘ K' },
      { id: 'toggleSidebar', label: '切换侧边栏', type: 'readonly', value: '⌘ B' },
      { id: 'switchMode', label: '切换模式', type: 'readonly', value: '⌘ 1-6' }
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
      { id: 'version', label: '当前版本', type: 'readonly', value: 'Ready v0.1.0' },
      { id: 'checkUpdate', label: '检查更新', description: '查看是否有新版本可用', type: 'button', buttonLabel: '检查更新', buttonVariant: 'primary' }
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
  { value: 'classic', label: '经典', icon: Layers, description: '稳定、清晰的经典界面' },
  { value: 'liquid-glass', label: 'Liquid Glass', icon: Droplets, description: '高质感玻璃化层叠界面' },
]

// ── AI Settings Panel (dynamic, wired to backend) ──────────────────────────
function AISettingsPanel() {
  const {
    config, loaded, testStatus, testMessage, testLatency,
    loadConfig, updateField, switchProvider, testConnection,
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
  } | null>(null)

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
    })
  }, [])

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
    })()

    return () => { cancelled = true }
  }, [refreshRuntimeSummary])

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
        <div className="grid grid-cols-3 gap-2">
          {AI_PROVIDERS.map((p) => {
            const isActive = config.provider === p.id
            const hasSaved = !!(savedConfigs[p.id as AIProviderType]?.apiKey)
            return (
              <button
                key={p.id}
                onClick={() => switchProvider(p.id as AIProviderType)}
                className="flex items-center gap-2 rounded-xl border-2 transition-all duration-200 text-left relative"
                style={{
                  padding: '10px 12px',
                  borderColor: isActive ? 'var(--color-blue)' : 'var(--border-default)',
                  background: isActive ? 'var(--color-blue-light)' : 'var(--bg-primary)',
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

      {/* Config Form */}
      <div
        className="rounded-2xl border overflow-hidden"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)' }}
      >
        {/* API Base URL */}
        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>API 地址</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              {currentProvider?.helpUrl ? (
                <a href={currentProvider.helpUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--color-blue)' }}>
                  查看文档
                </a>
              ) : '服务端点 URL'}
            </div>
          </div>
          <input
            type="text"
            value={config.baseUrl}
            onChange={(e) => updateField('baseUrl', e.target.value)}
            placeholder={currentProvider?.baseUrl || 'https://...'}
            className="flex-shrink-0 rounded-lg border text-[12px] text-right focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all"
            style={{
              padding: '6px 12px', width: 280,
              borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
            }}
          />
        </div>

        {/* API Key */}
        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>API Key</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              {currentProvider?.apiKeyPlaceholder || 'sk-...'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={config.apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              placeholder={currentProvider?.apiKeyPlaceholder || 'sk-...'}
              className="flex-shrink-0 rounded-lg border text-[12px] text-right focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all font-mono"
              style={{
                padding: '6px 12px', width: 240,
                borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
              }}
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="text-[11px] px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
        </div>

        {/* Volcano Engine Endpoint ID */}
        {config.provider === 'volcengine' && (
          <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
            <div className="flex-1 min-w-0 mr-4">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>推理接入点 ID</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
                在火山方舟控制台创建的 ep-xxx ID
              </div>
            </div>
            <input
              type="text"
              value={config.endpointId || ''}
              onChange={(e) => updateField('endpointId', e.target.value)}
              placeholder="ep-20250101xxxxx"
              className="flex-shrink-0 rounded-lg border text-[12px] text-right focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all font-mono"
              style={{
                padding: '6px 12px', width: 220,
                borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
              }}
            />
          </div>
        )}

        {/* Model Select */}
        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>默认模型</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              {models.find(m => m.id === config.model)?.description || '对话使用的模型'}
            </div>
          </div>
          {isCustomProvider || config.model === '__custom__' || (!models.some(m => m.id === config.model) && config.model !== '') ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={config.model === '__custom__' ? (customModel || '') : (customModel || config.model)}
                onChange={(e) => {
                  setCustomModel(e.target.value)
                  updateField('model', e.target.value)
                }}
                placeholder="模型 ID，如 kimi-for-coding"
                className="flex-shrink-0 rounded-lg border text-[12px] text-right focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all font-mono"
                style={{
                  padding: '6px 12px', width: 180,
                  borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
                }}
              />
              {!isCustomProvider && (
                <button
                  onClick={() => {
                    setCustomModel('')
                    updateField('model', models[0]?.id || '')
                  }}
                  className="text-[11px] px-2 py-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors"
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
              className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
              style={{
                padding: '6px 28px 6px 12px',
                borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
              }}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}K)` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>Agent 接口</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              切换供应商后，可在这里指定 Agent 对话接口。当前解析为 {resolvedAgentInterfaceLabel}
            </div>
          </div>
          <select
            value={config.agentProtocol || 'auto'}
            onChange={(e) => updateField('agentProtocol', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.agentProtocol)}
            className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
            style={{
              padding: '6px 28px 6px 12px',
              borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
            }}
          >
            <option value="auto">自动</option>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic 兼容</option>
          </select>
        </div>

        {capabilities?.agentProtocol === 'openai' && (
          <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
            <div className="flex-1 min-w-0 mr-4">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>OpenAI API 形式</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
                对 OpenAI 风格供应商，可选 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/chat/completions</code> 或 <code className="font-mono text-[10px]" style={{ background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 4 }}>/responses</code>
              </div>
            </div>
            <select
              value={config.wireApi || 'auto'}
              onChange={(e) => updateField('wireApi', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.wireApi)}
              className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
              style={{
                padding: '6px 28px 6px 12px',
                borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
              }}
            >
              <option value="auto">自动</option>
              <option value="chat/completions">chat/completions</option>
              <option value="responses">responses</option>
            </select>
          </div>
        )}

        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>工具调用</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              控制 Agent 是否尽可能调用浏览器 / 文档 / 技能工具。当前为 {capabilities?.supportsToolCalls ? '开启' : '关闭'}
            </div>
          </div>
          <select
            value={config.toolUseMode || 'auto'}
            onChange={(e) => updateField('toolUseMode', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.toolUseMode)}
            className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
            style={{
              padding: '6px 28px 6px 12px',
              borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
            }}
          >
            <option value="auto">自动</option>
            <option value="on">强制开启</option>
            <option value="off">关闭</option>
          </select>
        </div>

        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>网页视觉</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              浏览器自动化里定位输入框、发送按钮等时会使用视觉分析。当前为 {capabilities?.supportsVision ? '开启' : '关闭'}
            </div>
          </div>
          <select
            value={config.visionMode || 'auto'}
            onChange={(e) => updateField('visionMode', (e.target.value === 'auto' ? undefined : e.target.value) as typeof config.visionMode)}
            className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
            style={{
              padding: '6px 28px 6px 12px',
              borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
            }}
          >
            <option value="auto">自动</option>
            <option value="on">强制开启</option>
            <option value="off">关闭</option>
          </select>
        </div>

        {showReasoningEffort && (
          <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
            <div className="flex-1 min-w-0 mr-4">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>思考强度</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>FoxCode Responses API 的 reasoning.effort 参数</div>
            </div>
            <select
              value={config.reasoningEffort || 'high'}
              onChange={(e) => updateField('reasoningEffort', e.target.value as typeof config.reasoningEffort)}
              className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-all cursor-pointer"
              style={{
                padding: '6px 28px 6px 12px',
                borderColor: 'var(--border-input)', background: 'var(--bg-content)', color: 'var(--text-body)',
              }}
            >
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
        )}

        {/* Test Connection */}
        <div className="flex items-center justify-between" style={{ padding: '14px 20px' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>测试连接</div>
            <div className="text-[11px] mt-0.5 flex items-center gap-1.5" style={{ color: testStatus === 'success' ? 'var(--color-green)' : testStatus === 'error' ? 'var(--color-red)' : 'var(--text-light)' }}>
              {testStatus === 'testing' && <Loader2 className="w-3 h-3 animate-spin" />}
              {testStatus === 'success' && <CheckCircle2 className="w-3 h-3" />}
              {testStatus === 'error' && <XCircle className="w-3 h-3" />}
              {testMessage || '验证 API 配置是否有效'}
            </div>
          </div>
          <button
            onClick={() => testConnection()}
            disabled={testStatus === 'testing'}
            className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-all hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
            style={{
              padding: '7px 16px',
              background: 'var(--color-blue)', color: '#FFFFFF', border: 'none',
            }}
          >
            {testStatus === 'testing' ? '测试中...' : '测试'}
          </button>
        </div>
      </div>

      {/* Message Coalescing */}
      <div
        className="rounded-2xl border overflow-hidden"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)' }}
      >
        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>对话发送</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              当用户在很短时间内连续发送多条消息时，先合并再统一交给 Agent，减少逐次等待。
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3" style={{ padding: '14px 20px' }}>
          <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-input)', background: 'var(--bg-content)' }}>
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
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-input)', background: 'var(--bg-content)' }}>
            <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>合并窗口</div>
            <select
              value={messageCoalesceWindowMs}
              onChange={(e) => {
                setMessageCoalesceWindowMs(e.target.value)
                persistBridgeSetting('agent_message_coalesce_window_ms', e.target.value)
              }}
              className="w-full bg-transparent text-[12px] outline-none cursor-pointer"
              style={{ color: 'var(--text-body)' }}
            >
              <option value="600">0.6 秒</option>
              <option value="1000">1.0 秒</option>
              <option value="1200">1.2 秒</option>
              <option value="1800">1.8 秒</option>
              <option value="2500">2.5 秒</option>
            </select>
          </div>
        </div>
      </div>

      {/* Agent Runtime */}
      <div
        className="rounded-2xl border overflow-hidden"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)' }}
      >
        <div className="flex items-center justify-between" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="flex-1 min-w-0 mr-4">
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>Agent Runtime</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-light)' }}>
              Claude SDK 单核编排，Python sidecar 提供 Channels / Heartbeat / cron
            </div>
          </div>
          <button
            className="rounded-lg border text-[12px] hover:bg-[var(--bg-hover)] transition-colors"
            style={{
              padding: '6px 10px',
              borderColor: 'var(--border-input)',
              background: 'var(--bg-content)',
              color: 'var(--text-body)',
            }}
            onClick={() => {
              void refreshRuntimeSummary()
            }}
          >
            刷新状态
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-input)', background: 'var(--bg-content)' }}>
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
          <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-input)', background: 'var(--bg-content)' }}>
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
        <div className="grid grid-cols-2 gap-3" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-input)', background: 'var(--bg-content)' }}>
            <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>Bind Host</div>
            <input
              type="text"
              value={sidecarHost}
              onChange={(e) => setSidecarHost(e.target.value)}
              onBlur={() => persistBridgeSetting('sidecar_bind_host', sidecarHost)}
              className="w-full bg-transparent text-[12px] outline-none"
              style={{ color: 'var(--text-body)' }}
            />
          </div>
          <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-input)', background: 'var(--bg-content)' }}>
            <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>Bind Port</div>
            <input
              type="text"
              value={sidecarPort}
              onChange={(e) => setSidecarPort(e.target.value)}
              onBlur={() => persistBridgeSetting('sidecar_bind_port', sidecarPort)}
              className="w-full bg-transparent text-[12px] outline-none"
              style={{ color: 'var(--text-body)' }}
            />
          </div>
        </div>
        <div style={{ padding: '14px 20px' }}>
          <div className="text-[12px] leading-6" style={{ color: 'var(--text-body)' }}>
            <div>编排内核: <span style={{ color: 'var(--color-blue)' }}>Claude SDK</span></div>
            <div>Sidecar: {runtimeSummary?.sidecarStatus || 'unknown'} {runtimeSummary?.sidecarPort ? `(port ${runtimeSummary.sidecarPort})` : ''}</div>
            <div>Channels: {runtimeSummary?.channelCount ?? 0} · Schedules: {runtimeSummary?.scheduleCount ?? 0}</div>
            <div>活跃任务: {runtimeSummary?.activeTasks ?? 0}</div>
          </div>
        </div>
      </div>

      {/* Provider Notes */}
      {currentProvider && (
        <div
          className="rounded-xl text-[11px] leading-relaxed"
          style={{ padding: '12px 16px', background: 'var(--bg-canvas)', color: 'var(--text-light)' }}
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

export default function Settings() {
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState('account')
  const [settings, setSettings] = useState(settingsData)
  const { theme, setTheme, skin, setSkin } = useTheme()

  const currentSection = settings.find(s => s.id === activeSection)

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

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-content)' }}>
      {/* Header — macOS traffic light clearance with paddingLeft: 72 */}
      <div
        className="glass-surface-panel h-[38px] flex items-center drag-region"
        style={{
          background: 'var(--surface-toolbar-bg)',
          paddingLeft: 72,
          paddingRight: 16,
          borderBottom: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-md)',
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
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Navigation */}
        <div
          className="glass-surface-panel flex-shrink-0 overflow-auto"
          style={{
            width: 240,
            background: 'var(--surface-panel-bg)',
            borderRight: '1px solid var(--border-default)',
            padding: '16px 12px',
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
                  className="flex items-center gap-3 rounded-xl transition-all duration-200 text-left group"
                  style={{
                    padding: '10px 14px',
                    background: isActive ? 'var(--color-blue-light)' : 'transparent',
                    color: isActive ? 'var(--color-blue)' : 'var(--text-body)',
                  }}
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
                    style={{
                      background: isActive ? 'var(--color-blue)' : 'var(--bg-canvas)',
                    }}
                  >
                    <Icon
                      className="w-3.5 h-3.5"
                      strokeWidth={2}
                      style={{ color: isActive ? '#FFFFFF' : 'var(--text-muted)' }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-[13px] font-medium truncate"
                      style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-title)' }}
                    >
                      {section.title}
                    </div>
                    <div
                      className="text-[10px] truncate mt-0.5"
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
          <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--border-default)' }}>
            <div className="flex items-center gap-2 px-3">
              <HardDrive className="w-3 h-3" style={{ color: 'var(--text-light)' }} />
              <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                Ready v0.1.0 · Electron 34
              </span>
            </div>
          </div>
        </div>

        {/* Settings Content Panel */}
        <div className="flex-1 overflow-auto" style={{ background: 'var(--bg-content)' }}>
          <div className="max-w-[640px] mx-auto" style={{ padding: '32px 40px' }}>
            {currentSection && (
              <>
                {/* Section Header */}
                <div className="mb-8">
                  <div className="flex items-center gap-3 mb-2">
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center"
                      style={{ background: 'var(--color-blue-light)' }}
                    >
                      <currentSection.icon
                        className="w-4.5 h-4.5"
                        style={{ width: 18, height: 18, color: 'var(--color-blue)' }}
                        strokeWidth={2}
                      />
                    </div>
                    <div>
                      <h2 className="text-[18px] font-bold" style={{ color: 'var(--text-title)' }}>
                        {currentSection.title}
                      </h2>
                      <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {currentSection.description}
                      </p>
                    </div>
                  </div>
                </div>

                {/* AI Settings Panel — dynamic, wired to backend */}
                {currentSection.id === 'ai' && <AISettingsPanel />}
                {currentSection.id === 'remote-im' && <RemoteIMSettingsPanel />}

                {/* Theme Switcher — only in Appearance section */}
                {currentSection.id === 'appearance' && (
                  <>
                    <div className="mb-8">
                      <h4
                        className="text-[11px] font-semibold uppercase tracking-wider mb-3"
                        style={{ color: 'var(--text-light)' }}
                      >
                        主题模式
                      </h4>
                      <div className="flex gap-3">
                        {themeOptions.map((opt) => {
                          const isActive = theme === opt.value
                          const OptIcon = opt.icon
                          return (
                            <button
                              key={opt.value}
                              onClick={() => setTheme(opt.value)}
                              className="flex-1 flex flex-col items-center gap-2.5 rounded-2xl border-2 transition-all duration-200"
                              style={{
                                padding: '20px 16px',
                                borderColor: isActive ? 'var(--color-blue)' : 'var(--border-default)',
                                background: isActive ? 'var(--color-blue-light)' : 'var(--bg-primary)',
                                boxShadow: isActive ? '0 0 0 1px var(--color-blue)' : 'none',
                              }}
                            >
                              <div
                                className="w-10 h-10 rounded-xl flex items-center justify-center"
                                style={{
                                  background: isActive ? 'var(--color-blue)' : 'var(--bg-canvas)',
                                }}
                              >
                                <OptIcon
                                  className="w-5 h-5"
                                  strokeWidth={1.8}
                                  style={{ color: isActive ? '#FFFFFF' : 'var(--text-muted)' }}
                                />
                              </div>
                              <span
                                className="text-[13px] font-semibold"
                                style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-body)' }}
                              >
                                {opt.label}
                              </span>
                              <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                                {opt.description}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div className="mb-8">
                      <h4
                        className="text-[11px] font-semibold uppercase tracking-wider mb-3"
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
                              className="flex items-center gap-3 rounded-2xl border-2 text-left transition-all duration-200"
                              style={{
                                padding: '14px 14px',
                                borderColor: isActive ? 'var(--color-blue)' : 'var(--border-default)',
                                background: isActive ? 'var(--color-blue-light)' : 'var(--bg-primary)',
                                boxShadow: isActive ? '0 0 0 1px var(--color-blue)' : 'none',
                              }}
                            >
                              <div
                                className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                                style={{
                                  background: isActive ? 'var(--color-blue)' : 'var(--bg-canvas)',
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
                                  className="text-[12px] font-semibold truncate"
                                  style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-body)' }}
                                >
                                  {opt.label}
                                </div>
                                <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-light)' }}>
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
                {currentSection.id !== 'ai' && currentSection.id !== 'remote-im' && <div
                  className="glass-surface-card rounded-2xl border overflow-hidden"
                  style={{
                    borderColor: 'var(--border-default)',
                    background: 'var(--surface-card-bg)',
                  }}
                >
                  {currentSection.settings.map((setting, index) => (
                    <div
                      key={setting.id}
                      className="flex items-center justify-between transition-colors"
                      style={{
                        padding: '16px 20px',
                        borderBottom: index < currentSection.settings.length - 1 ? '1px solid var(--border-default)' : undefined,
                      }}
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
                          {setting.label}
                        </div>
                        {setting.description && (
                          <div className="text-[11px] mt-1" style={{ color: 'var(--text-light)' }}>
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
                            width: 44,
                            height: 24,
                            borderRadius: 12,
                            position: 'relative',
                            background: setting.value ? 'var(--color-blue)' : 'var(--border-input)',
                          }}
                        >
                          <span
                            className="absolute bg-white rounded-full shadow-sm transition-all duration-200"
                            style={{
                              top: 3,
                              width: 18,
                              height: 18,
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
                            padding: '6px 28px 6px 12px',
                            borderColor: 'var(--border-input)',
                            background: 'var(--bg-content)',
                            color: 'var(--text-body)',
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
                            padding: '6px 12px',
                            width: 220,
                            borderColor: 'var(--border-input)',
                            background: 'var(--bg-content)',
                            color: 'var(--text-body)',
                          }}
                        />
                      )}

                      {/* Readonly value */}
                      {setting.type === 'readonly' && (
                        <span
                          className="flex-shrink-0 text-[12px] font-mono rounded-lg"
                          style={{
                            padding: '5px 12px',
                            background: 'var(--bg-canvas)',
                            color: 'var(--text-muted)',
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
                            padding: '7px 16px',
                            ...(setting.buttonVariant === 'danger' ? {
                              background: 'transparent',
                              color: 'var(--color-red)',
                              border: '1px solid var(--color-red)',
                            } : setting.buttonVariant === 'primary' ? {
                              background: 'var(--color-blue)',
                              color: '#FFFFFF',
                              border: 'none',
                            } : {
                              background: 'transparent',
                              color: 'var(--text-body)',
                              border: '1px solid var(--border-default)',
                            })
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
  )
}
