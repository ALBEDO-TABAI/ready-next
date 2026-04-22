export type CapabilityGroupId =
  | 'browser_interaction'
  | 'browser_content_tasks'
  | 'document'
  | 'file_management'
  | 'rss'
  | 'calendar'
  | 'skills'
  | 'memory'
  | 'session_recall'
  | 'channel_feishu'
  | 'system_host'
  | 'design_reserved'

export type CapabilityProfileId =
  | 'local_chat'
  | 'remote_channel'
  | 'scheduled_run'
  | 'embedded_workflow'

export type CapabilityExposure = 'model_visible' | 'host_only' | 'ui_visible_only'
export type CapabilityAvailability = 'active' | 'inactive'
export type CapabilityMode = 'auto' | 'on' | 'off'

export interface CapabilityGroupDefinition {
  id: CapabilityGroupId
  label: string
  description: string
  exposure: CapabilityExposure
  availability: CapabilityAvailability
  defaultMode: CapabilityMode
  defaultProfiles: CapabilityProfileId[]
  executionKinds: Array<'interactive' | 'deterministic' | 'job' | 'pipeline' | 'hosted'>
  settingsVisible: boolean
}

export const CAPABILITY_GROUPS: CapabilityGroupDefinition[] = [
  {
    id: 'browser_interaction',
    label: '浏览器交互',
    description: '页面导航、点击、输入、截图和等待等即时网页操作。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'embedded_workflow'],
    executionKinds: ['interactive'],
    settingsVisible: true,
  },
  {
    id: 'browser_content_tasks',
    label: '浏览器内容任务',
    description: '结构化提取、滚动采集、下载和研究类网页任务。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'scheduled_run', 'embedded_workflow'],
    executionKinds: ['pipeline', 'job'],
    settingsVisible: true,
  },
  {
    id: 'document',
    label: '文档',
    description: '文稿读写、替换、组件更新和保存。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'embedded_workflow'],
    executionKinds: ['deterministic', 'interactive'],
    settingsVisible: true,
  },
  {
    id: 'file_management',
    label: '文件管理',
    description: '跨源搜索（文档 / RSS / 书签 / 日程 / 会话）、反向链接、定位、分类与重命名。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'embedded_workflow'],
    executionKinds: ['deterministic'],
    settingsVisible: true,
  },
  {
    id: 'rss',
    label: 'RSS',
    description: '订阅源管理、更新抓取和内容分析。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'scheduled_run'],
    executionKinds: ['deterministic', 'pipeline'],
    settingsVisible: false,
  },
  {
    id: 'calendar',
    label: '日程',
    description: '日历事件查询、创建、更新和删除。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'scheduled_run'],
    executionKinds: ['deterministic'],
    settingsVisible: false,
  },
  {
    id: 'skills',
    label: '技能',
    description: '启动技能和继续宿主管理的技能执行。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'scheduled_run', 'embedded_workflow'],
    executionKinds: ['interactive', 'pipeline'],
    settingsVisible: true,
  },
  {
    id: 'memory',
    label: '记忆',
    description: '长期记忆读写与维护。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'scheduled_run'],
    executionKinds: ['deterministic'],
    settingsVisible: true,
  },
  {
    id: 'session_recall',
    label: '会话回看',
    description: '搜索历史会话并把旧上下文重新带回当前轮。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'scheduled_run'],
    executionKinds: ['deterministic'],
    settingsVisible: true,
  },
  {
    id: 'channel_feishu',
    label: '飞书渠道',
    description: '飞书消息、文档、日历和文件相关能力。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel'],
    executionKinds: ['deterministic', 'interactive'],
    settingsVisible: true,
  },
  {
    id: 'system_host',
    label: '宿主内部',
    description: '只允许宿主受控调用的高风险内部能力。',
    exposure: 'host_only',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel', 'scheduled_run', 'embedded_workflow'],
    executionKinds: ['hosted', 'deterministic'],
    settingsVisible: false,
  },
  {
    id: 'design_reserved',
    label: '设计保留位',
    description: '当前只用于封住遗留设计能力名，不对模型开放。',
    exposure: 'ui_visible_only',
    availability: 'inactive',
    defaultMode: 'off',
    defaultProfiles: [],
    executionKinds: ['hosted'],
    settingsVisible: false,
  },
]

const CAPABILITY_GROUP_INDEX = new Map(CAPABILITY_GROUPS.map((group) => [group.id, group]))

export function getCapabilityGroup(id: CapabilityGroupId): CapabilityGroupDefinition | null {
  return CAPABILITY_GROUP_INDEX.get(id) || null
}

export function listCapabilityGroups(): CapabilityGroupDefinition[] {
  return [...CAPABILITY_GROUPS]
}

export function listSettingsCapabilityGroups(): CapabilityGroupDefinition[] {
  return CAPABILITY_GROUPS.filter((group) => group.settingsVisible)
}

export type CapabilityModeMap = Partial<Record<CapabilityGroupId, CapabilityMode>>

export function normalizeCapabilityMode(value: unknown): CapabilityMode | undefined {
  return value === 'auto' || value === 'on' || value === 'off' ? value : undefined
}

export function normalizeCapabilityModeMap(value: unknown): CapabilityModeMap {
  if (!value || typeof value !== 'object') return {}

  const normalized: CapabilityModeMap = {}
  for (const group of CAPABILITY_GROUPS) {
    const raw = (value as Record<string, unknown>)[group.id]
    const mode = normalizeCapabilityMode(raw)
    if (mode) normalized[group.id] = mode
  }
  return normalized
}
