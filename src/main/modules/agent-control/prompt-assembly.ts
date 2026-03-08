import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { AgentRepository } from '../repositories/agent-repository'
import type { ConversationScope } from './types'

export type PromptMemoryLayer = 'l0' | 'l1' | 'l2'

export interface PromptMemoryRef {
  id: string
  layer: PromptMemoryLayer
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
  module?: 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar' | 'feishu' | 'system'
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
}

export interface PromptAssemblyDeps {
  getMemoryRoot?: () => string
  getScopeMessages?: (scopeId: string) => Promise<Array<{ role: string; content: string }>> | Array<{ role: string; content: string }>
  now?: () => Date
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

const DEFAULT_FILES: Record<string, string> = {
  'MEMORY.md': [
    '# MEMORY.md',
    '- 当前是 Ready 的统一 agent runtime。',
    '- 保持结构化 run state、artifact、checkpoint、scope 隔离。',
    '- 敏感账号信息不进入常驻注入。',
  ].join('\n'),
  'AGENTS.md': [
    '# AGENTS.md',
    '- 优先使用真实工具，不要伪造结果。',
    '- 命中 Pre-Action Trigger 时，先读取规则，再执行动作。',
    '- 保存结构化 evidence、artifact、checkpoint。',
  ].join('\n'),
  'USER.md': [
    '# USER.md',
    '- 用户偏好：简洁直接，不要废话。',
    '- 默认使用中文。',
  ].join('\n'),
  'TOOLS.md': [
    '# TOOLS.md',
    '- browser/document/design/video/rss/calendar/system 工具族可用。',
  ].join('\n'),
  'SOUL.md': [
    '# SOUL.md',
    '- 直接、清晰、务实。',
    '- 优先可执行结果。',
  ].join('\n'),
  'docs/feishu-rules.md': [
    '# 飞书规则',
    '- 创建或改写飞书文档前先确认目标实体和权限。',
    '- 插图前先确认图片来源与上传方式。',
    '- 多账号场景先核对 account mapping。',
  ].join('\n'),
  'docs/accounts.md': [
    '# 账号索引',
    '- 这里存放账号映射索引，不在 L0 暴露敏感值。',
  ].join('\n'),
  'docs/document-rules.md': [
    '# 文档规则',
    '- 写入前保留原意，保存前确认目标路径和格式。',
  ].join('\n'),
  'docs/browser-rules.md': [
    '# 浏览器规则',
    '- 上传/输入/提交按阶段执行并逐步验证。',
  ].join('\n'),
  'docs/video-rules.md': [
    '# 视频规则',
    '- 渲染前确认 timeline schema、输出格式和元数据。',
  ].join('\n'),
  'docs/rss-rules.md': [
    '# RSS 规则',
    '- 先确认源和条目，再运行分析 pipeline。',
  ].join('\n'),
  'docs/calendar-rules.md': [
    '# 日程规则',
    '- 写入前先检查时间歧义和冲突。',
  ].join('\n'),
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
      { path: 'docs/accounts.md', title: '飞书账号索引', summary: '飞书账号和租户索引', sensitive: true },
    ],
  },
  {
    id: 'feishu-image',
    label: '飞书插图操作',
    module: 'feishu',
    pattern: /(飞书).*(图片|插图|上传)/i,
    blocking: true,
    refs: [
      { path: 'docs/feishu-rules.md', title: '飞书插图规则', summary: '飞书图片上传和插入规则' },
      { path: 'docs/accounts.md', title: '飞书账号索引', summary: '飞书账号和租户索引', sensitive: true },
    ],
  },
  {
    id: 'browser-upload',
    label: '浏览器上传流程',
    module: 'browser',
    pattern: /(上传|发送|提交|浏览器|网页)/i,
    blocking: false,
    refs: [
      { path: 'docs/browser-rules.md', title: '浏览器工作流规则', summary: '浏览器上传、输入、发送的阶段规则' },
    ],
  },
  {
    id: 'document-write',
    label: '文档改写操作',
    module: 'document',
    pattern: /(文档|文件).*(写|改|保存|格式)/i,
    blocking: false,
    refs: [
      { path: 'docs/document-rules.md', title: '文档写入规则', summary: '文档改写和保存规则' },
    ],
  },
  {
    id: 'video-render',
    label: '视频渲染操作',
    module: 'video',
    pattern: /(视频|剪辑|渲染|导出)/i,
    blocking: false,
    refs: [
      { path: 'docs/video-rules.md', title: '视频渲染规则', summary: '视频 schema、metadata 和导出规则' },
    ],
  },
  {
    id: 'rss-analysis',
    label: 'RSS 分析操作',
    module: 'rss',
    pattern: /(rss|订阅|抓取|分析)/i,
    blocking: false,
    refs: [
      { path: 'docs/rss-rules.md', title: 'RSS 分析规则', summary: 'RSS 拉取和分析规则' },
    ],
  },
  {
    id: 'calendar-write',
    label: '日程写入操作',
    module: 'calendar',
    pattern: /(日程|日历|会议|提醒).*(创建|修改|删除|改期)|创建日程|修改日程/i,
    blocking: true,
    refs: [
      { path: 'docs/calendar-rules.md', title: '日程写入规则', summary: '日历冲突和时间歧义规则' },
    ],
  },
]

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`
}

function formatMemorySection(title: string, body: string): string {
  return `## ${title}\n${body.trim()}`.trim()
}

function prependBootstrap(message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>, bootstrapMessages: string[]) {
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

function applyBudget(parts: {
  l0Text: string
  l1Text: string
  l2Sections: string[]
}): { l1Text: string; l2Text: string; budget: PromptBudgetReport } {
  const droppedRefs: string[] = []
  const l0Chars = Math.min(parts.l0Text.length, MAX_L0_CHARS)
  const l1Text = clip(parts.l1Text, MAX_L1_CHARS)
  const l1Chars = l1Text.length
  let l2Text = ''
  let l2Chars = 0
  let totalChars = l0Chars + l1Chars

  for (const section of parts.l2Sections) {
    const clippedSection = clip(section, MAX_L2_CHARS)
    if ((l2Chars + clippedSection.length) > MAX_L2_CHARS || (totalChars + clippedSection.length) > MAX_TOTAL_CHARS) {
      const title = clippedSection.split('\n')[0]?.replace(/^##\s*/, '').trim() || 'L2 ref'
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
    budget: { totalChars, l0Chars, l1Chars, l2Chars, droppedRefs },
  }
}

function defaultGetMemoryRoot(): string {
  const root = join(process.cwd(), '.ready-agent-memory')
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'memory'), { recursive: true })
  return root
}

async function defaultGetScopeMessages(scopeId: string): Promise<Array<{ role: string; content: string }>> {
  const repository = new AgentRepository()
  return (await repository.getChatMessages(scopeId)).map((item) => ({
    role: item.role,
    content: String(item.content || ''),
  }))
}

export class PromptAssemblyService {
  constructor(private readonly deps: PromptAssemblyDeps = {}) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private getMemoryRoot(): string {
    return this.deps.getMemoryRoot?.() ?? defaultGetMemoryRoot()
  }

  private async getScopeMessages(scopeId: string): Promise<Array<{ role: string; content: string }>> {
    if (this.deps.getScopeMessages) {
      return await this.deps.getScopeMessages(scopeId)
    }
    return await defaultGetScopeMessages(scopeId)
  }

  private readMemoryFile(path: string): string {
    const fullPath = join(this.getMemoryRoot(), path)
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, 'utf8')
    }
    return DEFAULT_FILES[path] || ''
  }

  private makeMemoryRef(
    layer: PromptMemoryLayer,
    title: string,
    path: string | null,
    summary: string,
    triggerId?: string,
    sensitive = false,
  ): PromptMemoryRef {
    return {
      id: `${layer}-${title}-${path || 'inline'}`.replace(/\s+/g, '-').toLowerCase(),
      layer,
      title,
      summary,
      path,
      triggerId: triggerId || null,
      sensitive,
      loadedAt: this.now().toISOString(),
    }
  }

  private loadL0(): { text: string; refs: PromptMemoryRef[]; chars: number } {
    const parts = [
      ['MEMORY.md', '长期记忆'],
      ['AGENTS.md', '运行指令'],
      ['USER.md', '用户偏好'],
      ['TOOLS.md', '工具索引'],
      ['SOUL.md', '人格定义'],
    ] as const

    const rendered = parts.map(([path, title]) => formatMemorySection(title, this.readMemoryFile(path))).join('\n\n')
    const clipped = clip(rendered, MAX_L0_CHARS)
    const refs = parts.map(([path, title]) => this.makeMemoryRef('l0', title, path, `L0 常驻：${title}`))
    return { text: clipped, refs, chars: clipped.length }
  }

  private async loadL1(scope: ConversationScope): Promise<{ text: string; refs: PromptMemoryRef[]; chars: number }> {
    const messages = (await this.getScopeMessages(scope.id)).slice(-6)
    const transcript = messages
      .map((item) => `${item.role === 'user' ? '用户' : item.role === 'assistant' ? '助手' : '系统'}: ${String(item.content || '').slice(0, 240)}`)
      .join('\n')
    const now = this.now()
    const day = now.toISOString().slice(0, 10)
    const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10)
    const dayFiles = [`memory/${day}.md`, `memory/${yesterday}.md`]
    const dailySections = dayFiles
      .map((path) => {
        const content = this.readMemoryFile(path).trim()
        return content ? formatMemorySection(path.split('/').pop() || path, content) : ''
      })
      .filter(Boolean)
      .join('\n\n')
    const text = clip([
      formatMemorySection('当前 Scope', [`- 标题: ${scope.title}`, `- 来源: ${scope.sourceKind}`, `- 线程: ${scope.threadKey}`].join('\n')),
      transcript ? formatMemorySection('最近会话摘要', transcript) : '',
      dailySections,
    ].filter(Boolean).join('\n\n'), MAX_L1_CHARS)

    const refs = [
      this.makeMemoryRef('l1', 'Scope 会话摘要', null, `Scope ${scope.title} 的最近会话摘要`),
      ...dayFiles.map((path) => this.makeMemoryRef('l1', path.split('/').pop() || path, path, '当日操作日志')),
    ]
    return { text, refs, chars: text.length }
  }

  private resolveTriggers(text: string): Array<{ trigger: TriggerDefinition; sections: string[]; refs: PromptMemoryRef[] }> {
    const hits: Array<{ trigger: TriggerDefinition; sections: string[]; refs: PromptMemoryRef[] }> = []
    for (const trigger of TRIGGERS) {
      trigger.pattern.lastIndex = 0
      if (!trigger.pattern.test(text)) continue
      const sections: string[] = []
      const refs: PromptMemoryRef[] = []
      for (const ref of trigger.refs) {
        const body = this.readMemoryFile(ref.path).trim()
        if (!body) continue
        sections.push(formatMemorySection(ref.title, body))
        refs.push(this.makeMemoryRef('l2', ref.title, ref.path, ref.summary, trigger.id, Boolean(ref.sensitive)))
      }
      hits.push({ trigger, sections, refs })
    }
    return hits
  }

  async buildForScopedRun(params: {
    scope: ConversationScope
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>
  }): Promise<PromptAssemblyResult> {
    const l0 = this.loadL0()
    const l1 = await this.loadL1(params.scope)
    const userText = extractTextFromMessage(params.message)
    const triggerMatches = this.resolveTriggers(userText)
    const l2Sections = triggerMatches.flatMap((item) => item.sections)
    const { l1Text, l2Text, budget } = applyBudget({ l0Text: l0.text, l1Text: l1.text, l2Sections })

    const bootstrapMessages = [
      l1Text ? formatMemorySection('L1 会话上下文', l1Text) : '',
      l2Text ? formatMemorySection('L2 按需规则', l2Text) : '',
    ].filter(Boolean)
    const memoryRefs = [
      ...l0.refs,
      ...l1.refs,
      ...triggerMatches.flatMap((item) => item.refs),
    ]
    const triggerHits = triggerMatches.map(({ trigger, refs }) => ({
      id: trigger.id,
      label: trigger.label,
      module: trigger.module,
      blocking: trigger.blocking,
      refs: refs.map((ref) => ref.id),
    }))

    return {
      systemPrompt: [
        '你是 Ready 应用中的 AI 助手，面向自媒体创作者。你擅长内容策划、文案写作、数据分析和创意建议。请使用简洁清晰的中文回答。',
        formatMemorySection('L0 常驻记忆', l0.text),
        '若命中 Pre-Action Trigger，必须先吸收对应规则再执行动作。',
      ].join('\n\n'),
      bootstrapMessages,
      memoryRefs,
      triggerHits,
      contextBudget: budget,
    }
  }

  applyToMessage(
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
    assembly: PromptAssemblyResult,
  ) {
    return prependBootstrap(message, assembly.bootstrapMessages)
  }

  recordRunOutcome(params: { scope: ConversationScope; finalText: string; usedTools: string[]; success: boolean }): void {
    const day = this.now().toISOString().slice(0, 10)
    const path = join(this.getMemoryRoot(), 'memory', `${day}.md`)
    const lines = [
      `## ${this.now().toISOString()}`,
      `- scope: ${params.scope.title}`,
      `- success: ${params.success ? 'yes' : 'no'}`,
      params.usedTools.length > 0 ? `- tools: ${params.usedTools.join(', ')}` : null,
      params.finalText.trim() ? `- summary: ${clip(params.finalText.trim(), 600).replace(/\n+/g, ' ')}` : null,
      '',
    ].filter(Boolean)
    appendFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  }
}
