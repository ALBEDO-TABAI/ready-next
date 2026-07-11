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
  | 'pet'
  | 'channel_feishu'
  | 'general_research'
  | 'map_planning'
  | 'system_host'
  | 'design_reserved'
  | 'mcp'
  | 'agent_interaction'
  | 'skill_install'
  | 'skill_activation'
  | 'channel_outbound'
  | 'mcp_install'
  | 'command_exec'

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
    id: 'pet',
    label: '宠物便利贴',
    description: '把简短信息贴到桌面宠物旁边，或清理宠物便利贴。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat'],
    executionKinds: ['deterministic'],
    settingsVisible: false,
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
    id: 'general_research',
    label: '研究工具',
    description: '网络搜索、网页抓取、产物呈现等系统化研究工具。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'scheduled_run'],
    executionKinds: ['deterministic'],
    settingsVisible: true,
  },
  {
    id: 'map_planning',
    label: '地图行程规划',
    description: '路线规划、顺路地点搜索、多点顺序优化和地图标注产物。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat'],
    executionKinds: ['deterministic'],
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
  {
    id: 'mcp',
    label: 'MCP 工具',
    description: '通过 Model Context Protocol 接入的远程工具；走 OAuth 授权 + 每轮 deferred 提级。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat'],
    executionKinds: ['deterministic'],
    settingsVisible: false,
  },
  {
    id: 'agent_interaction',
    label: '反问用户',
    description: '主 agent 在意图含糊时主动向用户反问多个结构化问题（inline 卡片，预渲染 + 前进后退导航）。仅 local_chat。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'on',
    defaultProfiles: ['local_chat'],
    executionKinds: ['interactive'],
    settingsVisible: false,
  },
  {
    id: 'skill_install',
    label: '安装技能',
    description: '识别用户的技能安装意图，先只读解析出真实下载地址 + 风险分级（不安装），由用户通过反问卡确认后再交由宿主下载、扫描并安装。仅 local_chat。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'on',
    defaultProfiles: ['local_chat'],
    executionKinds: ['interactive'],
    settingsVisible: false,
  },
  {
    // P2-2 — L1 skill-catalog activation. `use_skill` lets the model self-select a
    // catalogued skill by description. defaultMode:'on' so the provider (with schema)
    // flows through the normal enrichment path; the SDK executor SUPPRESSES it via
    // intentGroupModes unless the turn is mode:'none' with a non-empty catalog, so it
    // never leaks into selected turns (no recursive activation) or legacy callers.
    id: 'skill_activation',
    label: '激活技能',
    description: '按「可用技能」目录激活一个技能（use_skill）：返回其 SKILL.md 方法论，并在本次运行的下一次模型迭代解锁该技能工具。仅 local_chat；仅在无显式技能引用的轮次曝光。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'on',
    defaultProfiles: ['local_chat'],
    executionKinds: ['interactive'],
    settingsVisible: false,
  },
  {
    id: 'command_exec',
    label: '运行安装/配置命令',
    description:
      'Phase M+（2026-07-05）：用户要求 agent 代跑一次性安装/配置命令行工具（如 npx @larksuite/cli@latest install、即梦 CLI 等）时的两阶段确认执行工具（run_setup_command）。区别于 MCP server（常驻 stdio）与技能安装：这是跑完即退的一次性命令。命令不经 shell（数组式 execFile，杜绝注入），阶段 1 只展示完整命令+风险绝不执行，经 ask_user_questions 用户确认后阶段 2 才执行并回报 stdout/stderr/退出码。仅 local_chat。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'on',
    defaultProfiles: ['local_chat'],
    executionKinds: ['interactive'],
    settingsVisible: false,
  },
  {
    id: 'mcp_install',
    label: '安装 MCP server',
    description:
      'Phase M（2026-07-05）：非专业用户让 agent 代为接入外部 MCP server 的两阶段安装工具（install_mcp_server）。阶段 1 只读解析出 npx/uvx 包与将写入的配置（绝不安装），经 ask_user_questions 用户确认后阶段 2 才写配置并重连；命令白名单 npx/uvx 由代码强制。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'on',
    defaultProfiles: ['local_chat'],
    executionKinds: ['interactive'],
    settingsVisible: false,
  },
  {
    id: 'channel_outbound',
    label: '远程会话回传',
    description:
      'Phase I（2026-07-05）：远程 IM 会话中把本机文件直接发送回当前对话线程（channel_send_file）。发送目标锁死为当前线程、无跨线程寻址；仅当 run 的 scope 绑定了远程渠道线程（agent_channel_threads 命中）时可见——真机实锚：用户在微信里说"把报告发我"，模型有文件定位工具却没有任何发送工具，只能口头道歉。',
    exposure: 'model_visible',
    availability: 'active',
    defaultMode: 'auto',
    defaultProfiles: ['local_chat', 'remote_channel'],
    executionKinds: ['deterministic'],
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
