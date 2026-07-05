import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ChevronLeft, User, Bell, Shield, Database,
  Palette, Keyboard, Globe, Info, Moon, Sun, Bot, Monitor, Droplets,
  ChevronRight, ExternalLink, HardDrive, Trash2, MessageSquare, Brain, Users, Sparkles, Cat,
  Plug2, Boxes
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme, type ThemeAccent, type ThemeSkin } from '../stores/useTheme'
import { nextIntentId } from '../../shared/browser-view-intent'
import { BROWSER_POWER_MODE_SETTING_KEY } from '../../shared/browser-power'
import RemoteIMSettingsPanel from '../components/settings/RemoteIMSettingsPanel'
import PetSettingsPanel from '../components/settings/PetSettingsPanel'
import ModelsRuntimeSettingsPanel from '../components/settings/ModelsRuntimeSettingsPanel'
import { MODELS_RUNTIME_SETTINGS_SECTION } from '../../shared/model-pack-types'
import { FILE_EMERGENCE_SETTING_KEY } from '../../shared/file-emergence'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_READONLY_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  settingsListItemStyle,
} from '../components/settings/settings-theme'
import AgentSettingsHub from '../components/agent-system/AgentSettingsHub'
import UserProfileEditor from '../components/profile/UserProfileEditor'
import { SETTINGS_ROW_CONTROL_MIN_WIDTH, SettingsSwitch, type SettingItem, type SettingSection } from './settings/settings-shared'
import { AISettingsPanel } from './settings/AISettingsPanel'
import { RSSDraftStoreSettingsPanel } from './settings/RSSDraftStoreSettingsPanel'
import { StorageSettingsPanel } from './settings/StorageSettingsPanel'
import { ExternalServicesSettingsPanel } from './settings/ExternalServicesSettingsPanel'
import { McpSettingsPanel } from './settings/McpSettingsPanel'
import { MemorySettingsSection } from './settings/MemorySettingsSection'

// 面板拆分后的导出保口（2026-07-05）：行为测试从 pages/Settings 导入这两个面板，import 面保持零变化。
export { StorageSettingsPanel } from './settings/StorageSettingsPanel'
export { ExternalServicesSettingsPanel } from './settings/ExternalServicesSettingsPanel'

const SETTINGS_SURFACE_REFRESH_DELAY_MS = 120

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
    description: '管理 Agent 的人格、知识、路由、生命周期与后台行为',
    settings: [] // Rendered dynamically via AgentSettingsHub（合并原 Agent / Agent 人格 / Agent 系统 三个 Tab）
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
    description: '接入外部 MCP server（stdio），扩展 Agent 可调用的工具',
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
        { value: 'orange', label: '橘红色' }
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
      {
        id: BROWSER_POWER_MODE_SETTING_KEY,
        label: '浏览器 Power Mode',
        description: '允许 Agent 在浏览器任务中使用自由脚本、CDP、网络追踪和高级资源嗅探；支付、删除、改凭据等动作仍需单独授权。',
        type: 'toggle',
        value: false,
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
      { id: 'version', label: '当前版本', type: 'readonly', value: 'Ready v0.1.1' },
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
  { value: 'liquid-glass', label: '通透玻璃', icon: Droplets, description: '真半透明液态玻璃，背后透出 macOS 桌面壁纸（默认）' },
  { value: 'ready-glass', label: '稳定玻璃', icon: Droplets, description: 'Ready 自持稳定底色，不透出桌面（更稳定但失去通透感）' },
  { value: 'solid-green-glass', label: '实色绿玻璃', icon: Droplets, description: '自持实色绿色磨砂底，带柔和青绿渐变' },
  { value: 'solid-blue-glass', label: '实色蓝玻璃', icon: Droplets, description: '自持实色蓝色渐变底，搭配粉色强调色' },
]

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
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'>('idle')
  const [updateMessage, setUpdateMessage] = useState('查看是否有新版本可用')
  const [updatePercent, setUpdatePercent] = useState<number | null>(null)
  const { theme, setTheme, skin, setSkin, accent, setAccent } = useTheme()
  const didMountRef = useRef(false)
  const settingsSurfaceRefreshTimerRef = useRef<number | null>(null)

  const currentSection = settings.find(s => s.id === activeSection)
  const updateBusy = updateStatus === 'checking' || updateStatus === 'downloading'
  const updateButtonLabel = updateStatus === 'downloaded'
    ? '重启安装'
    : updateBusy
      ? '检查中'
      : '检查更新'
  const updateDescription = updateStatus === 'downloading' && updatePercent !== null
    ? `${updateMessage}（${Math.round(updatePercent)}%）`
    : updateMessage

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
    const unsubscribe = window.electronAPI?.app?.onUpdateStatus?.((data) => {
      switch (data.status) {
        case 'checking':
          setUpdateStatus('checking')
          setUpdatePercent(null)
          setUpdateMessage('正在检查更新…')
          break
        case 'available':
          setUpdateStatus('available')
          setUpdatePercent(null)
          setUpdateMessage(data.version ? `发现新版本 ${data.version}，正在下载…` : '发现新版本，正在下载…')
          break
        case 'downloading':
          setUpdateStatus('downloading')
          setUpdatePercent(typeof data.percent === 'number' ? data.percent : null)
          setUpdateMessage('正在下载更新')
          break
        case 'downloaded':
          setUpdateStatus('downloaded')
          setUpdatePercent(null)
          setUpdateMessage(data.version ? `新版本 ${data.version} 已下载，点击重启安装` : '新版本已下载，点击重启安装')
          break
        case 'not-available':
          setUpdateStatus('not-available')
          setUpdatePercent(null)
          setUpdateMessage(data.version ? `当前已是最新版本（${data.version}）` : '当前已是最新版本')
          break
        case 'error':
          setUpdateStatus('error')
          setUpdatePercent(null)
          setUpdateMessage(`更新检查失败：${data.error || '未知错误'}`)
          break
        default:
          break
      }
    })
    return () => { unsubscribe?.() }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings?.get) return
    let cancelled = false
    void (async () => {
      const [fileEmergenceResult, browserPowerResult] = await Promise.all([
        window.electronAPI.settings.get(FILE_EMERGENCE_SETTING_KEY),
        window.electronAPI.settings.get(BROWSER_POWER_MODE_SETTING_KEY),
      ])
      if (cancelled) return
      if (fileEmergenceResult?.success) {
        updateSetting('privacy', FILE_EMERGENCE_SETTING_KEY, fileEmergenceResult.data !== 'false')
      }
      if (browserPowerResult?.success) {
        updateSetting('privacy', BROWSER_POWER_MODE_SETTING_KEY, browserPowerResult.data === 'true')
      }
      // Agent 后台播报 / 新会话路由 的读写已迁入 AgentSettingsHub「行为」子区（自包含）。
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

  const handleUpdateButtonClick = useCallback(async () => {
    const appAPI = window.electronAPI?.app
    if (!appAPI) {
      setUpdateStatus('error')
      setUpdateMessage('更新 IPC 不可用')
      return
    }
    if (updateStatus === 'downloaded') {
      try {
        await appAPI.installUpdate()
      } catch (error) {
        // silent-catch: failure surfaces as the update error status + message
        setUpdateStatus('error')
        setUpdateMessage(`安装更新失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (updateBusy) return
    setUpdateStatus('checking')
    setUpdatePercent(null)
    setUpdateMessage('正在检查更新…')
    const result = await appAPI.checkUpdate()
    if (!result.success) {
      setUpdateStatus('error')
      setUpdatePercent(null)
      setUpdateMessage(`更新检查失败：${result.error || '未知错误'}`)
    }
  }, [updateBusy, updateStatus])

  const handleToggleSetting = async (sectionId: string, setting: SettingItem) => {
    const nextValue = !setting.value
    const persistedToggleIds = new Set([FILE_EMERGENCE_SETTING_KEY, BROWSER_POWER_MODE_SETTING_KEY])
    if (!persistedToggleIds.has(setting.id)) {
      updateSetting(sectionId, setting.id, nextValue)
      return
    }
    if (typeof window === 'undefined' || !window.electronAPI?.settings?.set) {
      setSettingErrors((prev) => ({ ...prev, [setting.id]: '设置 IPC 不可用' }))
      return
    }
    const result = await window.electronAPI.settings.set(setting.id, nextValue ? 'true' : 'false')
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

  const isDynamicSection = currentSection
    ? ['ai', 'remote-im', 'external-services', 'mcp', 'memory', 'agent', 'user-profiles', 'pet', 'rss-storage', MODELS_RUNTIME_SETTINGS_SECTION, 'storage'].includes(currentSection.id)
    : false

  return (
    <div className="settings-page-shell flex h-full flex-col overflow-hidden">
      {/* Header — macOS traffic light clearance with paddingLeft: 72 */}
      <div
        data-liquid-shell="settings-header"
        className="mx-3 mt-3 flex h-[46px] items-center rounded-[16px] drag-region"
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
                  className={`flex items-center gap-3 rounded-[16px] transition-[background-color,border-color,color] duration-200 text-left group ${isActive ? '' : 'hover:bg-[var(--bg-hover)]'}`}
                  style={settingsListItemStyle(isActive)}
                >
                  <div className="w-8 h-8 flex items-center justify-center flex-shrink-0 transition-colors">
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
                Ready v0.1.1 · Electron 42
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
              maxWidth: 1040,
              padding: '32px 40px 64px',
            }}
          >
                {currentSection && (
                  <>
                    {/* Section Header */}
                    <div style={{ padding: '4px 0 0', marginBottom: 24 }}>
                      <h2
                        className="text-[20px] font-semibold leading-7 tracking-[-0.01em]"
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

                {/* Agent — 单入口容器：人格 / registry / 派生 / 系统 + 行为开关 */}
                {currentSection.id === 'agent' && (
                  <AgentSettingsHub />
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
                              className="glass-surface-card flex-1 flex flex-col items-center gap-2.5 rounded-2xl border transition-[background-color,border-color,color,transform] duration-200 hover:-translate-y-[1px] active:scale-[0.99]"
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
                              className="glass-surface-card flex items-center gap-3 rounded-2xl border text-left transition-[background-color,border-color,color,transform] duration-200 hover:-translate-y-[1px] active:scale-[0.99]"
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
                {!isDynamicSection && <div className="flex flex-col gap-6">
                  {currentSection.settings.map((setting) => {
                    const isUpdateButton = currentSection.id === 'about' && setting.id === 'checkUpdate'
                    return (
                    <div
                      key={setting.id}
                      className="flex items-center justify-between transition-colors"
                      style={{
                        padding: 0,
                      }}
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
                          {setting.label}
                        </div>
                        {(setting.description || isUpdateButton) && (
                          <div className="text-[12px] mt-0.5 leading-5" style={{ color: 'var(--text-light)' }}>
                            {isUpdateButton ? updateDescription : setting.description}
                          </div>
                        )}
                      </div>

                      {/* Toggle */}
                      {setting.type === 'toggle' && (
                        <SettingsSwitch
                          checked={Boolean(setting.value)}
                          onChange={() => { void handleToggleSetting(currentSection.id, setting) }}
                        />
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
                            width: 'auto',
                            minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
                          }}
                        >
                          {setting.options?.map(opt => (
                            <option
                              key={typeof opt === 'string' ? opt : opt.value}
                              value={typeof opt === 'string' ? opt : opt.value}
                            >
                              {typeof opt === 'string'
                                ? opt
                                : currentSection.id === 'appearance' && setting.id === 'theme' && opt.value === 'purple' && (skin === 'solid-green-glass' || skin === 'solid-blue-glass')
                                  ? '粉色'
                                  : opt.label}
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
                            width: 'auto',
                            minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
                          }}
                        >
                          {setting.value}
                        </span>
                      )}

                      {/* Button */}
                      {setting.type === 'button' && (
                        <button
                          type="button"
                          onClick={() => {
                            if (isUpdateButton) void handleUpdateButtonClick()
                          }}
                          disabled={isUpdateButton && updateBusy}
                          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                          style={{
                            ...(setting.buttonVariant === 'primary'
                              ? SETTINGS_PRIMARY_BUTTON_STYLE
                              : setting.buttonVariant === 'danger'
                                ? SETTINGS_DANGER_BUTTON_STYLE
                                : SETTINGS_SECONDARY_BUTTON_STYLE),
                            minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
                            justifyContent: 'center',
                            opacity: isUpdateButton && updateBusy ? 0.68 : 1,
                            cursor: isUpdateButton && updateBusy ? 'wait' : 'pointer',
                          }}
                        >
                          {setting.buttonVariant === 'danger' && <Trash2 className="w-3 h-3" />}
                          {isUpdateButton ? updateButtonLabel : setting.buttonLabel || '执行'}
                        </button>
                      )}
                    </div>
                  )})}
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
