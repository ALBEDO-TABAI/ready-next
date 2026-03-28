import type { ChatAttachment } from './types'
import type { CommandResult } from './documentActions'

interface SkillCommandAction {
  name: string
}

interface SkillCommandCatalogEntry {
  id: string
  name: string
  description: string
  installed: boolean
  source?: 'embedded' | 'custom'
  defaultAction?: string
  actions?: SkillCommandAction[]
  managedPath?: string
  sourcePath?: string
}

interface NormalizedSkillInvocation {
  skill: SkillCommandCatalogEntry
  action: string
  params?: Record<string, unknown>
}

function normalizeSkillToken(value: string): string {
  return value.trim().toLowerCase()
}

async function loadSkillCatalog(): Promise<SkillCommandCatalogEntry[] | null> {
  if (typeof window === 'undefined' || !window.electronAPI?.skills?.list) return null
  const listRes = await window.electronAPI.skills.list()
  if (!listRes.success || !listRes.data) return null
  return listRes.data as SkillCommandCatalogEntry[]
}

function resolveSkillToken(
  input: string,
  attachments: ChatAttachment[],
  catalog: SkillCommandCatalogEntry[],
): SkillCommandCatalogEntry | null {
  const lowered = normalizeSkillToken(input)
  if (!lowered) return null

  const byId = catalog.find((skill) => normalizeSkillToken(skill.id) === lowered)
  if (byId) return byId

  const byName = catalog.find((skill) => normalizeSkillToken(skill.name) === lowered)
  if (byName) return byName

  const fromAttachment = attachments.find((att) => {
    if (att.source !== 'skill-folder') return false
    if (att.skillId && normalizeSkillToken(att.skillId) === lowered) return true
    if (normalizeSkillToken(att.name) === lowered) return true
    return normalizeSkillToken(att.skillFolderPath || att.path).includes(lowered)
  })

  if (fromAttachment?.skillId) {
    const byAttachmentId = catalog.find((skill) => normalizeSkillToken(skill.id) === normalizeSkillToken(fromAttachment.skillId || ''))
    if (byAttachmentId) return byAttachmentId
  }

  if (fromAttachment) {
    const attachmentPath = normalizeSkillToken(fromAttachment.skillFolderPath || fromAttachment.path)
    const byPath = catalog.find((skill) => {
      const candidates = [skill.sourcePath, skill.managedPath]
        .filter((value): value is string => Boolean(value))
        .map((value) => normalizeSkillToken(value))
      return candidates.some((candidate) => candidate === attachmentPath || candidate.includes(lowered) || attachmentPath.includes(candidate))
    })
    if (byPath) return byPath

    const byAttachmentName = catalog.find((skill) => normalizeSkillToken(skill.name) === normalizeSkillToken(fromAttachment.name))
    if (byAttachmentName) return byAttachmentName
  }

  const fuzzyMatches = catalog.filter((skill) =>
    normalizeSkillToken(skill.id).includes(lowered) || normalizeSkillToken(skill.name).includes(lowered),
  )
  return fuzzyMatches.length === 1 ? fuzzyMatches[0] : null
}

export function extractSkillCommandFromText(raw: string): string | null {
  const text = String(raw || '')
  const idx = text.toLowerCase().indexOf('/skill ')
  if (idx < 0) return null
  return text.slice(idx).trim()
}

function tryResolveAttachmentPath(reference: unknown, attachments: ChatAttachment[]): string | undefined {
  const raw = String(reference || '').trim()
  if (!raw) return undefined
  if (!raw.startsWith('ms://')) return raw
  const videoAttachment = attachments.find((att) => att.type === 'video' && att.path)
  if (videoAttachment?.path) return videoAttachment.path
  const imageAttachment = attachments.find((att) => att.type === 'image' && att.path)
  return imageAttachment?.path
}

function normalizeLegacySkillInvocation(
  skill: SkillCommandCatalogEntry,
  action: string,
  params: Record<string, unknown> | undefined,
  attachments: ChatAttachment[],
): NormalizedSkillInvocation {
  const availableActions = new Set((skill.actions || []).map((item) => item.name))
  const defaultAction = skill.defaultAction || skill.actions?.[0]?.name || ''
  let nextAction = action || defaultAction
  const nextParams = { ...(params || {}) }

  if (!availableActions.has(nextAction) && ['analyze', 'run', 'execute', 'start'].includes(nextAction)) {
    nextAction = defaultAction
  }

  if (skill.id === 'video-copy-analyzer') {
    if (typeof nextParams.video_path !== 'undefined' && typeof nextParams.input === 'undefined') {
      nextParams.input = tryResolveAttachmentPath(nextParams.video_path, attachments) || nextParams.video_path
    }
    if (typeof nextParams.output_path !== 'undefined' && typeof nextParams.outputDir === 'undefined') {
      nextParams.outputDir = nextParams.output_path
    }
    const options = nextParams.options && typeof nextParams.options === 'object' && !Array.isArray(nextParams.options)
      ? nextParams.options as Record<string, unknown>
      : undefined
    if (options) {
      if (typeof options.forceSubtitleMode !== 'undefined' && typeof nextParams.forceSubtitleMode === 'undefined') {
        nextParams.forceSubtitleMode = options.forceSubtitleMode
      }
      if (typeof options.model !== 'undefined' && typeof nextParams.model === 'undefined') {
        nextParams.model = options.model
      }
      if (typeof options.language !== 'undefined' && typeof nextParams.language === 'undefined') {
        nextParams.language = options.language
      }
    }
    delete nextParams.video_path
    delete nextParams.output_path
    delete nextParams.options
    if (!nextAction || !availableActions.has(nextAction)) {
      nextAction = defaultAction || 'video_copy_analyze'
    }
  }

  if (skill.id === 'video-expert-analyzer') {
    if (typeof nextParams.video_path !== 'undefined' && typeof nextParams.url === 'undefined') {
      nextParams.url = tryResolveAttachmentPath(nextParams.video_path, attachments) || nextParams.video_path
    }
    if (typeof nextParams.output_path !== 'undefined' && typeof nextParams.outputDir === 'undefined') {
      nextParams.outputDir = nextParams.output_path
    }
    delete nextParams.video_path
    delete nextParams.output_path
    delete nextParams.options
    if (!nextAction || !availableActions.has(nextAction)) {
      nextAction = defaultAction || 'video_expert_pipeline'
    }
  }

  if (!availableActions.has(nextAction) && defaultAction) {
    nextAction = defaultAction
  }

  return {
    skill,
    action: nextAction,
    params: Object.keys(nextParams).length > 0 ? nextParams : undefined,
  }
}

export async function runSkillCommand(raw: string, attachments: ChatAttachment[]): Promise<CommandResult> {
  const commandText = extractSkillCommandFromText(raw) || raw
  const body = commandText.replace(/^\/skill\s*/i, '').trim()
  if (!body || body === 'help') {
    return {
      handled: true,
      text: [
        '技能命令用法：',
        '`/skill list`',
        '`/skill <skillId> <action> <JSON参数>`',
        '示例：`/skill lets-go-rss rss_update {"digest":true,"noLlm":true}`',
      ].join('\n'),
    }
  }

  const catalog = await loadSkillCatalog()
  if (!catalog) {
    return { handled: true, text: '当前环境不支持读取技能列表', isError: true }
  }

  if (body === 'list') {
    const items = catalog.map((item) => {
      const defaultAction = item.defaultAction || item.actions?.[0]?.name
      const sourceLabel = item.source === 'custom' ? '自定义' : '系统'
      return `- ${item.id} (${sourceLabel} · ${item.installed ? '已安装' : '未安装'}) · ${item.description}${defaultAction ? ` · 默认动作: ${defaultAction}` : ''}`
    })
    return { handled: true, text: `可用技能：\n${items.join('\n')}` }
  }

  const firstSpace = body.indexOf(' ')
  const skillToken = firstSpace >= 0 ? body.slice(0, firstSpace).trim() : body
  const afterSkill = firstSpace >= 0 ? body.slice(firstSpace + 1).trim() : ''
  const secondSpace = afterSkill.indexOf(' ')
  const action = secondSpace >= 0 ? afterSkill.slice(0, secondSpace).trim() : afterSkill
  const paramsRaw = secondSpace >= 0 ? afterSkill.slice(secondSpace + 1).trim() : ''

  const skill = resolveSkillToken(skillToken, attachments, catalog)
  if (!skill) {
    return { handled: true, text: `无法识别技能：${skillToken}`, isError: true }
  }

  let params: Record<string, unknown> | undefined
  if (paramsRaw) {
    try {
      params = JSON.parse(paramsRaw) as Record<string, unknown>
    } catch {
      return { handled: true, text: '技能参数必须是合法 JSON，例如 {"url":"https://..."}', isError: true }
    }
  }

  const normalized = normalizeLegacySkillInvocation(skill, action, params, attachments)
  const finalAction = normalized.action
  if (!finalAction) {
    return { handled: true, text: `请指定技能动作：/skill ${skill.id} <action>`, isError: true }
  }

  if (typeof window === 'undefined' || !window.electronAPI?.skills) {
    return { handled: true, text: '当前环境不支持技能执行', isError: true }
  }

  const installRes = await window.electronAPI.skills.install({ skillId: skill.id })
  if (!installRes.success) {
    return { handled: true, text: `技能安装失败：${installRes.error || skill.id}`, isError: true }
  }

  const runRes = await window.electronAPI.skills.run({
    skillId: skill.id,
    action: finalAction,
    params: normalized.params,
    executionMode: 'workflow',
  })
  if (!runRes.success) {
    return { handled: true, text: `技能执行失败：${runRes.error || `${skill.id}/${finalAction}`}`, isError: true }
  }

  const output = runRes.data as { stdout?: string; outputDir?: string } | undefined
  const stdout = output?.stdout?.trim() || ''
  const preview = stdout ? `\n\n${stdout.slice(0, 1500)}` : ''
  const outputDir = output?.outputDir ? `\n输出目录：${output.outputDir}` : ''
  return { handled: true, text: `技能执行完成：${skill.id}/${finalAction}${outputDir}${preview}` }
}
