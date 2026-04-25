import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { AgentRepository } from '../repositories/agent-repository'
import { MemoryRepository, type MemorySourceType } from '../repositories/memory-repository'
import type { ConversationScope } from './types'
import {
  buildCompressionReport,
  compressHistoryForPrompt,
  type PromptCompressionReport
} from './context-compression'
import { logAgentMetric } from './metrics'
import type { IntentClassification } from './intent-classifier'
import { classifyIntent } from './intent-classifier'
import type { RequestEnvelope } from './request-envelope'
import { buildRequestEnvelope } from './request-envelope'
import type { SessionRecallCapsule } from '../../../shared/session-recall'

export type PromptMemoryLayer = 'l0' | 'l1' | 'l2' | 'recall'
export type PromptMemorySourceType = MemorySourceType | 'session_recall'

export interface PromptMemoryRef {
  id: string
  layer: PromptMemoryLayer
  sourceType: PromptMemorySourceType
  title: string
  summary?: string | null
  path?: string | null
  triggerId?: string | null
  sensitive?: boolean
  loadedAt: string
}

export interface PromptTriggerHit {
  id: string
  label: string
  module?: 'browser' | 'document' | 'rss' | 'calendar' | 'feishu' | 'system'
  blocking: boolean
  refs: string[]
}

export interface PromptBudgetReport {
  totalChars: number
  l0Chars: number
  l1Chars: number
  l2Chars: number
  droppedRefs: string[]
}

export interface PromptAssemblyResult {
  systemPrompt: string
  bootstrapMessages: string[]
  memoryRefs: PromptMemoryRef[]
  triggerHits: PromptTriggerHit[]
  contextBudget: PromptBudgetReport
  compression?: PromptCompressionReport
  requestEnvelope: RequestEnvelope
  intentClassification: IntentClassification
}

export interface PromptAssemblyDeps {
  getMemoryRoot?: () => string
  getScopeMessages?: (
    scopeId: string
  ) => Promise<Array<{ role: string; content: string }>> | Array<{ role: string; content: string }>
  getScopeSessionRecallCapsules?: (
    scope: ConversationScope
  ) => Promise<SessionRecallCapsule[]> | SessionRecallCapsule[]
  getAutoSessionRecallCapsules?: (params: {
    scope: ConversationScope
    userText: string
  }) => Promise<SessionRecallCapsule[]> | SessionRecallCapsule[]
  now?: () => Date
  memoryRepository?: MemoryRepository
  enableDatabaseMemory?: boolean
  userProfileRepository?: any
  agentPersonalityRepository?: any
}

interface TriggerDefinition {
  id: string
  label: string
  module?: PromptTriggerHit['module']
  pattern: RegExp
  blocking: boolean
  refs: Array<{ path: string; title: string; summary: string; sensitive?: boolean }>
}

const MAX_L0_CHARS = 6000
const MAX_L1_CHARS = 8000
const MAX_L2_CHARS = 6000
const MAX_TOTAL_CHARS = 16000
const RSS_TRIGGER_PATTERN =
  /(?:\b(?:rss|feed|rsshub)\b|订阅源|订阅|源站|信息源|推送|skill_rss_|lets-go-rss).*(?:抓取|拉取|分析|汇总|输出.*报告|生成.*报告|添加|更新|查看|列出|状态|统计)|(?:抓取|拉取|分析|汇总|输出.*报告|生成.*报告|添加|更新|查看|列出|状态|统计).*(?:\b(?:rss|feed|rsshub)\b|订阅源|订阅|源站|信息源|推送|skill_rss_|lets-go-rss)|(?:skill_rss_|lets-go-rss)/i

const DEFAULT_FILES: Record<string, string> = {
  'MEMORY.md': [
    '# MEMORY.md',
    '- 当前是 Ready 的统一 agent runtime。',
    '- 保持结构化 run state、artifact、checkpoint、scope 隔离。',
    '- 敏感账号信息不进入常驻注入。'
  ].join('\n'),
  'AGENTS.md': [
    '# AGENTS.md',
    '- 优先使用真实工具，不要伪造结果。',
    '- 命中 Pre-Action Trigger 时，先读取规则，再执行动作。',
    '- 保存结构化 evidence、artifact、checkpoint。'
  ].join('\n'),
  'USER.md': ['# USER.md', '- 用户偏好：简洁直接，不要废话。', '- 默认使用中文。'].join('\n'),
  'TOOLS.md': [
    '# TOOLS.md',
    '- browser/document/rss/calendar/skill/system/feishu/memory 工具族可用。'
  ].join('\n'),
  'SOUL.md': ['# SOUL.md', '- 直接、清晰、务实。', '- 优先可执行结果。'].join('\n'),
  'docs/feishu-rules.md': [
    '# 飞书规则',
    '- 创建或改写飞书文档前先确认目标实体和权限。',
    '- 插图前先确认图片来源与上传方式。',
    '- 多账号场景先核对 account mapping。'
  ].join('\n'),
  'docs/accounts.md': ['# 账号索引', '- 这里存放账号映射索引，不在 L0 暴露敏感值。'].join('\n'),
  'docs/document-rules.md': ['# 文档规则', '- 写入前保留原意，保存前确认目标路径和格式。'].join(
    '\n'
  ),
  'docs/browser-rules.md': ['# 浏览器规则', '- 上传/输入/提交按阶段执行并逐步验证。'].join('\n'),
  'docs/rss-rules.md': ['# RSS 规则', '- 先确认源和条目，再运行分析 pipeline。'].join('\n'),
  'docs/calendar-rules.md': ['# 日程规则', '- 写入前先检查时间歧义和冲突。'].join('\n')
}

const TRIGGERS: TriggerDefinition[] = [
  {
    id: 'feishu-doc',
    label: '飞书文档操作',
    module: 'feishu',
    pattern: /(飞书).*(文档|doc)|创建飞书文档|改写飞书文档|写入飞书/i,
    blocking: true,
    refs: [
      { path: 'docs/feishu-rules.md', title: '飞书文档规则', summary: '飞书文档创建与改写规则' },
      {
        path: 'docs/accounts.md',
        title: '飞书账号索引',
        summary: '飞书账号和租户索引',
        sensitive: true
      }
    ]
  },
  {
    id: 'feishu-image',
    label: '飞书插图操作',
    module: 'feishu',
    pattern: /(飞书).*(图片|插图|上传)/i,
    blocking: true,
    refs: [
      { path: 'docs/feishu-rules.md', title: '飞书插图规则', summary: '飞书图片上传和插入规则' },
      {
        path: 'docs/accounts.md',
        title: '飞书账号索引',
        summary: '飞书账号和租户索引',
        sensitive: true
      }
    ]
  },
  {
    id: 'browser-upload',
    label: '浏览器上传流程',
    module: 'browser',
    pattern: /(上传|发送|提交|浏览器|网页)/i,
    blocking: false,
    refs: [
      {
        path: 'docs/browser-rules.md',
        title: '浏览器工作流规则',
        summary: '浏览器上传、输入、发送的阶段规则'
      }
    ]
  },
  {
    id: 'document-write',
    label: '文档改写操作',
    module: 'document',
    pattern: /(文档|文件).*(写|改|保存|格式)/i,
    blocking: false,
    refs: [{ path: 'docs/document-rules.md', title: '文档写入规则', summary: '文档改写和保存规则' }]
  },
  {
    id: 'rss-analysis',
    label: 'RSS 分析操作',
    module: 'rss',
    pattern: RSS_TRIGGER_PATTERN,
    blocking: false,
    refs: [{ path: 'docs/rss-rules.md', title: 'RSS 分析规则', summary: 'RSS 拉取和分析规则' }]
  },
  {
    id: 'calendar-write',
    label: '日程写入操作',
    module: 'calendar',
    pattern: /(日程|日历|会议|提醒).*(创建|修改|删除|改期)|创建日程|修改日程/i,
    blocking: true,
    refs: [
      { path: 'docs/calendar-rules.md', title: '日程写入规则', summary: '日历冲突和时间歧义规则' }
    ]
  }
]

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`
}

function sanitizeCommandLikeContent(text: string): string {
  if (!text) return ''
  const patterns = [
    /\b(?:system|document|browser|skill|memory|session|file)_[a-z0-9_]+:\d+>\s*\{[^\n]*\}/gi,
    /\b(?:system|document|browser|skill|memory|session|file)_[a-z0-9_]+:\d+>[^\n]*/gi,
    /\bsystem_run_[a-z0-9_]+\([^)]*\)/gi,
    /\bdocument_[a-z0-9_]+\([^)]*\)/gi,
    /\bbrowser_[a-z0-9_]+\([^)]*\)/gi,
    /\bskill_[a-z0-9_]+\([^)]*\)/gi,
    /\bopenclaw\s+pairing\s+[^\n]+/gi,
    /--cookies-from-browser\s+\S+/gi,
    /\bcookies-from-browser\b/gi,
    /\b(?:chrome|safari|firefox|edge|browser)\s+cookies?\b/gi,
  ]
  let sanitized = String(text)
  for (const pattern of patterns) {
    sanitized = sanitized.replace(
      pattern,
      pattern.source.includes('cookies') || pattern.source.includes('cookies-from-browser')
        ? '[浏览器凭据已隐藏]'
        : '[命令回显已隐藏]',
    )
  }
  return sanitized.replace(/(?:\[命令回显已隐藏\]\s*){2,}/g, '[命令回显已隐藏]\n').trim()
}

function hasCurrentExplicitResourceRefs(envelope: RequestEnvelope): boolean {
  if (envelope.referencedResources.some((ref) => ref.kind === 'mention')) return true
  if (envelope.resources.some((resource) =>
    resource.kind === 'attachment'
    || resource.kind === 'browser_reference'
    || resource.kind === 'folder_reference'
    || resource.kind === 'widget_target',
  )) {
    return true
  }
  return envelope.chunks.some((chunk) =>
    chunk.source === 'attachment_body'
    || (chunk.source === 'ui_resource_ref'
      && /(技能目录引用|浏览页面引用|文件夹引用|引用技能目录)/.test(chunk.text)),
  )
}

function formatMemorySection(title: string, body: string): string {
  return `## ${title}\n${body.trim()}`.trim()
}

function prependBootstrap(
  message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
  bootstrapMessages: string[]
) {
  if (bootstrapMessages.length === 0) return message
  const bootstrapText = bootstrapMessages.filter(Boolean).join('\n\n')
  if (typeof message === 'string') {
    return `${bootstrapText}\n\n${message}`
  }
  return [{ type: 'text', text: bootstrapText }, ...message]
}

function extractTextFromMessage(message: string | Array<{ type: string; text?: string }>): string {
  if (typeof message === 'string') return message
  return message
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text || '')
    .join('\n')
}

function applyBudget(parts: { l0Text: string; l1Text: string; l2Sections: string[] }): {
  l1Text: string
  l2Text: string
  budget: PromptBudgetReport
} {
  const droppedRefs: string[] = []
  const l0Chars = Math.min(parts.l0Text.length, MAX_L0_CHARS)
  const l1Text = clip(parts.l1Text, MAX_L1_CHARS)
  const l1Chars = l1Text.length
  let l2Text = ''
  let l2Chars = 0
  let totalChars = l0Chars + l1Chars

  for (const section of parts.l2Sections) {
    const clippedSection = clip(section, MAX_L2_CHARS)
    if (
      l2Chars + clippedSection.length > MAX_L2_CHARS ||
      totalChars + clippedSection.length > MAX_TOTAL_CHARS
    ) {
      const title =
        clippedSection
          .split('\n')[0]
          ?.replace(/^##\s*/, '')
          .trim() || 'L2 ref'
      droppedRefs.push(title)
      continue
    }
    l2Text += (l2Text ? '\n\n' : '') + clippedSection
    l2Chars += clippedSection.length
    totalChars += clippedSection.length
  }

  return {
    l1Text,
    l2Text,
    budget: { totalChars, l0Chars, l1Chars, l2Chars, droppedRefs }
  }
}

function defaultGetMemoryRoot(): string {
  const root = join(process.cwd(), '.ready-agent-memory')
  ensureMemoryRootStructure(root)
  return root
}

function ensureMemoryRootStructure(root: string): string {
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'memory'), { recursive: true })
  return root
}

async function defaultGetScopeMessages(
  scopeId: string
): Promise<Array<{ role: string; content: string }>> {
  const repository = new AgentRepository()
  return (await repository.getChatMessages(scopeId)).map((item) => ({
    role: item.role,
    content: String(item.content || '')
  }))
}

function shouldSkipTriggerForIntent(
  trigger: { id: string; module?: PromptTriggerHit['module'] },
  intentClassification?: IntentClassification,
): boolean {
  if (
    trigger.module &&
    intentClassification?.excludedDomains?.includes(
      trigger.module as Exclude<IntentClassification['primaryDomain'], 'generic'>,
    )
  ) {
    logAgentMetric('trigger_disagreement_rate', {
      triggerId: trigger.id,
      triggerModule: trigger.module,
      primaryDomain: intentClassification.primaryDomain,
      reason: 'excluded_domain',
    })
    return true
  }
  if (trigger.module && intentClassification?.primaryDomain === 'skill' && trigger.module !== 'system') {
    logAgentMetric('trigger_disagreement_rate', {
      triggerId: trigger.id,
      triggerModule: trigger.module,
      primaryDomain: intentClassification.primaryDomain,
      reason: 'explicit_skill_primary',
    })
    return true
  }
  return false
}

export class PromptAssemblyService {
  constructor(private readonly deps: PromptAssemblyDeps = {}) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private getMemoryRoot(): string {
    return ensureMemoryRootStructure(this.deps.getMemoryRoot?.() ?? defaultGetMemoryRoot())
  }

  private async getScopeMessages(
    scopeId: string
  ): Promise<Array<{ role: string; content: string }>> {
    if (this.deps.getScopeMessages) {
      return await this.deps.getScopeMessages(scopeId)
    }
    return await defaultGetScopeMessages(scopeId)
  }

  private readMemoryFile(path: string, root = this.getMemoryRoot()): string {
    const fullPath = join(root, path)
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, 'utf8')
    }
    return DEFAULT_FILES[path] || ''
  }

  private ensureMemoryRefFile(path: string, root = this.getMemoryRoot()): void {
    if (!path.startsWith('memory/')) return
    try {
      appendFileSync(join(root, path), '', 'utf8')
    } catch {
      // Keep prompt assembly resilient even if the memory ref file cannot be created.
    }
  }

  private makeMemoryRef(
    layer: PromptMemoryLayer,
    sourceType: PromptMemorySourceType,
    title: string,
    path: string | null,
    summary: string,
    triggerId?: string,
    sensitive = false
  ): PromptMemoryRef {
    return {
      id: `${layer}-${title}-${path || 'inline'}`.replace(/\s+/g, '-').toLowerCase(),
      layer,
      sourceType,
      title,
      summary,
      path,
      triggerId: triggerId || null,
      sensitive,
      loadedAt: this.now().toISOString()
    }
  }

  /**
   * Load SOUL.md dynamically from database or fallback to file
   */
  private async loadSOUL(agentName: string): Promise<string> {
    if (this.deps.enableDatabaseMemory && this.deps.agentPersonalityRepository) {
      try {
        const personality = await this.deps.agentPersonalityRepository.getPersonality(agentName)
        if (personality) {
          return personality.personalityText
        }
      } catch (error) {
        console.error('[PromptAssembly] Failed to load personality from database:', error)
      }
    }
    // Fallback to file-based SOUL.md
    return this.readMemoryFile('SOUL.md')
  }

  /**
   * Load USER.md dynamically from database or fallback to file
   */
  private async loadUSER(userId?: string): Promise<string> {
    if (!userId || !this.deps.enableDatabaseMemory) {
      return this.readMemoryFile('USER.md')
    }

    try {
      // Load user profile
      const profile = this.deps.userProfileRepository
        ? await this.deps.userProfileRepository.getProfile(userId)
        : null

      if (!profile) {
        return this.readMemoryFile('USER.md')
      }

      // Generate USER.md content from profile
      const sections = [
        `# User Profile: ${profile.name || userId}`,
        `Language: ${profile.preferredLanguage}`,
        profile.communicationStyle ? `Communication Style: ${profile.communicationStyle}` : ''
      ]

      // Load user-specific memories
      if (this.deps.memoryRepository) {
        const userMemories = await this.deps.memoryRepository.queryMemories({
          userId,
          sourceType: 'resident_user',
          includeArchived: false,
          limit: 10
        })

        if (userMemories.length > 0) {
          sections.push('\n## Preferences')
          for (const memory of userMemories) {
            const content = await this.loadMemoryContent(memory.contentKey)
            if (content) {
              sections.push(`- ${memory.title}: ${content}`)
            }
          }
        }
      }

      return sections.filter(Boolean).join('\n')
    } catch (error) {
      console.error('[PromptAssembly] Failed to load user profile from database:', error)
      return this.readMemoryFile('USER.md')
    }
  }

  /**
   * Load MEMORY.md dynamically from database or fallback to file
   */
  private async loadMEMORY(): Promise<string> {
    return this.readMemoryFile('MEMORY.md')
  }

  private async loadL0(
    scope: ConversationScope
  ): Promise<{ text: string; refs: PromptMemoryRef[]; chars: number }> {
    const residentAgentSections: string[] = []
    const residentRefs: PromptMemoryRef[] = []

    if (this.deps.enableDatabaseMemory && this.deps.memoryRepository) {
      try {
        const residentMemories = await this.deps.memoryRepository.queryMemories({
          sourceType: 'resident_agent',
          includeArchived: false,
          limit: 10
        })

        for (const memory of residentMemories) {
          const content = await this.loadMemoryContent(memory.contentKey)
          if (!content) continue
          residentAgentSections.push(`- ${memory.title}: ${content}`)
          residentRefs.push(
            this.makeMemoryRef(
              'l0',
              'resident_agent',
              memory.title,
              null,
              memory.summary || memory.title
            )
          )
          await this.deps.memoryRepository.incrementAccessCount(memory.id)
        }
      } catch (error) {
        console.error(
          '[PromptAssembly] Failed to load resident agent memories from database:',
          error
        )
      }
    }

    // Load dynamic L0 files
    const soul = await this.loadSOUL(scope.agent)
    const memory = await this.loadMEMORY()
    const user = await this.loadUSER(scope.userId)
    const agents = this.readMemoryFile('AGENTS.md')
    const tools = this.readMemoryFile('TOOLS.md')

    const sections = [
      formatMemorySection(
        '常驻记忆',
        [memory, ...residentAgentSections].filter(Boolean).join('\n')
      ),
      formatMemorySection('运行指令', agents),
      formatMemorySection('用户画像', user),
      formatMemorySection('工具索引', tools),
      formatMemorySection('人格定义', soul)
    ]

    const rendered = sections.join('\n\n')
    const clipped = clip(rendered, MAX_L0_CHARS)

    const refs = [
      this.makeMemoryRef('l0', 'resident_agent', '常驻记忆', 'MEMORY.md', '常驻 agent 记忆'),
      this.makeMemoryRef('l0', 'resident_user', '用户画像', 'USER.md', '常驻用户偏好'),
      ...residentRefs
    ]

    return { text: clipped, refs, chars: clipped.length }
  }

  private async loadL1(
    scope: ConversationScope,
    options: { includeDailyMemory?: boolean } = {},
  ): Promise<{ text: string; refs: PromptMemoryRef[]; chars: number; historyCompressed: boolean }> {
    // Load from file-based system (backward compatibility)
    const messages = (await this.getScopeMessages(scope.id)).slice(-4)
    const transcript = compressHistoryForPrompt(
      messages.map((item) => ({
        role: item.role,
        content: String(item.content || '').slice(0, 400)
      })),
      { keepRecent: 2, maxChars: 600 }
    )
    const now = this.now()
    const day = now.toISOString().slice(0, 10)
    const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10)
    const memoryRoot = this.getMemoryRoot()
    const dayFiles = [`memory/${day}.md`, `memory/${yesterday}.md`]
    const includeDailyMemory = options.includeDailyMemory !== false
    if (includeDailyMemory) {
      dayFiles.forEach((path) => this.ensureMemoryRefFile(path, memoryRoot))
    }
    const dailySections = includeDailyMemory
      ? dayFiles
        .map((path) => {
          const content = sanitizeCommandLikeContent(this.readMemoryFile(path, memoryRoot)).trim()
          return content ? formatMemorySection(path.split('/').pop() || path, content) : ''
        })
        .filter(Boolean)
        .join('\n\n')
      : ''

    const sections: string[] = [
      formatMemorySection(
        '当前 Scope',
        [
          `- 标题: ${scope.title}`,
          `- 来源: ${scope.sourceKind}`,
          `- 线程: ${scope.threadKey}`
        ].join('\n')
      ),
      transcript.text ? formatMemorySection('最近会话摘要', sanitizeCommandLikeContent(transcript.text)) : '',
      dailySections
    ].filter(Boolean)

    const refs: PromptMemoryRef[] = [
      this.makeMemoryRef(
        'l1',
        'scope_memory',
        'Scope 会话摘要',
        null,
        `Scope ${scope.title} 的最近会话摘要`
      ),
      ...(includeDailyMemory
        ? dayFiles.map((path) =>
          this.makeMemoryRef(
            'l1',
            'scope_memory',
            path.split('/').pop() || path,
            path,
            '当日操作日志'
          )
        )
        : [])
    ]

    // Load from database if enabled
    if (this.deps.enableDatabaseMemory && this.deps.memoryRepository) {
      try {
        // Load scope-specific memories
        const scopeMemories = await this.deps.memoryRepository.queryMemories({
          layer: 'l1',
          scopeId: scope.id,
          sourceType: 'scope_memory',
          includeArchived: false,
          limit: 3
        })

        for (const memory of scopeMemories) {
          const content = await this.loadMemoryContent(memory.contentKey)
          if (content) {
            sections.push(formatMemorySection(memory.title, content))
            refs.push(
              this.makeMemoryRef(
                'l1',
                'scope_memory',
                memory.title,
                null,
                memory.summary || memory.title
              )
            )
            await this.deps.memoryRepository.incrementAccessCount(memory.id)
          }
        }
      } catch (error) {
        console.error('[PromptAssembly] Failed to load database memories:', error)
      }
    }

    const text = clip(sections.join('\n\n'), MAX_L1_CHARS)
    return { text, refs, chars: text.length, historyCompressed: transcript.compressed }
  }

  private async loadMemoryContent(contentKey: string): Promise<string | null> {
    try {
      // Try to load from agent_knowledge table
      const { getDatabase } = await import('../database')
      const dbManager = getDatabase()
      const db = dbManager.getRawDb()
      if (!db) return null
      const row = db
        .prepare('SELECT value FROM agent_knowledge WHERE key = ?')
        .get<{ value: string }>(contentKey)
      return row?.value || null
    } catch {
      return null
    }
  }

  private async resolveTriggers(
    text: string,
    intentClassification?: IntentClassification,
  ): Promise<Array<{ trigger: TriggerDefinition; sections: string[]; refs: PromptMemoryRef[] }>> {
    const hits: Array<{ trigger: TriggerDefinition; sections: string[]; refs: PromptMemoryRef[] }> =
      []

    // Load dynamic triggers from database if enabled
    if (this.deps.enableDatabaseMemory && this.deps.memoryRepository) {
      try {
        const dbTriggers = await this.deps.memoryRepository.listTriggers({ enabled: true })

        for (const dbTrigger of dbTriggers) {
          const pattern = new RegExp(dbTrigger.pattern, dbTrigger.patternFlags)
          pattern.lastIndex = 0
          if (!pattern.test(text)) continue
          if (shouldSkipTriggerForIntent({
            id: dbTrigger.id,
            module: dbTrigger.module as TriggerDefinition['module'],
          }, intentClassification)) {
            continue
          }

          await this.deps.memoryRepository.incrementTriggerHitCount(dbTrigger.id)

          const sections: string[] = []
          const refs: PromptMemoryRef[] = []

          // Load associated memories
          const memories = await this.deps.memoryRepository.getTriggerRefs(dbTrigger.id)
          for (const memory of memories) {
            const content = await this.loadMemoryContent(memory.contentKey)
            if (!content) continue
            sections.push(formatMemorySection(memory.title, content))
            refs.push(
              this.makeMemoryRef(
                'l2',
                'trigger_rule',
                memory.title,
                null,
                memory.summary || memory.title,
                dbTrigger.id
              )
            )
            await this.deps.memoryRepository.incrementAccessCount(memory.id)
          }

          hits.push({
            trigger: {
              id: dbTrigger.id,
              label: dbTrigger.label,
              module: dbTrigger.module as TriggerDefinition['module'],
              pattern,
              blocking: dbTrigger.blocking,
              refs: memories.map((m) => ({
                path: m.contentKey,
                title: m.title,
                summary: m.summary || ''
              }))
            },
            sections,
            refs
          })
        }
      } catch (error) {
        console.error('[PromptAssembly] Failed to load database triggers:', error)
      }
    }

    // Fallback to hardcoded triggers (backward compatibility)
    for (const trigger of TRIGGERS) {
      trigger.pattern.lastIndex = 0
      if (!trigger.pattern.test(text)) continue
      if (shouldSkipTriggerForIntent(trigger, intentClassification)) continue
      const sections: string[] = []
      const refs: PromptMemoryRef[] = []
      for (const ref of trigger.refs) {
        const body = this.readMemoryFile(ref.path).trim()
        if (!body) continue
        sections.push(formatMemorySection(ref.title, body))
        refs.push(
          this.makeMemoryRef(
            'l2',
            'trigger_rule',
            ref.title,
            ref.path,
            ref.summary,
            trigger.id,
            Boolean(ref.sensitive)
          )
        )
      }
      hits.push({ trigger, sections, refs })
    }

    return hits
  }

  private async loadSessionRecall(
    scope: ConversationScope
  ): Promise<{ text: string; refs: PromptMemoryRef[] }> {
    if (!this.deps.getScopeSessionRecallCapsules) {
      return { text: '', refs: [] }
    }
    const capsules = await this.deps.getScopeSessionRecallCapsules(scope)
    if (!Array.isArray(capsules) || capsules.length === 0) {
      return { text: '', refs: [] }
    }

    // skill-resume E2 — emit a recognizable [session-recall-context] marker so
    // the LLM treats this block as continuation context (e.g. when the user
    // just said "继续 …" without re-stating what to continue). Section bodies
    // include latestTaskSummary so the model can see what tool calls / outputs
    // led to the prior conversation's last state.
    const sections = capsules.slice(0, 4).map((capsule) => {
      const attachmentLine =
        capsule.attachmentNames.length > 0
          ? `- 相关附件: ${capsule.attachmentNames.join('、')}`
          : null
      const taskLine = capsule.latestTaskSummary
        ? `- 最近任务: ${sanitizeCommandLikeContent(capsule.latestTaskSummary)}`
        : null
      return [
        `### [session-recall-context] ${capsule.title}`,
        `- 会话 ID: ${capsule.conversationId}`,
        `- 来源: ${capsule.sourceKind}:${capsule.sourceId}`,
        `- 线程: ${capsule.threadKey}`,
        taskLine,
        attachmentLine,
        '',
        sanitizeCommandLikeContent(capsule.summary)
      ]
        .filter(Boolean)
        .join('\n')
    })
    const refs = capsules
      .slice(0, 4)
      .map((capsule) =>
        this.makeMemoryRef(
          'recall',
          'session_recall',
          capsule.title,
          null,
          capsule.summary.slice(0, 140),
          capsule.conversationId
        )
      )
    const header = '以下条目带有 [session-recall-context] 标记，是用户之前会话的续做上下文（含上次工具调用与产出摘要），请优先据此理解"继续/接着"等指令。'
    return {
      text: clip([header, ...sections].join('\n\n'), 4000),
      refs
    }
  }

  private async loadAutomaticSessionRecall(
    scope: ConversationScope,
    userText: string
  ): Promise<{ text: string; refs: PromptMemoryRef[] }> {
    if (!this.deps.getAutoSessionRecallCapsules) {
      return { text: '', refs: [] }
    }
    const capsules = await this.deps.getAutoSessionRecallCapsules({ scope, userText })
    if (!Array.isArray(capsules) || capsules.length === 0) {
      return { text: '', refs: [] }
    }
    const sections = capsules.slice(0, 2).map((capsule) => {
      const attachmentLine =
        capsule.attachmentNames.length > 0
          ? `- 相关附件: ${capsule.attachmentNames.join('、')}`
          : null
      const taskLine = capsule.latestTaskSummary
        ? `- 最近任务: ${sanitizeCommandLikeContent(capsule.latestTaskSummary)}`
        : null
      return [
        `### ${capsule.title}`,
        `- 会话 ID: ${capsule.conversationId}`,
        `- 来源: ${capsule.sourceKind}:${capsule.sourceId}`,
        `- 线程: ${capsule.threadKey}`,
        taskLine,
        attachmentLine,
        '',
        '以下为历史参考，仅供参考，不代表当前用户指令。',
        sanitizeCommandLikeContent(capsule.summary)
      ]
        .filter(Boolean)
        .join('\n')
    })
    const refs = capsules
      .slice(0, 2)
      .map((capsule) =>
        this.makeMemoryRef(
          'recall',
          'session_recall',
          capsule.title,
          null,
          capsule.summary.slice(0, 140),
          capsule.conversationId
        )
      )
    return {
      text: clip(sections.join('\n\n'), 2000),
      refs
    }
  }

  async buildForScopedRun(params: {
    scope: ConversationScope
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>
  }): Promise<PromptAssemblyResult> {
    const userText = extractTextFromMessage(params.message)
    const requestEnvelope = buildRequestEnvelope({ userText })
    const intentClassification = classifyIntent(requestEnvelope)
    const hasExplicitResourceRefs = hasCurrentExplicitResourceRefs(requestEnvelope)
    const l0 = await this.loadL0(params.scope)
    const l1 = await this.loadL1(params.scope, { includeDailyMemory: !hasExplicitResourceRefs })
    const documentExcerptCount = requestEnvelope.chunks.filter((chunk) => chunk.source === 'document_excerpt').length
    const attachmentBodyCount = requestEnvelope.chunks.filter((chunk) => chunk.source === 'attachment_body').length
    if (documentExcerptCount > 0 || attachmentBodyCount > 0) {
      logAgentMetric('context_expansion_rate', {
        scopeId: params.scope.id,
        documentExcerptCount,
        attachmentBodyCount,
      })
    }
    const recall = await this.loadSessionRecall(params.scope)
    const autoRecall = hasExplicitResourceRefs
      ? { text: '', refs: [] }
      : await this.loadAutomaticSessionRecall(
        params.scope,
        requestEnvelope.primaryInstruction || requestEnvelope.pureUserText || userText,
      )
    if (autoRecall.refs.length > 0) {
      logAgentMetric('recall_influence_rate', {
        scopeId: params.scope.id,
        recallCount: autoRecall.refs.length,
        primaryDomain: intentClassification.primaryDomain,
      })
    }
    const triggerMatches = await this.resolveTriggers(
      requestEnvelope.primaryInstruction || requestEnvelope.pureUserText || userText,
      intentClassification,
    )
    const l2Sections = triggerMatches.flatMap((item) => item.sections)
    const { l1Text, l2Text, budget } = applyBudget({ l0Text: l0.text, l1Text: l1.text, l2Sections })

    const bootstrapMessages = [
      l1Text ? formatMemorySection('L1 会话上下文', l1Text) : '',
      recall.text ? formatMemorySection('跨会话回看', recall.text) : '',
      autoRecall.text ? formatMemorySection('自动跨会话回看', autoRecall.text) : '',
      l2Text ? formatMemorySection('L2 按需规则', l2Text) : ''
    ].filter(Boolean)
    const memoryRefs = [
      ...l0.refs,
      ...l1.refs,
      ...recall.refs,
      ...autoRecall.refs.filter(
        (item) => !recall.refs.some((existing) => existing.triggerId === item.triggerId)
      ),
      ...triggerMatches.flatMap((item) => item.refs)
    ]
    const triggerHits = triggerMatches.map(({ trigger, refs }) => ({
      id: trigger.id,
      label: trigger.label,
      module: trigger.module,
      blocking: trigger.blocking,
      refs: refs.map((ref) => ref.id)
    }))

    return {
      systemPrompt: [
        '你是 Ready 应用中的 AI 助手，面向自媒体创作者。你擅长内容策划、文案写作、数据分析和创意建议。请使用简洁清晰的中文回答。',
        formatMemorySection('L0 常驻上下文', l0.text),
        '若命中 Pre-Action Trigger，必须先吸收对应规则再执行动作。'
      ].join('\n\n'),
      bootstrapMessages,
      memoryRefs,
      triggerHits,
      contextBudget: budget,
      compression: buildCompressionReport({
        historyCompressed: l1.historyCompressed,
        toolTraceCompressed: false,
        artifactSummaryUsed: false
      }),
      requestEnvelope,
      intentClassification,
    }
  }

  applyToMessage(
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
    assembly: PromptAssemblyResult
  ) {
    return prependBootstrap(message, assembly.bootstrapMessages)
  }

  recordRunOutcome(params: {
    scope: ConversationScope
    finalText: string
    usedTools: string[]
    success: boolean
  }): void {
    const day = this.now().toISOString().slice(0, 10)
    const memoryDir = join(this.getMemoryRoot(), 'memory')
    const path = join(memoryDir, `${day}.md`)
    const safeSummary = sanitizeCommandLikeContent(params.finalText).trim()
    const lines = [
      `## ${this.now().toISOString()}`,
      `- scope: ${params.scope.title}`,
      `- success: ${params.success ? 'yes' : 'no'}`,
      params.usedTools.length > 0 ? `- tools: ${params.usedTools.join(', ')}` : null,
      safeSummary
        ? `- summary: ${clip(safeSummary, 600).replace(/\n+/g, ' ')}`
        : null,
      ''
    ].filter(Boolean)
    try {
      mkdirSync(memoryDir, { recursive: true })
      appendFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    } catch {
      // Keep memory writebacks non-blocking; the main run should still succeed.
    }
  }

  /**
   * Create a memory from conversation content
   * @param scope - Conversation scope
   * @param category - Memory category (summary or learning)
   * @param title - Memory title
   * @param content - Memory content
   * @param tags - Optional tags
   * @param priority - Optional priority (default 0)
   */
  async createMemoryFromConversation(params: {
    scope: ConversationScope
    category: 'summary' | 'learning'
    title: string
    content: string
    tags?: string[]
    priority?: number
  }): Promise<string | null> {
    if (!this.deps.enableDatabaseMemory || !this.deps.memoryRepository) {
      return null
    }

    try {
      // Generate unique content key
      const contentKey = `memory-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

      // Store content in agent_knowledge table
      const { getDatabase } = await import('../database')
      const dbManager = getDatabase()
      const db = dbManager.getRawDb()
      if (!db) return null

      db.prepare('INSERT INTO agent_knowledge (key, value, created_at) VALUES (?, ?, ?)').run(
        contentKey,
        params.content,
        Math.floor(Date.now() / 1000)
      )

      // Create memory metadata
      const memory = await this.deps.memoryRepository.createMemory({
        layer: params.category === 'learning' ? 'l0' : 'l1',
        scopeId: params.category === 'learning' ? null : params.scope.id, // Global for learnings
        userId: params.scope.userId || null,
        sourceType: params.category === 'learning' ? 'resident_agent' : 'scope_memory',
        category: params.category,
        title: params.title,
        summary: params.content.slice(0, 100),
        contentKey,
        priority: params.priority ?? 0,
        tags: params.tags,
        // Summaries expire after 30 days, learnings never expire
        expiresAt:
          params.category === 'summary' ? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 : null
      })

      return memory.id
    } catch (error) {
      console.error('[PromptAssembly] Failed to create memory:', error)
      return null
    }
  }

  /**
   * Create a trigger with associated memories
   * @param label - Trigger label
   * @param pattern - Regex pattern
   * @param patternFlags - Regex flags (default 'i')
   * @param memoryIds - Associated memory IDs
   * @param module - Optional module name
   * @param blocking - Whether trigger is blocking (default false)
   * @param priority - Trigger priority (default 0)
   */
  async createTrigger(params: {
    label: string
    pattern: string
    patternFlags?: string
    memoryIds: string[]
    module?: string
    blocking?: boolean
    priority?: number
  }): Promise<string | null> {
    if (!this.deps.enableDatabaseMemory || !this.deps.memoryRepository) {
      return null
    }

    try {
      // Create trigger
      const trigger = await this.deps.memoryRepository.createTrigger({
        label: params.label,
        pattern: params.pattern,
        patternFlags: params.patternFlags ?? 'i',
        module: params.module ?? null,
        blocking: params.blocking ?? false,
        priority: params.priority ?? 0,
        enabled: true
      })

      // Associate memories with trigger
      for (const memoryId of params.memoryIds) {
        await this.deps.memoryRepository.addTriggerRef(trigger.id, memoryId, 0)
      }

      return trigger.id
    } catch (error) {
      console.error('[PromptAssembly] Failed to create trigger:', error)
      return null
    }
  }
}
