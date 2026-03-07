import { getSkillsRuntimeManager, type SkillState } from '../skills-runtime/runtime-manager'
import { EMBEDDED_SKILLS } from '../skills-runtime/manifest'
import { rememberSkillRun } from '../agent-control/session-continuity'
import type { SkillActionDefinition, SkillParamDefinition } from '../skills-runtime/custom-skill-registry'

interface ToolParam extends SkillParamDefinition {}

interface SkillToolDef {
  name: string
  description: string
  skillId: string
  action: string
  timeoutMs?: number
  params: ToolParam[]
}

const STATIC_TOOL_NAMES: Record<string, string> = {
  'video-expert-analyzer:video_expert_pipeline': 'skill_video_expert_pipeline',
  'video-expert-analyzer:video_expert_ai_analyze': 'skill_video_expert_ai_analyze',
  'video-copy-analyzer:video_copy_analyze': 'skill_video_copy_analyze',
  'lets-go-rss:rss_add': 'skill_rss_add',
  'lets-go-rss:rss_update': 'skill_rss_update',
  'lets-go-rss:rss_status': 'skill_rss_status',
  'lets-go-rss:rss_list': 'skill_rss_list',
  'lets-go-rss:rss_stats': 'skill_rss_stats',
}

function sanitizeToolToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'skill'
}

function buildToolName(skillId: string, actionName: string): string {
  const staticName = STATIC_TOOL_NAMES[`${skillId}:${actionName}`]
  if (staticName) return staticName
  return `skill_${sanitizeToolToken(skillId)}_${sanitizeToolToken(actionName)}`
}

function buildSkillToolDescription(
  skill: SkillState,
  action: SkillActionDefinition,
): string {
  if (skill.source === 'embedded' && EMBEDDED_SKILLS.some((item) => item.id === skill.id)) {
    return action.description
  }

  if (action.runtime === 'reference') {
    return `使用技能 ${skill.name} 的说明与方法完成当前任务；先读取并应用 skill 内容，再继续执行。${skill.description}`
  }

  return `${skill.name} · ${skill.description} · ${action.description}`
}

function getSkillToolDefs(): SkillToolDef[] {
  const manager = getSkillsRuntimeManager()
  return manager.listSkills().flatMap((skill) =>
    skill.actions.map((action) => ({
      name: buildToolName(skill.id, action.name),
      description: buildSkillToolDescription(skill, action),
      skillId: skill.id,
      action: action.name,
      timeoutMs: action.timeoutMs,
      params: action.params,
    })),
  )
}

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: param.type,
    description: param.description,
  }
  if (param.enum) schema.enum = param.enum
  return schema
}

function toAnthropicTool(tool: SkillToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  }
}

function toOpenAITool(tool: SkillToolDef): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(tool.params.map((param) => [param.name, toSchemaParam(param)])),
        required: tool.params.filter((param) => param.required).map((param) => param.name),
      },
    },
  }
}

export function getSkillAnthropicTools(): Array<Record<string, unknown>> {
  return getSkillToolDefs().map(toAnthropicTool)
}

export function getSkillOpenAITools(): Array<Record<string, unknown>> {
  return getSkillToolDefs().map(toOpenAITool)
}

function formatRunResult(result: {
  success: boolean
  stdout: string
  stderr: string
  outputDir?: string
  error?: string
  command: string[]
}): string {
  if (!result.success) {
    const details = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n')
    return `Skill execution failed.\n${details}`.trim()
  }

  const sections: string[] = []
  if (result.outputDir) sections.push(`Output directory: ${result.outputDir}`)
  if (result.command.length > 0) sections.push(`Command: ${result.command.join(' ')}`)
  if (result.stdout.trim()) sections.push(`STDOUT:\n${result.stdout.trim()}`)
  if (result.stderr.trim()) sections.push(`STDERR:\n${result.stderr.trim()}`)
  return sections.join('\n\n') || 'Skill execution completed.'
}

export function findSkillToolByName(toolName: string): SkillToolDef | null {
  return getSkillToolDefs().find((item) => item.name === toolName) || null
}

export function findSkillToolBySkillAction(skillId: string, actionName?: string): SkillToolDef | null {
  const defs = getSkillToolDefs().filter((item) => item.skillId === skillId)
  if (!actionName) return defs[0] || null
  return defs.find((item) => item.action === actionName) || defs[0] || null
}

export async function executeSkillTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  const tool = findSkillToolByName(toolName)
  if (!tool) {
    return `Unknown skill tool: ${toolName}`
  }

  const manager = getSkillsRuntimeManager()
  const result = await manager.runSkill({
    skillId: tool.skillId,
    action: tool.action,
    params: args,
    timeoutMs: tool.timeoutMs,
    triggerType: 'tool',
  })
  const formatted = formatRunResult(result)
  rememberSkillRun(sessionId, {
    toolName,
    skillId: tool.skillId,
    action: tool.action,
    success: result.success,
    summary: formatted.slice(0, 240),
  })
  return formatted
}

export type { SkillToolDef, ToolParam, SkillActionDefinition }
