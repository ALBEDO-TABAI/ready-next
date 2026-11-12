import { ReadingSettingsPanel } from './settings/ReadingSettingsPanel'
import { BrowserSearchSettingsPanel } from './settings/BrowserSearchSettingsPanel'
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import {
  ChevronLeft, Shield, Database, CalendarDays, FolderOpen, Puzzle, Newspaper,
  Palette, Keyboard, Info, Moon, Sun, Bot, Monitor,
  ExternalLink, HardDrive, MessageSquare, Cat,
  Plug2, Boxes, Cookie, Tags, Brain, Check, Loader2, RefreshCw, Sunrise, Globe,
} from 'lucide-react'
import { Button, Kbd, ListRow, SectionHeader, Switch } from '../components/ui'
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
import { ReadyDotRMark } from '../components/agent/WelcomePanel'
import {
  SETTINGS_NAV_GROUP_LABELS,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
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
import { LibrarySettingsPanel } from './settings/LibrarySettingsPanel'
import { StartupSettingsPanel } from './settings/StartupSettingsPanel'
import { ThirdPartyNoticesPanel } from './settings/ThirdPartyNoticesPanel'
import { READY_SHORTCUT_GUIDE } from '../../shared/app-shortcuts'

// 面板拆分后的导出保口（2026-07-05）：行为测试从 pages/Settings 导入这两个面板，import 面保持零变化。
export { StorageSettingsPanel } from './settings/StorageSettingsPanel'
export { ExternalServicesSettingsPanel } from './settings/ExternalServicesSettingsPanel'

const SETTINGS_SURFACE_REFRESH_DELAY_MS = 120
// The calendar's preference pages bring the calendar module and its stylesheet: load them when opened.
const CalendarSettingsPanel = lazy(() => import('./settings/CalendarSettingsPanel').then(module => ({ default: module.CalendarSettingsPanel })))

// 导航按分组排列（通用 → 助手 → 内容 → 隐私与数据 → 关于，W2 §3.2），组内顺序即展示顺序。
// 每个开关都落盘；没有只改页面状态的设置，也没有写死的示例数据（S6）。
const settingsData: SettingSection[] = [
  {
    id: 'appearance',
    group: 'general',
    title: '外观',
    icon: Palette,
    description: '主题与透明度',
    settings: []
  },
  { id: 'startup', group: 'general', title: '启动', icon: Sunrise, description: '打开 Ready 时先看到哪里', settings: [] },
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
    title: '模型',
    icon: Bot,
    description: '配置助手使用的模型和连接参数',
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
    id: 'skills',
    group: 'intelligence',
    title: '技能',
    icon: Puzzle,
    description: '导入、启用和管理助手的技能',
    settings: []
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
    id: MODELS_RUNTIME_SETTINGS_SECTION,
    group: 'intelligence',
    title: '本地语音模型',
    icon: Boxes,
    description: '按需下载语音识别与标点模型，支持国内 / 国外源自动切换与断点续传',
    settings: []
  },
  {
    id: 'remote-im',
    group: 'intelligence',
    title: '远程助手',
    icon: MessageSquare,
    description: '绑定微信、飞书，远程发送任务并接收回复',
    settings: [] // Rendered dynamically via RemoteIMSettingsPanel
  },
  {
    id: 'pet',
    group: 'intelligence',
    title: '宠物',
    icon: Cat,
    description: '管理桌面悬浮宠物和工作气泡',
    settings: []
  },
  {
    id: 'library',
    group: 'content',
    title: '资料库',
    icon: FolderOpen,
    description: '资料库位置、挂载的文件夹和全文索引',
    settings: []
  },
  { id: 'reading', group: 'content', title: '阅读', icon: HardDrive, description: '书源与下载，以及从藏书阁迁移', settings: [] },
  {
    id: 'rss-storage',
    group: 'content',
    title: '资讯',
    icon: Newspaper,
    description: '资讯的底稿仓库、增量收件箱和刷新重置',
    settings: []
  },
  {
    id: 'calendar',
    group: 'content',
    title: '日历',
    icon: CalendarDays,
    description: '日历视图、提醒、菜单栏与日历列表',
    settings: []
  },
  { id: 'browser', group: 'content', title: '浏览器', icon: Globe, description: '搜索引擎与地址栏建议', settings: [] },
  {
    id: 'browser-privacy',
    group: 'content',
    title: '浏览器数据',
    icon: Cookie,
    description: '清除浏览数据，管理 Cookie 与站点数据',
    settings: [] // Rendered dynamically via BrowserPrivacySettingsPanel
  },
  {
    id: 'external-services',
    group: 'content',
    title: '外部服务',
    icon: ExternalLink,
    description: '统一管理 AnySearch、Tavily、Jina、DuckDuckGo、RSSHub、Bilibili、GitHub、高德地图与读图模型',
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
    id: 'privacy',
    group: 'privacy',
    title: '隐私',
    icon: Shield,
    description: '管理 Ready 读取哪些活动来帮你',
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
    ]
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

function OptionTick() {
  return (
    <span className="sx-option__tick" aria-hidden>
      <Check />
    </span>
  )
}

// A small window in each theme: the pane takes that theme's own --rn-* values through data-theme.
function ThemeModePreview({ mode }: { mode: ThemeOption }) {
  const pane = (theme: 'light' | 'dark', split = false) => (
    <div data-theme={theme} className={`sx-theme-preview__pane ${split ? 'sx-theme-preview__pane--split' : ''}`.trim()}>
      <div className="sx-theme-preview__nav">
        {[0.9, 0.6, 0.75].map((w, index) => <span key={index} style={{ width: `${w * 100}%` }} />)}
      </div>
      <div className="sx-theme-preview__sheet">
        <span style={{ width: '46%' }} />
        <span style={{ width: '80%' }} />
        <span style={{ width: '64%' }} />
        <i />
      </div>
    </div>
  )
  return (
    <div className="sx-theme-preview" aria-hidden>
      {pane(mode === 'dark' ? 'dark' : 'light')}
      {mode === 'system' && pane('dark', true)}
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
            {alternative.split(' + ').map((key) => <Kbd key={key}>{key}</Kbd>)}
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
  const [activeSection, setActiveSection] = useState(initialSection || routeSection || 'appearance')
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
    ? ['startup', 'ai', 'memory', 'skills', 'remote-im', 'external-services', 'mcp', 'tag-forge', 'pet', 'library', 'reading', 'rss-storage', 'calendar', MODELS_RUNTIME_SETTINGS_SECTION, 'storage', 'browser', 'browser-privacy'].includes(currentSection.id)
    : false

  const renderSettingControl = (sectionId: string, setting: SettingItem) => {
    const isUpdateButton = sectionId === 'about' && setting.id === 'checkUpdate'
    switch (setting.type) {
      case 'toggle':
        return (
          <Switch
            checked={Boolean(setting.value)}
            label={setting.label}
            onChange={() => { void handleToggleSetting(sectionId, setting) }}
          />
        )
      case 'readonly':
        return sectionId === 'shortcuts'
          ? <ShortcutKeys value={String(setting.value ?? '')} />
          : <span className="sx-value">{setting.value}</span>
      case 'button':
        return (
          <Button
            onClick={() => {
              if (isUpdateButton) void handleUpdateButtonClick()
            }}
            disabled={isUpdateButton && updateBusy}
            aria-busy={isUpdateButton && updateBusy ? true : undefined}
            variant={setting.buttonVariant === 'primary' ? 'primary' : setting.buttonVariant === 'danger' ? 'danger' : 'secondary'}
            style={{ minWidth: 104 }}
            icon={isUpdateButton && updateBusy
              ? <Loader2 className="animate-spin" />
              : isUpdateButton && updateStatus !== 'downloaded' ? <RefreshCw /> : undefined}
          >
            {isUpdateButton ? updateButtonLabel : setting.buttonLabel || '执行'}
          </Button>
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
    <div className="settings-page-shell rn-ui flex h-full flex-col overflow-hidden">
      {/* 顶部一条带（--rn-band-h），左侧为 macOS 红绿灯留 72px；与技能中心同一外框 */}
      <header data-liquid-shell="settings-header" className="settings-page__header drag-region">
        <Button className="no-drag" variant="ghost" size="sm" icon={<ChevronLeft strokeWidth={2} />} onClick={() => navigate('/')}>
          返回
        </Button>
        <h1 className="settings-page__title">设置</h1>
      </header>

      <div className="settings-page__body">
        {/* 导航落在窗口玻璃上：分组标题是 SectionHeader，分区是 ListRow（W1 §5） */}
        <nav
          aria-label="设置分区"
          data-liquid-shell="settings-sidebar"
          className="settings-page__nav panel-hover-scrollbar"
          onMouseMove={handleSettingsSurfaceMotion}
          onScroll={handleSettingsSurfaceScroll}
          onMouseLeave={scheduleSettingsSurfaceRefresh}
        >
          {SETTINGS_NAV_GROUP_ORDER.map((group) => (
            <div key={group} className="sx-nav-group">
              <SectionHeader className="sx-nav-group-label" title={SETTINGS_NAV_GROUP_LABELS[group]} />
              {settings.filter((section) => section.group === group).map((section) => {
                const Icon = section.icon
                return (
                  <ListRow
                    key={section.id}
                    className="sx-nav-item"
                    icon={<Icon />}
                    label={section.title}
                    current={activeSection === section.id}
                    title={section.description}
                    onClick={() => setActiveSection(section.id)}
                  />
                )
              })}
            </div>
          ))}

          <div className="sx-meta mt-4 px-3">
            {READY_VERSION_LABEL} · Electron {ELECTRON_MAJOR_VERSION}
          </div>
        </nav>

        {/* 内容直接落在窗口玻璃上；每组设置是一张纸 */}
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
                    <div style={{ padding: '0 4px', marginBottom: 24 }}>
                      <h2 className="settings-page__section-title">{currentSection.title}</h2>
                      <p className="settings-page__section-desc">{currentSection.description}</p>
                    </div>

                {/* AI Settings Panel — dynamic, wired to backend */}
                {currentSection.id === 'startup' && <StartupSettingsPanel />}
                {currentSection.id === 'ai' && <AISettingsPanel />}
                {currentSection.id === 'memory' && <ReadyMemorySettingsPanel />}
                {currentSection.id === 'reading' && <ReadingSettingsPanel />}
                {currentSection.id === 'rss-storage' && <RSSDraftStoreSettingsPanel />}
                {currentSection.id === MODELS_RUNTIME_SETTINGS_SECTION && <ModelsRuntimeSettingsPanel />}
                {currentSection.id === 'storage' && <StorageSettingsPanel />}
                {currentSection.id === 'browser' && <BrowserSearchSettingsPanel />}
                {currentSection.id === 'browser-privacy' && <BrowserPrivacySettingsPanel />}
                {currentSection.id === 'remote-im' && <RemoteIMSettingsPanel />}
                {currentSection.id === 'external-services' && <ExternalServicesSettingsPanel />}
                {currentSection.id === 'mcp' && <McpSettingsPanel />}
                {currentSection.id === 'pet' && <PetSettingsPanel />}
                {currentSection.id === 'tag-forge' && <TagForgeSettingsPanel />}
                {currentSection.id === 'library' && <LibrarySettingsPanel />}
                {currentSection.id === 'calendar' && <Suspense fallback={null}><CalendarSettingsPanel /></Suspense>}
                {currentSection.id === 'skills' && (
                  <SettingsCard title="技能中心" description="技能属于助手：导入、启用、授权本地执行，都在技能中心整页里做。">
                    <SettingsRow label="打开技能中心" description="也可以从助手面板顶部或 ⌘K 进入">
                      <Button size="sm" onClick={() => navigate('/skills')}>打开</Button>
                    </SettingsRow>
                  </SettingsCard>
                )}

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
                                <OptIcon className="h-[14px] w-[14px]" strokeWidth={1.75} style={{ color: isActive ? 'var(--rn-ink)' : 'var(--rn-ink-2)' }} />
                                <span className="text-[13px]" style={{ color: 'var(--rn-ink)', fontWeight: isActive ? 600 : 500 }}>{opt.label}</span>
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
                          <Switch checked={reduceTransparency} label="减少透明" onChange={setReduceTransparency} />
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
                      style={{ background: 'var(--rn-sheet)', boxShadow: 'var(--rn-card-shadow)' }}
                    >
                      <ReadyDotRMark />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[18px] font-semibold tracking-[-0.01em]" style={{ color: 'var(--rn-ink)' }}>Ready</div>
                      <p className="mt-0.5 text-[12.5px] leading-6" style={{ color: 'var(--rn-ink-2)' }}>
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
                {currentSection.id === 'about' && <ThirdPartyNoticesPanel />}
              </>
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
