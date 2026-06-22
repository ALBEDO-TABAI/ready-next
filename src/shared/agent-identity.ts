export const MAIN_AGENT_ID = 'butler'

export const BUILTIN_AGENT_IDS = ['butler', 'copywriter', 'video-editor', 'analyst'] as const
export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number]

export const BUILTIN_AGENT_META: Record<BuiltinAgentId, {
  displayName: string
  emoji: string
  charter: string
}> = {
  butler: {
    displayName: 'Ready',
    emoji: '🤖',
    charter: '主 agent：理解用户意图、协调任务、维护 Ready 工作台上下文。',
  },
  copywriter: {
    displayName: '文案',
    emoji: '✍️',
    charter: '文案创作 agent：负责文案草拟、润色、多版本表达与平台语气适配。',
  },
  'video-editor': {
    displayName: '美术',
    emoji: '🎨',
    charter: '美术 agent：负责画面分析、视觉方向、构图色彩与美术建议。',
  },
  analyst: {
    displayName: '智识',
    emoji: '📚',
    charter: '智识 agent：负责学习、知识积累、研究整理与分析判断。',
  },
}

const BUILTIN_AGENT_ID_SET = new Set<string>(BUILTIN_AGENT_IDS)

export type AgentLifecycleStatus = 'active' | 'disabled' | 'merged'
export type LegacyAgentLifecycleStatus = AgentLifecycleStatus | 'retired'

export function normalizeAgentLifecycleStatus(status: string | null | undefined): AgentLifecycleStatus {
  if (status === 'merged') return 'merged'
  if (status === 'disabled' || status === 'retired') return 'disabled'
  return 'active'
}

export function normalizeAgentSlug(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
}

export function isValidAgentSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value)
}

export function isReservedAgentSlug(value: string): value is BuiltinAgentId {
  return BUILTIN_AGENT_ID_SET.has(value)
}

export function defaultAgentEmoji(agentId: string): string {
  return isReservedAgentSlug(agentId) ? BUILTIN_AGENT_META[agentId].emoji : '🤖'
}

export function defaultAgentDisplayName(agentId: string): string {
  return isReservedAgentSlug(agentId) ? BUILTIN_AGENT_META[agentId].displayName : agentId
}

export function deletedAgentDisplayName(agentId: string): string {
  const suffix = String(agentId || '').trim()
  return suffix ? `已删除的 Agent（${suffix}）` : '已删除的 Agent'
}
