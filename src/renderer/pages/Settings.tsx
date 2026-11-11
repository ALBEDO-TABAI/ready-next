import { BookSourceSettingsPanel } from './settings/BookSourceSettingsPanel'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ChevronLeft, User, Bell, Shield, Database,
  Palette, Keyboard, Globe, Info, Moon, Sun, Bot, Monitor,
  ExternalLink, HardDrive, MessageSquare, Cat,
  Plug2, Boxes, Cookie, Tags, Brain, Check, Loader2, RefreshCw,
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTheme, type ThemeOption } from '../stores/useTheme'
import { ELECTRON_MAJOR_VERSION, READY_VERSION_LABEL } from '../../shared/app-version'
import { nextIntentId } from '../../shared/browser-view-intent'
import { BROWSER_POWER_MODE_SETTING_KEY } from '../../shared/browser-power'
import RemoteIMSettingsPanel from '../components/settings/RemoteIMSettingsPanel'
import PetSettingsPanel from '../components/settings/PetSettingsPanel'
import ModelsRuntimeSettingsPanel from '../components/settings/ModelsRuntimeSettingsPanel'
import { MODELS_RUNTIME_SETTINGS_SECTION } from '../../shared/model-pack-types'
import { FILE_EMERGENCE_SETTING_KEY } from '../../shared/file-emergence'
import { settingsListItemStyle } from '../components/settings/settings-theme'
import { ReadyDotRMark } from '../components/agent/WelcomePanel'
import {
  SETTINGS_NAV_GROUP_LABELS,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  settingsButtonClass,
  type SettingItem,
  type SettingSection,
  type SettingsNavGroup,
} from './settings/settings-shared'
import { AISettingsPanel } from './settings/AISettingsPanel'
import { RSSDraftStoreSettingsPanel } from './settings/RSSDraftStoreSettingsPanel'
import { StorageSettingsPanel } from './settings/StorageSettingsPanel'
import { BrowserPrivacySettingsPanel } from './settings/BrowserPrivacySettingsPanel'
import { ExternalServicesSettingsPanel } from './settings/ExternalServicesSettingsPanel'
import { McpSettingsPanel } from './settings/McpSettingsPanel'
import { TagForgeSettingsPanel } from './settings/TagForgeSettingsPanel'
import { ReadyMemorySettingsPanel } from './settings/ReadyMemorySettingsPanel'
import { READY_SHORTCUT_GUIDE } from '../../shared/app-shortcuts'

// 面板拆分后的导出保口（2026-07-05）：行为测试从 pages/Settings 导入这两个面板，import 面保持零变化。
export { StorageSettingsPanel } from './settings/StorageSettingsPanel'
export { ExternalServicesSettingsPanel } from './settings/ExternalServicesSettingsPanel'

const SETTINGS_SURFACE_REFRESH_DELAY_MS = 120

// 导航按分组排列（通用 → 智能 → 内容与连接 → 隐私与数据 → 应用），组内顺序即展示顺序。
const settingsData: SettingSection[] = [
  {
    id: 'account',
    group: 'general',
    title: '帐号',
    icon: User,
    description: '管理你的帐号信息和个人资料',
    settings: [
      { id: 'username', label: '用户名', description: '显示在应用中的名称', type: 'text', value: 'Ready User' },
      { id: 'email', label: '邮箱', description: '用于接收通知和同步', type: 'text', value: 'user@ready.app' }
    ]
  },
  {
    id: 'appearance',
    group: 'general',
    title: '外观',
    icon: Palette,
    description: '主题与透明度',
    settings: []
  },
  {
    id: 'notifications',
    group: 'general',
    title: '通知',
    icon: Bell,
    description: '控制推送通知和声音提示',
    settings: [
      { id: 'pushEnabled', label: '推送通知', description: '接收任务完成和 RSS 更新通知', type: 'toggle', value: true },
      { id: 'soundEnabled', label: '声音提示', description: '操作完成时播放提示音', type: 'toggle', value: true }
    ]
  },
  {
    id: 'language',
    group: 'general',
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
    id: 'shortcuts',
    group: 'general',
    title: '快捷键',
    icon: Keyboard,
    description: '查看当前可用的键盘快捷键',
    settings: READY_SHORTCUT_GUIDE.map((item) => ({ ...item, type: 'readonly' as const })),
  },
  {
    id: 'ai',
    group: 'intelligence',
    title: 'AI 模型',
    icon: Bot,
    description: '配置 AI 助手的模型和连接参数',
    settings: [] // Rendered dynamically via AISettingsPanel
  },
  {
    id: 'memory',
    group: 'intelligence',
    title: '长期记忆',
    icon: Brain,
    description: '管理 Ready 记住的内容与整理方式',
    settings: [],
  },
  {
    id: 'mcp',
    group: 'intelligence',
    title: 'MCP',
    icon: Plug2,
    description: '接入外部 MCP server（stdio），扩展 Agent 可调用的工具',
    settings: [] // Rendered dynamically via McpSettingsPanel — Y0.7 §11.0b labeling branch
  },
  {
    id: 'external-services',
    group: 'intelligence',
    title: '外部服务',
    icon: ExternalLink,
    description: '统一管理 AnySearch、Tavily、Jina、DuckDuckGo、RSSHub、Bilibili、GitHub、高德地图与读图模型',
    settings: []
  },
  {
    id: MODELS_RUNTIME_SETTINGS_SECTION,
    group: 'intelligence',
    title: '模型与运行时',
    icon: Boxes,
    description: '按需下载语音识别与标点模型，支持国内 / 国外源自动切换与断点续传',
    settings: []
  },
  {
    id: 'remote-im',
    group: 'content',
    title: '远程 IM',
    icon: MessageSquare,
    description: '绑定微信、飞书，远程发送任务并接收回复',
    settings: [] // Rendered dynamically via RemoteIMSettingsPanel
  },
  { id: 'reading', group: 'content', title: '阅读', icon: HardDrive, description: '书源与下载设置', settings: [] },
  {
    id: 'rss-storage',
    group: 'content',
    title: 'RSS 底稿',
    icon: HardDrive,
    description: '管理 RSS 底稿仓库、增量收件箱和刷新重置',
    settings: []
  },
  {
    id: 'tag-forge',
    group: 'content',
    title: '文档标签',
    icon: Tags,
    description: '管理 Tag Forge 自动打标与待审核词条',
    settings: []
  },
  {
    id: 'pet',
    group: 'content',
    title: '宠物',
    icon: Cat,
    description: '管理桌面悬浮宠物和工作气泡',
    settings: []
  },
  {
    id: 'privacy',
    group: 'privacy',
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
    id: 'browser-privacy',
    group: 'privacy',
    title: '浏览器数据',
    icon: Cookie,
    description: '清除浏览数据，管理 Cookie 与站点数据',
    settings: [] // Rendered dynamically via BrowserPrivacySettingsPanel
  },
  {
    id: 'storage',
    group: 'privacy',
    title: '存储',
    icon: Database,
    description: '管理本地缓存和存储空间',
    settings: [] // Rendered dynamically via StorageSettingsPanel
  },
  {
    id: 'about',
    group: 'about',
    title: '关于',
    icon: Info,
    description: '应用版本信息和更新',
    settings: [
      { id: 'version', label: '当前版本', type: 'readonly', value: READY_VERSION_LABEL },
      { id: 'checkUpdate', label: '检查更新', description: '查看是否有新版本可用', type: 'button', buttonLabel: '检查更新', buttonVariant: 'primary' }
    ]
  }
]

const SETTINGS_NAV_GROUP_ORDER: SettingsNavGroup[] = ['general', 'intelligence', 'content', 'privacy', 'about']

// Theme mode options
const themeOptions: { value: ThemeOption; label: string; icon: React.ElementType; description: string }[] = [
  { value: 'light', label: '浅色', icon: Sun, description: '始终使用浅色主题' },
  { value: 'dark', label: '深色', icon: Moon, description: '始终使用深色主题' },
  { value: 'system', label: '跟随系统', icon: Monitor, description: '自动跟随系统设置' }
]

const SETTINGS_PREVIEW_SHADOW = '0 1px 2px rgba(24, 39, 77, 0.08), 0 6px 16px -8px rgba(24, 39, 77, 0.22)'

function OptionTick() {
  return (
    <span className="sx-option__tick" aria-hidden>
      <Check />
    </span>
  )
}

function ThemeModePreview({ mode }: { mode: ThemeOption }) {
  const pane = (dark: boolean) => (
    <div
      className="absolute inset-0 flex gap-[6px] p-[8px]"
      style={{ background: dark ? 'linear-gradient(150deg, #263042 0%, #161C28 100%)' : 'linear-gradient(150deg, #FBFAF6 0%, #EFEBE2 100%)' }}
    >
      <div className="flex w-[22%] flex-col gap-[4px] pt-[2px]">
        {[0.9, 0.6, 0.75].map((w, index) => (
          <span key={index} className="h-[3px] rounded-full" style={{ width: `${w * 100}%`, background: dark ? 'rgba(255,255,255,0.22)' : 'rgba(24,39,77,0.14)' }} />
        ))}
      </div>
      <div
        className="flex-1 rounded-[6px] p-[6px]"
        style={{
          background: dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.78)',
          boxShadow: dark ? 'none' : '0 4px 10px -4px rgba(24,39,77,0.18)',
        }}
      >
        <span className="block h-[4px] w-[46%] rounded-full" style={{ background: dark ? 'rgba(255,255,255,0.5)' : 'rgba(24,39,77,0.42)' }} />
        <span className="mt-[5px] block h-[3px] w-[80%] rounded-full" style={{ background: dark ? 'rgba(255,255,255,0.16)' : 'rgba(24,39,77,0.12)' }} />
        <span className="mt-[3px] block h-[3px] w-[64%] rounded-full" style={{ background: dark ? 'rgba(255,255,255,0.16)' : 'rgba(24,39,77,0.12)' }} />
        <span className="mt-[7px] block h-[5px] w-[5px] rounded-full" style={{ background: 'var(--sx-accent)' }} />
      </div>
    </div>
  )
  return (
    <div className="relative h-[84px] w-full overflow-hidden rounded-[10px]" style={{ boxShadow: SETTINGS_PREVIEW_SHADOW }} aria-hidden>
      {mode === 'dark' ? pane(true) : pane(false)}
      {mode === 'system' && (
        <div className="absolute inset-0" style={{ clipPath: 'polygon(58% 0, 100% 0, 100% 100%, 42% 100%)' }}>
          {pane(true)}
        </div>
      )}
    </div>
  )
}

function ShortcutKeys({ value }: { value: string }) {
  const alternatives = value.split(' 或 ')
  return (
    <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      {alternatives.map((alternative, altIndex) => (
        <span key={alternative} className="inline-flex items-center gap-2">
          {altIndex > 0 && <span className="sx-meta">或</span>}
          <span className="sx-kbd">
            {alternative.split(' + ').map((key) => <kbd key={key}>{key}</kbd>)}
          </span>
        </span>
      ))}
    </span>
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
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'>('idle')
  const [updateMessage, setUpdateMessage] = useState('查看是否有新版本可用')
  const [updatePercent, setUpdatePercent] = useState<number | null>(null)
  const { theme, setTheme, transparency, reduceTransparency, setReduceTransparency } = useTheme()
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
    ? ['ai', 'memory', 'remote-im', 'external-services', 'mcp', 'tag-forge', 'pet', 'rss-storage', MODELS_RUNTIME_SETTINGS_SECTION, 'storage', 'browser-privacy'].includes(currentSection.id)
    : false

  const renderSettingControl = (sectionId: string, setting: SettingItem) => {
    const isUpdateButton = sectionId === 'about' && setting.id === 'checkUpdate'
    switch (setting.type) {
      case 'toggle':
        return (
          <SettingsSwitch
            checked={Boolean(setting.value)}
            ariaLabel={setting.label}
            onChange={() => { void handleToggleSetting(sectionId, setting) }}
          />
        )
      case 'select':
        return (
          <select
            value={setting.value as string}
            aria-label={setting.label}
            onChange={(e) => updateSetting(sectionId, setting.id, e.target.value)}
            className="sx-select"
          >
            {setting.options?.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )
      case 'text':
        return (
          <input
            type={setting.id === 'apiKey' ? 'password' : 'text'}
            value={setting.value as string}
            aria-label={setting.label}
            onChange={(e) => updateSetting(sectionId, setting.id, e.target.value)}
            className="sx-input"
            style={{ width: 260 }}
          />
        )
      case 'readonly':
        return sectionId === 'shortcuts'
          ? <ShortcutKeys value={String(setting.value ?? '')} />
          : <span className="sx-value">{setting.value}</span>
      case 'button':
        return (
          <button
            type="button"
            onClick={() => {
              if (isUpdateButton) void handleUpdateButtonClick()
            }}
            disabled={isUpdateButton && updateBusy}
            aria-busy={isUpdateButton && updateBusy ? true : undefined}
            className={settingsButtonClass(setting.buttonVariant === 'primary' ? 'primary' : setting.buttonVariant === 'danger' ? 'danger' : 'secondary')}
            style={{ minWidth: 104 }}
          >
            {isUpdateButton && updateBusy
              ? <Loader2 className="animate-spin" />
              : isUpdateButton && updateStatus !== 'downloaded' ? <RefreshCw /> : null}
            {isUpdateButton ? updateButtonLabel : setting.buttonLabel || '执行'}
          </button>
        )
      default:
        return null
    }
  }

  const renderSettingRows = (section: SettingSection) => (
    <SettingsCard>
      {section.settings.map((setting) => {
        const isUpdateButton = section.id === 'about' && setting.id === 'checkUpdate'
        const description = isUpdateButton ? updateDescription : setting.description
        return (
          <SettingsRow
            key={setting.id}
            label={setting.label}
            description={(description || settingErrors[setting.id]) && (
              <>
                {description}
                {settingErrors[setting.id] && (
                  <span className="sx-text-danger block">{settingErrors[setting.id]}</span>
                )}
              </>
            )}
          >
            {renderSettingControl(section.id, setting)}
          </SettingsRow>
        )
      })}
    </SettingsCard>
  )

  return (
    <div className="settings-page-shell flex h-full flex-col overflow-hidden">
      {/* Header — macOS traffic light clearance with paddingLeft: 72 */}
      <div
        data-liquid-shell="settings-header"
        className="mx-3 mt-3 flex h-[46px] items-center gap-2 rounded-[16px] drag-region"
        style={{
          background: 'transparent',
          paddingLeft: 72,
          paddingRight: 18,
          borderBottom: '1px solid transparent',
          boxShadow: 'none',
        }}
      >
        <button
          type="button"
          onClick={() => navigate('/')}
          className={settingsButtonClass('ghost', { size: 'sm', className: 'no-drag' })}
          style={{ paddingLeft: 6 }}
        >
          <ChevronLeft strokeWidth={2} />
          返回
        </button>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--sx-title)' }}>
          设置
        </span>
      </div>

      {/* Content */}
      <div className="flex flex-1 gap-3 overflow-hidden px-3 pb-3 pt-1.5">
        {/* Sidebar Navigation */}
        <nav
          aria-label="设置分区"
          data-liquid-shell="settings-sidebar"
          className="panel-hover-scrollbar flex-shrink-0 overflow-auto"
          style={{
            width: 220,
            background: 'transparent',
            padding: '4px 6px 12px 4px',
            scrollbarGutter: 'stable',
          }}
          onMouseMove={handleSettingsSurfaceMotion}
          onScroll={handleSettingsSurfaceScroll}
          onMouseLeave={scheduleSettingsSurfaceRefresh}
        >
          {SETTINGS_NAV_GROUP_ORDER.map((group) => (
            <div key={group} className="sx-nav-group flex flex-col gap-0.5">
              <div className="sx-nav-group-label">{SETTINGS_NAV_GROUP_LABELS[group]}</div>
              {settings.filter((section) => section.group === group).map((section) => {
                const isActive = activeSection === section.id
                const Icon = section.icon
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    aria-current={isActive ? 'page' : undefined}
                    title={section.description}
                    className="sx-nav-item"
                    style={settingsListItemStyle(isActive)}
                  >
                    <Icon
                      className="h-[15px] w-[15px] flex-shrink-0"
                      strokeWidth={1.9}
                      style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-muted)' }}
                    />
                    <span className="sx-nav-item__label">{section.title}</span>
                  </button>
                )
              })}
            </div>
          ))}

          {/* Footer info */}
          <div className="sx-meta mt-4 px-3">
            {READY_VERSION_LABEL} · Electron {ELECTRON_MAJOR_VERSION}
          </div>
        </nav>

        {/* Settings Content Panel — 内容直接落在窗口玻璃底上，不额外铺画布 */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div
            key={currentSection?.id || 'unknown'}
            data-liquid-shell="settings-content"
            className="panel-hover-scrollbar h-full overflow-auto"
          >
          {/* 内容贴近导航左对齐、宽度随窗口舒展；左右留白按窗口宽度等比放大，超宽窗口才在右侧多留白。 */}
          <div
            className="w-full"
            style={{
              maxWidth: 1360,
              padding: '40px clamp(48px, 4.5vw, 88px) 80px',
            }}
          >
                {currentSection && (
                  <>
                    {/* Section Header */}
                    <div style={{ padding: '0 4px', marginBottom: 24 }}>
                      <h2
                        className="text-[20px] font-semibold leading-7 tracking-[-0.01em]"
                        style={{ color: 'var(--sx-title)', margin: 0 }}
                      >
                        {currentSection.title}
                      </h2>
                      <p
                        className="text-[13px] leading-6"
                        style={{ color: 'var(--sx-muted)', maxWidth: 720, margin: '4px 0 0 0' }}
                      >
                        {currentSection.description}
                      </p>
                    </div>

                {/* AI Settings Panel — dynamic, wired to backend */}
                {currentSection.id === 'ai' && <AISettingsPanel />}
                {currentSection.id === 'memory' && <ReadyMemorySettingsPanel />}
                {currentSection.id === 'reading' && <BookSourceSettingsPanel />}
                {currentSection.id === 'rss-storage' && <RSSDraftStoreSettingsPanel />}
                {currentSection.id === MODELS_RUNTIME_SETTINGS_SECTION && <ModelsRuntimeSettingsPanel />}
                {currentSection.id === 'storage' && <StorageSettingsPanel />}
                {currentSection.id === 'browser-privacy' && <BrowserPrivacySettingsPanel />}
                {currentSection.id === 'remote-im' && <RemoteIMSettingsPanel />}
                {currentSection.id === 'external-services' && <ExternalServicesSettingsPanel />}
                {currentSection.id === 'mcp' && <McpSettingsPanel />}
                {currentSection.id === 'pet' && <PetSettingsPanel />}
                {currentSection.id === 'tag-forge' && <TagForgeSettingsPanel />}

                {/* Appearance — 主题模式 / 视觉风格 / 主题色 */}
                {currentSection.id === 'appearance' && (
                  <div className="sx-stack">
                    <SettingsGroup label="主题模式">
                      <div role="radiogroup" aria-label="主题模式" className="grid grid-cols-3 gap-3">
                        {themeOptions.map((opt) => {
                          const isActive = theme === opt.value
                          const OptIcon = opt.icon
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              role="radio"
                              aria-checked={isActive}
                              onClick={() => setTheme(opt.value)}
                              className="sx-option flex-col"
                              style={{ padding: 10, gap: 10 }}
                            >
                              <ThemeModePreview mode={opt.value} />
                              <div className="flex items-center gap-2 px-1 pb-0.5" title={opt.description}>
                                <OptIcon className="h-[14px] w-[14px]" strokeWidth={1.9} style={{ color: isActive ? 'var(--sx-accent)' : 'var(--sx-muted)' }} />
                                <span className="text-[13px]" style={{ color: 'var(--sx-title)', fontWeight: isActive ? 600 : 500 }}>{opt.label}</span>
                              </div>
                              <OptionTick />
                            </button>
                          )
                        })}
                      </div>
                    </SettingsGroup>

                    <SettingsGroup label="透明度">
                      <SettingsCard>
                        <SettingsRow
                          label="减少透明"
                          description={transparency === 'reduced' && !reduceTransparency
                            ? '系统已开启“减少透明度”，窗口现在不透明。'
                            : '玻璃改为不透明的底色，菜单与弹层不再模糊。系统开启“减少透明度”时也会这样。'}
                        >
                          <SettingsSwitch checked={reduceTransparency} ariaLabel="减少透明" onChange={setReduceTransparency} />
                        </SettingsRow>
                      </SettingsCard>
                    </SettingsGroup>
                  </div>
                )}

                {/* About — 品牌标识直接落在页面上，版本与更新进一张卡 */}
                {currentSection.id === 'about' && (
                  <div className="mb-6 flex items-center gap-5 px-1">
                    <div
                      className="grid h-[64px] w-[64px] shrink-0 place-items-center rounded-[18px]"
                      style={{ background: 'var(--sx-raised-bg)', boxShadow: 'var(--sx-raised-shadow)' }}
                    >
                      <ReadyDotRMark />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[18px] font-semibold tracking-[-0.01em]" style={{ color: 'var(--sx-title)' }}>Ready</div>
                      <p className="mt-0.5 text-[12.5px] leading-6" style={{ color: 'var(--sx-muted)' }}>
                        Ready 是由@上班摸鱼 开发的，面向知识工作者和创作者的通用桌面工作台
                      </p>
                      <div className="mt-1 flex items-center gap-4">
                        <button type="button" className="sx-link">
                          <ExternalLink />
                          访问 Ready 官方网站
                        </button>
                        <span className="sx-meta">Built with Electron · React · TypeScript</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Settings Items (skip for dynamic sections) */}
                {!isDynamicSection && currentSection.id !== 'appearance' && renderSettingRows(currentSection)}
              </>
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
