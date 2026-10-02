import type { ThemeOption, ThemeSkin } from '../stores/useTheme'
import type { AIModelConfig, AIProviderWorkspace } from '../../shared/ai-providers'
import { previewNamespaces as aiPreview } from './settings-preview/ai'
import { previewNamespaces as browserPrivacyPreview } from './settings-preview/browser-privacy'
import { previewNamespaces as externalServicesPreview } from './settings-preview/external-services'
import { previewNamespaces as mcpPreview } from './settings-preview/mcp'
import { previewNamespaces as memoryPreview } from './settings-preview/memory'
import { previewNamespaces as modelsRuntimePreview } from './settings-preview/models-runtime'
import { previewNamespaces as petPreview } from './settings-preview/pet'
import { previewNamespaces as remoteImPreview } from './settings-preview/remote-im'
import { previewNamespaces as rssDraftStorePreview } from './settings-preview/rss-draft-store'
import { previewNamespaces as storagePreview } from './settings-preview/storage'

const PANEL_PREVIEW_NAMESPACES = [
  aiPreview,
  browserPrivacyPreview,
  externalServicesPreview,
  mcpPreview,
  memoryPreview,
  modelsRuntimePreview,
  petPreview,
  remoteImPreview,
  rssDraftStorePreview,
  storagePreview,
]

type Success<T> = Promise<{ success: true; data: T }>
type SuccessNoData = Promise<{ success: true }>

interface MockPersonality {
  id: string
  agentName: string
  displayName?: string
  personalityText: string
  tone?: string
  createdAt: number
  updatedAt: number
}

interface MockUserProfile {
  id: string
  name?: string
  avatarUrl?: string
  preferredLanguage: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

const now = Date.now()

const mockAIConfig: AIModelConfig = {
  provider: 'moonshot',
  baseUrl: 'https://api.moonshot.cn/v1',
  apiKey: 'preview',
  model: 'kimi-k2-0905-preview',
  displayName: 'Kimi 代码主力',
  agentProtocol: 'openai',
  wireApi: 'responses',
  reasoningEffort: 'high',
  toolUseMode: 'on',
  visionMode: 'on',
  nativeVideoMode: 'auto',
}

const mockAIWorkspace: AIProviderWorkspace = {
  version: 1,
  activeProfileId: 'custom-kimi-preview',
  profiles: [
    {
      id: 'builtin-openai',
      category: 'openai',
      name: 'OpenAI',
      builtIn: true,
      showInChatSwitcher: true,
      config: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai-preview',
        model: 'gpt-5',
        displayName: 'OpenAI',
        agentProtocol: 'openai',
        wireApi: 'responses',
        reasoningEffort: 'high',
        toolUseMode: 'on',
        visionMode: 'on',
        nativeVideoMode: 'auto',
      },
    },
    {
      id: 'builtin-anthropic',
      category: 'anthropic',
      name: 'Anthropic',
      builtIn: true,
      showInChatSwitcher: true,
      config: {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-preview',
        model: 'claude-sonnet-4-5',
        displayName: 'Anthropic',
        agentProtocol: 'anthropic',
        reasoningEffort: 'medium',
        toolUseMode: 'on',
        visionMode: 'on',
        nativeVideoMode: 'auto',
      },
    },
    {
      id: 'builtin-gemini',
      category: 'gemini',
      name: 'Gemini',
      builtIn: true,
      showInChatSwitcher: true,
      config: {
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: 'AIza-preview',
        model: 'gemini-2.5-pro',
        displayName: 'Gemini',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        reasoningEffort: 'medium',
        toolUseMode: 'on',
        visionMode: 'on',
        nativeVideoMode: 'auto',
      },
    },
    {
      id: 'custom-kimi-preview',
      category: 'custom',
      name: 'Kimi 代码主力',
      builtIn: false,
      showInChatSwitcher: true,
      config: mockAIConfig,
    },
  ],
}

let currentAIConfig: AIModelConfig = mockAIConfig
let currentAIWorkspace: AIProviderWorkspace = mockAIWorkspace
let mockRSSDraftSources = [
  {
    sourceId: 'rss-yingshi',
    sourceName: '影视飓风的个人空间',
    sourceUrl: 'https://space.bilibili.com/946974',
    platform: 'bilibili',
    storedCount: 20,
    inboxCount: 20,
    starredCount: 0,
    refreshMode: 'incremental',
    lastFetchedAt: new Date(now - 1000 * 60 * 24).toISOString(),
  },
  {
    sourceId: 'rss-hacker-news',
    sourceName: 'Hacker News',
    sourceUrl: 'https://news.ycombinator.com/rss',
    platform: 'rss',
    storedCount: 30,
    inboxCount: 30,
    starredCount: 0,
    refreshMode: 'incremental',
    lastFetchedAt: new Date(now - 1000 * 60 * 41).toISOString(),
  },
  {
    sourceId: 'rss-mediastore',
    sourceName: '飓风商店 MediaStore 的个人空间',
    sourceUrl: 'https://space.bilibili.com/700634784',
    platform: 'bilibili',
    storedCount: 12,
    inboxCount: 12,
    starredCount: 0,
    refreshMode: 'incremental',
    lastFetchedAt: new Date(now - 1000 * 60 * 68).toISOString(),
  },
  {
    sourceId: 'rss-xiaohongshu',
    sourceName: '广州潮会吃 · 小红书',
    sourceUrl: 'https://www.xiaohongshu.com/user/profile/5e31b69300000000100bb06',
    platform: 'xiaohongshu',
    storedCount: 32,
    inboxCount: 2,
    starredCount: 0,
    refreshMode: 'incremental',
    lastFetchedAt: new Date(now - 1000 * 60 * 120).toISOString(),
  },
  {
    sourceId: 'rss-foodlog',
    sourceName: '赛博食录的个人空间',
    sourceUrl: 'https://space.bilibili.com/1937308559',
    platform: 'bilibili',
    storedCount: 0,
    inboxCount: 0,
    starredCount: 0,
    refreshMode: 'full',
    lastFetchedAt: null,
  },
]

const settingsStore = new Map<string, string>([
  ['ai_provider_workspace', JSON.stringify(mockAIWorkspace)],
  ['ai_saved_configs', JSON.stringify({
    moonshot: mockAIConfig,
    openai: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai-preview',
      model: 'gpt-5',
      displayName: 'GPT-5',
      agentProtocol: 'openai',
      wireApi: 'responses',
      reasoningEffort: 'high',
      toolUseMode: 'on',
      visionMode: 'on',
      nativeVideoMode: 'auto',
    },
    anthropic: {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-preview',
      model: 'claude-sonnet-4-5',
      displayName: 'Claude Sonnet',
      agentProtocol: 'anthropic',
      reasoningEffort: 'medium',
      toolUseMode: 'on',
      visionMode: 'on',
      nativeVideoMode: 'auto',
    },
  })],
  ['remote_channels_enabled', 'true'],
  ['sidecar_autostart', 'true'],
  ['sidecar_bind_host', '127.0.0.1'],
  ['sidecar_bind_port', '8765'],
])

let channelData = [
  {
    id: 'channel-feishu-default',
    type: 'feishu-app',
    name: '飞书主通道',
    enabled: true,
    config: {
      appId: 'cli_preview_123',
    },
    credentialState: 'ready' as const,
    secretStatus: {
      appSecret: { configured: true, state: 'ready' as const },
      verificationToken: { configured: true, state: 'ready' as const },
    },
    lastSeenAt: new Date(now - 1000 * 60 * 5).toISOString(),
  },
  {
    id: 'channel-telegram-default',
    type: 'telegram-bot',
    name: 'Telegram Bot',
    enabled: true,
    config: {},
    credentialState: 'ready' as const,
    secretStatus: { token: { configured: true, state: 'ready' as const } },
    lastSeenAt: new Date(now - 1000 * 60 * 12).toISOString(),
  },
]

let memoryEntries = Array.from({ length: 7 }).map((_, index) => ({
  id: `memory-${index + 1}`,
  scopeId: index % 2 === 0 ? 'conversation:kimi:thread-112' : 'global',
  contentKey: `note-${index + 1}`,
  layer: index % 3 === 0 ? 'l2' : index % 2 === 0 ? 'l1' : 'l0',
  category: index % 3 === 0 ? 'trigger' : index % 2 === 0 ? 'learning' : 'summary',
  title: [
    '用户偏好偏简洁回复，但关键结论必须先给',
    '浏览器任务提交前必须确认页面进入运行态',
    '创作型文案更喜欢高信息密度的段首',
    '视频分析默认走字幕抽取再二次总结',
    '用户对设置页视觉一致性特别敏感',
    '飞书附件只进资源层，不直接触发 agent',
    '日历任务更偏向时间轴视图而不是列表视图',
  ][index],
  summary: '这是一条用于预览设置页视觉密度的示例记忆，重点观察标签、行高、信息层级与卡片间距。',
  priority: (index % 5) + 1,
  accessCount: 5 + index * 3,
  archivedAt: index === 5 ? now / 1000 - 86400 * 7 : null,
  lastAccessedAt: now / 1000 - index * 3600 * 6,
  createdAt: now / 1000 - 86400 * (index + 3),
  updatedAt: now / 1000 - 3600 * (index + 1),
  expiresAt: index === 6 ? now / 1000 + 86400 * 45 : null,
  tags: ['ui', 'settings', index % 2 === 0 ? 'design' : 'workflow'],
}))

let activeChildRuns = [
  {
    childRunId: 'vea-preview-1',
    skillId: 'video-expert-analyzer',
    sessionId: 'conversation:kimi:thread-112',
    scopeId: 'conversation:kimi:thread-112',
    status: 'running',
    startedAt: new Date(now - 1000 * 60 * 4).toISOString(),
    outputDir: '/tmp/ready-preview/video-expert/run-1',
    runStatePath: '/tmp/ready-preview/video-expert/run-1/run_state.json',
  },
]

const triggerDefinitions = [
  {
    id: 'trigger-1',
    label: '设置页设计审查',
    pattern: '设置|视觉|排版|字号',
    patternFlags: 'i',
    priority: 90,
    hitCount: 14,
    lastHitAt: now / 1000 - 3600 * 8,
    enabled: true,
    blocking: true,
    module: 'design-review',
  },
  {
    id: 'trigger-2',
    label: '浏览器上传型任务',
    pattern: '上传|附件|提交',
    patternFlags: 'i',
    priority: 78,
    hitCount: 31,
    lastHitAt: now / 1000 - 3600 * 24,
    enabled: true,
    blocking: false,
    module: 'browser-agent',
  },
  {
    id: 'trigger-3',
    label: '远程 IM 运维',
    pattern: '飞书|Telegram|Channel',
    patternFlags: 'i',
    priority: 54,
    hitCount: 8,
    lastHitAt: now / 1000 - 3600 * 36,
    enabled: false,
    blocking: false,
    module: 'remote-im',
  },
]

let personalities: MockPersonality[] = [
  {
    id: 'personality-browser',
    agentName: 'browser',
    displayName: 'Browser Planner',
    personalityText: '先理解任务，再给出计划，执行时只按计划推进，不在中途随意换方向。',
    tone: 'professional',
    createdAt: now / 1000 - 86400 * 30,
    updatedAt: now / 1000 - 3600 * 12,
  },
  {
    id: 'personality-designer',
    agentName: 'designer',
    displayName: 'Design Critic',
    personalityText: '对留白、比例、字重和层级非常敏感，强调系统性和克制，不接受临时拼贴感。',
    tone: 'technical',
    createdAt: now / 1000 - 86400 * 12,
    updatedAt: now / 1000 - 3600 * 4,
  },
]

let userProfiles: MockUserProfile[] = [
  {
    id: 'default-user',
    name: 'Maijiahui',
    avatarUrl: '',
    preferredLanguage: 'zh',
    communicationStyle: 'detailed',
    createdAt: now / 1000 - 86400 * 120,
    updatedAt: now / 1000 - 3600 * 8,
  },
  {
    id: 'creator-mode',
    name: '内容创作模式',
    avatarUrl: '',
    preferredLanguage: 'zh',
    communicationStyle: 'friendly',
    createdAt: now / 1000 - 86400 * 30,
    updatedAt: now / 1000 - 3600 * 3,
  },
]

function success<T>(data: T): Success<T> {
  return Promise.resolve({ success: true, data })
}

function successNoData(): SuccessNoData {
  return Promise.resolve({ success: true })
}

function applyPreviewTheme(previewUrl: URL): void {
  const theme = (previewUrl.searchParams.get('theme') || 'light') as ThemeOption
  const skin = (previewUrl.searchParams.get('skin') || 'liquid-glass') as ThemeSkin
  localStorage.setItem('ready-theme', theme)
  localStorage.setItem('ready-theme-skin', skin)
}

export function installSettingsPreviewMocks(): void {
  const previewUrl = new URL(window.location.href)
  applyPreviewTheme(previewUrl)
  const option = (localStorage.getItem('ready-theme') || 'light') as ThemeOption
  const resolved = option === 'system' ? 'light' : option
  const skin = (localStorage.getItem('ready-theme-skin') || 'liquid-glass') as ThemeSkin

  const api = {
    theme: {
      get: async () => ({
        success: true,
        data: {
          option,
          resolved,
          skin,
          isNativeFullscreen: false,
        },
      }),
      set: async () => undefined,
    },
    app: {
      onShortcut: () => () => undefined,
    },
    settings: {
      get: async (key: string) => ({ success: true, data: settingsStore.get(key) ?? null }),
      set: async (key: string, value: string) => {
        settingsStore.set(key, value)
        return { success: true }
      },
      getAll: async () => ({ success: true, data: Object.fromEntries(settingsStore.entries()) }),
      getAIConfig: async () => ({ success: true, data: currentAIConfig }),
      getAIWorkspace: async () => ({ success: true, data: currentAIWorkspace }),
      setAIConfig: async (config: AIModelConfig) => {
        currentAIConfig = config
        settingsStore.set('ai_model_config', JSON.stringify(config))
        return { success: true }
      },
      setAIWorkspace: async (workspace: AIProviderWorkspace) => {
        currentAIWorkspace = workspace
        const activeProfile = workspace.profiles.find((profile) => profile.id === workspace.activeProfileId)
        if (activeProfile) {
          currentAIConfig = activeProfile.config
          settingsStore.set('ai_model_config', JSON.stringify(activeProfile.config))
        }
        settingsStore.set('ai_provider_workspace', JSON.stringify(workspace))
        return { success: true }
      },
      testAIConnection: async () => ({
        success: true,
        data: {
          latencyMs: 142,
          modelList: ['kimi-k2-0905-preview', 'kimi-thinking-preview'],
        },
      }),
    },
    agent: {
      onStream: () => () => undefined,
      onStatusChange: () => () => undefined,
      onError: () => () => undefined,
      onToolAction: () => () => undefined,
      onToolActionRequest: () => () => undefined,
      onScopeRunEvent: () => () => undefined,
      onConversationEvent: () => () => undefined,
      completeToolActionRequest: async () => undefined,
      listActiveChildRuns: async () => ({ success: true, data: activeChildRuns }),
      cancelChildRun: async (childRunId: string) => {
        activeChildRuns = activeChildRuns.filter((run) => run.childRunId !== childRunId)
        return { success: true, data: { childRunId, status: 'killed' } }
      },
      listChannels: async () => ({ success: true, data: channelData }),
      getRuntimeStatus: async () => ({
        success: true,
        data: {
          orchestrator: 'codex-native',
          sidecar: {
            status: 'running',
            port: 8765,
          },
          channels: {
            total: channelData.length,
          },
          heartbeat: {
            orchestrator: {
              activeTasks: 2,
            },
            adapters: channelData.map((channel, index) => ({
              id: channel.id,
              type: channel.type,
              status: channel.enabled ? 'running' : 'stopped',
              healthy: channel.enabled,
              lastBeatAt: new Date(now - index * 1000 * 60 * 8).toISOString(),
            })),
          },
        },
      }),
      getCapabilityRuntimeSnapshot: async () => ({
        success: true,
        data: {
          generatedAt: new Date(now).toISOString(),
          profile: 'local_chat',
          environment: {
            browserHostAvailable: true,
            feishuConnected: true,
            enabledChannelTypes: ['feishu-app', 'telegram-bot'],
            connectedChannelTypes: ['feishu-app'],
          },
          groups: {
            browser_interaction: {
              id: 'browser_interaction',
              label: '浏览器交互',
              description: '页面导航、点击、输入、截图和等待等即时网页操作。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: true,
              hasDynamicSource: false,
              toolCount: 25,
            },
            browser_content_tasks: {
              id: 'browser_content_tasks',
              label: '浏览器内容任务',
              description: '结构化提取、滚动采集、下载和研究类网页任务。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'closed',
              reason: 'profile_disabled',
              settingsVisible: true,
              hasDynamicSource: false,
              toolCount: 13,
            },
            document: {
              id: 'document',
              label: '文档',
              description: '文稿读写、替换、组件更新和保存。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: true,
              hasDynamicSource: false,
              toolCount: 15,
            },
            rss: {
              id: 'rss',
              label: 'RSS',
              description: '订阅源管理、更新抓取和内容分析。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: false,
              hasDynamicSource: false,
              toolCount: 5,
            },
            calendar: {
              id: 'calendar',
              label: '日程',
              description: '日历事件查询、创建、更新和删除。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: false,
              hasDynamicSource: false,
              toolCount: 5,
            },
            skills: {
              id: 'skills',
              label: '技能',
              description: '启动技能和继续宿主管理的技能执行。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: true,
              hasDynamicSource: true,
              toolCount: 8,
            },
            memory: {
              id: 'memory',
              label: '记忆',
              description: '长期记忆读写与维护。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: true,
              hasDynamicSource: false,
              toolCount: 4,
            },
            session_recall: {
              id: 'session_recall',
              label: '会话回看',
              description: '搜索历史会话并把旧上下文重新带回当前轮。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: true,
              hasDynamicSource: false,
              toolCount: 1,
            },
            channel_feishu: {
              id: 'channel_feishu',
              label: '飞书渠道',
              description: '飞书消息、文档、日历和文件相关能力。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: true,
              hasDynamicSource: false,
              toolCount: 16,
            },
            general_research: {
              id: 'general_research',
              label: '研究工具',
              description: '网络搜索、网页抓取、产物呈现等系统化研究工具。',
              exposure: 'model_visible',
              mode: 'auto',
              status: 'available',
              reason: 'enabled',
              settingsVisible: true,
              hasDynamicSource: false,
              toolCount: 0,
            },
            system_host: {
              id: 'system_host',
              label: '宿主内部',
              description: '只允许宿主受控调用的高风险内部能力。',
              exposure: 'host_only',
              mode: 'auto',
              status: 'host_only',
              reason: 'host_only',
              settingsVisible: false,
              hasDynamicSource: false,
              toolCount: 2,
            },
            design_reserved: {
              id: 'design_reserved',
              label: '设计保留位',
              description: '当前只用于封住遗留设计能力名，不对模型开放。',
              exposure: 'ui_visible_only',
              mode: 'off',
              status: 'inactive',
              reason: 'inactive',
              settingsVisible: false,
              hasDynamicSource: false,
              toolCount: 0,
            },
          },
        },
      }),
      getRemoteAttachmentCacheStats: async () => ({
        success: true,
        data: {
          totalFiles: 27,
          totalBytes: 1024 * 1024 * 184,
          targetPath: '/tmp/ready-remote-cache',
          channels: [
            { channelId: 'channel-feishu-default', files: 16, bytes: 1024 * 1024 * 124 },
            { channelId: 'channel-telegram-default', files: 11, bytes: 1024 * 1024 * 60 },
          ],
        },
      }),
      testChannel: async () => ({ success: true, data: { ok: true } }),
      upsertChannel: async (payload: typeof channelData[number]) => {
        const existing = channelData.findIndex((item) => item.id === payload.id)
        if (existing >= 0) {
          channelData[existing] = payload
        } else {
          channelData = [...channelData, payload]
        }
        return { success: true }
      },
      setChannelEnabled: async (id: string, enabled: boolean) => {
        channelData = channelData.map((channel) => channel.id === id ? { ...channel, enabled } : channel)
        return { success: true }
      },
      deleteChannel: async (id: string) => {
        channelData = channelData.filter((channel) => channel.id !== id)
        return { success: true }
      },
      sendChannelProbe: async () => ({ success: true }),
      clearRemoteAttachmentCache: async () => ({ success: true }),
    },
    rss: {
      getDraftStoreSources: async () => ({ success: true, data: mockRSSDraftSources }),
      clearDraftStore: async (payload?: { sourceId?: string }) => {
        let deletedItems = 0
        if (payload?.sourceId) {
          mockRSSDraftSources = mockRSSDraftSources.map((source) => {
            if (source.sourceId !== payload.sourceId) return source
            deletedItems = source.storedCount
            return { ...source, storedCount: 0, inboxCount: 0, refreshMode: 'full' }
          })
        } else {
          deletedItems = mockRSSDraftSources.reduce((total, source) => total + source.storedCount, 0)
          mockRSSDraftSources = mockRSSDraftSources.map((source) => ({
            ...source,
            storedCount: 0,
            inboxCount: 0,
            refreshMode: 'full',
          }))
        }
        return {
          success: true,
          data: {
            deletedItems,
            resetSources: payload?.sourceId ? 1 : mockRSSDraftSources.length,
          },
        }
      },
    },
    memory: {
      query: async () => ({ success: true, data: memoryEntries }),
      create: async (entry: Record<string, unknown>) => {
        const next = { ...entry, id: `memory-${memoryEntries.length + 1}` }
        memoryEntries = [next as typeof memoryEntries[number], ...memoryEntries]
        return { success: true, data: next }
      },
      update: async (id: string, updates: Record<string, unknown>) => {
        memoryEntries = memoryEntries.map((item) => item.id === id ? { ...item, ...updates } : item)
        return { success: true }
      },
      delete: async (id: string) => {
        memoryEntries = memoryEntries.filter((item) => item.id !== id)
        return { success: true }
      },
      stats: async () => ({
        success: true,
        data: {
          totalMemories: 182,
          byLayer: { l0: 56, l1: 84, l2: 42 },
          byCategory: { summary: 67, learning: 51, trigger: 39, rule: 25 },
          archivedCount: 18,
          avgAccessCount: 7.6,
        },
      }),
      createFromConversation: async () => ({
        success: true,
        data: { memoryId: `memory-${memoryEntries.length + 1}` },
      }),
    },
    trigger: {
      list: async () => ({ success: true, data: triggerDefinitions }),
      create: async (trigger: Record<string, unknown>) => success(trigger),
      update: async (id: string, updates: Record<string, unknown>) => {
        const index = triggerDefinitions.findIndex((trigger) => trigger.id === id)
        if (index >= 0) {
          triggerDefinitions[index] = { ...triggerDefinitions[index], ...updates }
        }
        return { success: true }
      },
    },
    memoryLifecycle: {
      status: async () => ({
        success: true,
        data: {
          running: true,
          lastMaintenanceAt: new Date(now - 1000 * 60 * 38).toISOString(),
        },
      }),
      runMaintenance: async () => ({
        success: true,
        data: {
          archivedCount: 4,
          prunedCount: 2,
        },
      }),
    },
    agentPersonality: {
      list: async () => ({ success: true, data: personalities }),
      get: async (agentName: string) => ({ success: true, data: personalities.find((item) => item.agentName === agentName) || null }),
      create: async (payload: Omit<MockPersonality, 'id' | 'createdAt' | 'updatedAt'>) => {
        personalities = [
          ...personalities,
          { ...payload, id: `personality-${payload.agentName}`, createdAt: now / 1000, updatedAt: now / 1000 },
        ]
        return { success: true }
      },
      update: async (agentName: string, payload: Partial<MockPersonality>) => {
        personalities = personalities.map((item) => item.agentName === agentName ? { ...item, ...payload, updatedAt: now / 1000 } : item)
        return { success: true }
      },
      delete: async (agentName: string) => {
        personalities = personalities.filter((item) => item.agentName !== agentName)
        return { success: true }
      },
    },
    userProfile: {
      list: async () => ({ success: true, data: userProfiles }),
      get: async (id: string) => ({ success: true, data: userProfiles.find((item) => item.id === id) || null }),
      update: async (id: string, payload: Partial<MockUserProfile>) => {
        userProfiles = userProfiles.map((item) => item.id === id ? { ...item, ...payload, updatedAt: now / 1000 } : item)
        return { success: true }
      },
      delete: async (id: string) => {
        userProfiles = userProfiles.filter((item) => item.id !== id)
        return { success: true }
      },
    },
  }

  window.alert = () => undefined
  window.confirm = () => true
  window.prompt = (_message?: string, defaultValue = '') => defaultValue || 'preview-item'
  const merged: Record<string, Record<string, unknown>> = { ...(api as unknown as Record<string, Record<string, unknown>>) }
  for (const namespaces of PANEL_PREVIEW_NAMESPACES) {
    for (const [name, methods] of Object.entries(namespaces)) {
      merged[name] = { ...(merged[name] || {}), ...methods }
    }
  }
  Object.assign(window, { electronAPI: withPreviewFallback(merged) })
}

// 预览只为设置页准备了真数据；主壳与其他面板新增的 IPC 走兜底：
// on* 订阅返回退订函数，其余调用返回空成功，避免预览因缺桩白屏。
function previewFallbackMethod(name: string) {
  return /^on[A-Z]/.test(name)
    ? () => () => undefined
    : async () => ({ success: true, data: null })
}

function withPreviewFallback<T extends object>(target: T, depth = 0): T {
  return new Proxy(target, {
    get(source, key, receiver) {
      if (typeof key !== 'string' || Reflect.has(source, key)) {
        const value = Reflect.get(source, key, receiver)
        return depth === 0 && value && typeof value === 'object' ? withPreviewFallback(value, 1) : value
      }
      if (key === 'then') return undefined
      return depth === 0 ? withPreviewFallback({}, 1) : previewFallbackMethod(key)
    },
  })
}
