import { formatSingleLinePreview } from './toolTracePreview'

export type ToolActivityKind =
  | 'research'
  | 'browser'
  | 'image'
  | 'document'
  | 'file'
  | 'skill'
  | 'command'
  | 'generic'

export interface ToolActivityPresentation {
  kind: ToolActivityKind
  title: string
}

export interface ToolActivityInput {
  status: 'running' | 'done' | 'error'
  toolName?: string
  callText?: string | null
  resultText?: string | null
  callDetail?: string
}

type ToolActivityRule = {
  kind: ToolActivityKind
  matches: (name: string) => boolean
  labels: { running: string; done: string; error: string }
}

const TOOL_ACTIVITY_RULES: ToolActivityRule[] = [
  { kind: 'generic', matches: (name) => name === 'declare_completion_criteria', labels: { running: '确认交付要求', done: '交付要求已确认', error: '交付要求需要核对' } },
  { kind: 'generic', matches: (name) => name === 'ask_user_questions', labels: { running: '确认问题', done: '问题已确认', error: '问题需要重新确认' } },
  { kind: 'research', matches: (name) => name === 'session_search', labels: { running: '搜索历史记录', done: '历史记录检索完成', error: '历史记录检索失败' } },
  { kind: 'research', matches: (name) => name === 'web_search_domains', labels: { running: '查询搜索范围', done: '搜索范围已确认', error: '搜索范围查询失败' } },
  { kind: 'research', matches: (name) => name === 'web_search', labels: { running: '搜索网页', done: '网页检索完成', error: '网页检索失败' } },
  { kind: 'research', matches: (name) => name === 'web_fetch', labels: { running: '读取网页', done: '网页已读取', error: '网页读取失败' } },
  { kind: 'research', matches: (name) => name === 'web_clip_url', labels: { running: '保存网页资料', done: '网页资料已保存', error: '网页资料保存失败' } },
  { kind: 'file', matches: (name) => name === 'file_inventory', labels: { running: '查看文件夹', done: '文件夹已查看', error: '文件夹需要核对' } },
  { kind: 'file', matches: (name) => name === 'skill_read_artifact', labels: { running: '读取文件', done: '文件已读取', error: '文件读取失败' } },
  { kind: 'file', matches: (name) => name === 'skill_write_artifact', labels: { running: '准备文件', done: '文件已准备', error: '文件准备失败' } },
  { kind: 'file', matches: (name) => name === 'skill_export_artifact', labels: { running: '保存文件', done: '文件已保存', error: '文件保存失败' } },
  { kind: 'file', matches: (name) => name === 'present_file', labels: { running: '整理文件', done: '文件已整理', error: '文件整理失败' } },
  { kind: 'image', matches: (name) => name === 'generate_image', labels: { running: '生成图片', done: '图片已生成', error: '图片生成失败' } },
  { kind: 'browser', matches: (name) => name.startsWith('browser_') || name === 'use_browser', labels: { running: '操作网页', done: '网页操作完成', error: '网页操作失败' } },
  { kind: 'document', matches: (name) => name.startsWith('document_') || name.startsWith('widget_'), labels: { running: '处理文档', done: '文档处理完成', error: '文档处理失败' } },
  { kind: 'file', matches: (name) => name.startsWith('file_') || name.startsWith('tag_forge_') || name === 'apply_patch' || /^skill_(?:read|write|export)_artifact$/.test(name), labels: { running: '处理文件', done: '文件处理完成', error: '文件处理失败' } },
  { kind: 'command', matches: (name) => /command|shell|exec|stdin/.test(name), labels: { running: '运行本地命令', done: '本地命令完成', error: '本地命令失败' } },
  { kind: 'skill', matches: (name) => name === 'use_skill' || name.startsWith('skill_'), labels: { running: '运行技能', done: '技能运行完成', error: '技能运行失败' } },
]

function toolNameFromInput(input: ToolActivityInput): string {
  if (input.toolName) return input.toolName.toLowerCase()
  return input.callText?.match(/^([a-zA-Z_][\w:.-]*)\s*\(/)?.[1]?.toLowerCase() || ''
}

function toolDescriptor(input: ToolActivityInput): string {
  if (!input.callDetail) return ''
  let detail: Record<string, unknown>
  try {
    const parsed = JSON.parse(input.callDetail) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    detail = parsed as Record<string, unknown>
  } catch {
    return ''
  }
  for (const key of ['query', 'url', 'prompt', 'title', 'name', 'relativePath', 'path', 'command']) {
    const value = detail[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const compact = formatSingleLinePreview(value.trim())
    return [...compact].length > 64 ? `${[...compact].slice(0, 63).join('')}…` : compact
  }
  return ''
}

export function resolveToolActivityPresentation(input: ToolActivityInput): ToolActivityPresentation {
  const rule = TOOL_ACTIVITY_RULES.find((candidate) => candidate.matches(toolNameFromInput(input)))
  if (!rule) {
    const fallback = input.status === 'running' ? input.callText : (input.resultText || input.callText)
    return {
      kind: 'generic',
      title: fallback
        ? formatSingleLinePreview(fallback)
        : input.status === 'running'
          ? '处理任务'
          : input.status === 'done'
            ? '任务步骤已完成'
            : '任务步骤需要核对',
    }
  }
  const descriptor = toolDescriptor(input)
  const label = rule.labels[input.status]
  return {
    kind: rule.kind,
    title: descriptor ? `${label} · ${descriptor}` : label,
  }
}
