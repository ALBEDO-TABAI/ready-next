import { getSkillsRuntimeManager, type SkillState } from '../skills-runtime/runtime-manager'
import { rememberSkillRun } from '../agent-control/session-continuity'
import type {
  SkillActionDefinition,
  SkillExecutionDetail,
  SkillInputValue,
  SkillParamDefinition,
} from '../../../shared/skill-execution-types'

type ToolParam = SkillParamDefinition

type SkillToolKind = 'skill_action' | 'execution_control'

interface SkillToolDef {
  name: string
  description: string
  kind: SkillToolKind
  skillId?: string
  action?: string
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

const EXECUTION_TOOL_DEFS: SkillToolDef[] = [
  {
    name: 'skill_get_state',
    description: '读取当前 skill execution 状态、当前 blocker、已完成步骤和最近产物。若不提供 executionId，会优先读取当前会话最近的活跃 execution。',
    kind: 'execution_control',
    params: [
      { name: 'executionId', type: 'string', description: '可选，execution ID', required: false },
      { name: 'skillId', type: 'string', description: '可选，限定 skill ID', required: false },
    ],
  },
  {
    name: 'skill_submit_input',
    description: '向一个被 need_input 阻塞的 execution 提交输入并继续推进。',
    kind: 'execution_control',
    params: [
      { name: 'executionId', type: 'string', description: 'execution ID', required: true },
      { name: 'inputs', type: 'object', description: '输入对象，例如 {"forceSubtitleMode":"funasr"}', required: true },
    ],
  },
  {
    name: 'skill_submit_confirmation',
    description: '提交 confirmation 结果并继续执行 skill workflow。',
    kind: 'execution_control',
    params: [
      { name: 'executionId', type: 'string', description: 'execution ID', required: true },
      { name: 'stepId', type: 'string', description: '当前 confirmation step ID', required: true },
      { name: 'confirmed', type: 'boolean', description: '是否确认继续', required: true },
    ],
  },
  {
    name: 'skill_submit_agent_result',
    description: '向 need_agent_result 阶段提交 Claude 生成的正文和结构化输出，并继续推进 workflow。',
    kind: 'execution_control',
    params: [
      { name: 'executionId', type: 'string', description: 'execution ID', required: true },
      { name: 'stepId', type: 'string', description: '当前 agent_task step ID', required: true },
      { name: 'textContent', type: 'string', description: '生成的正文内容', required: false },
      { name: 'outputs', type: 'object', description: '可选结构化 outputs 对象', required: false },
    ],
  },
  {
    name: 'skill_restart_from_step',
    description: '从指定 step 重新开始 skill execution，并删除该步及后续步骤的状态与产物。',
    kind: 'execution_control',
    params: [
      { name: 'executionId', type: 'string', description: 'execution ID', required: true },
      { name: 'stepId', type: 'string', description: '要重跑的 step ID', required: true },
      { name: 'inputs', type: 'object', description: '可选，覆盖输入对象', required: false },
    ],
  },
  {
    name: 'skill_cancel_execution',
    description: '取消一个正在进行的 skill execution。',
    kind: 'execution_control',
    params: [
      { name: 'executionId', type: 'string', description: 'execution ID', required: true },
    ],
  },
]

export const STATIC_SKILL_TOOL_NAMES: string[] = [
  ...Object.values(STATIC_TOOL_NAMES),
  ...EXECUTION_TOOL_DEFS.map((tool) => tool.name),
]

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

function buildSkillToolDescription(skill: SkillState, action: SkillActionDefinition): string {
  if (skill.executionMode === 'advisory' && action.runtime === 'reference') {
    return `读取并应用技能 ${skill.name} 的方法说明，再继续完成当前任务。${skill.description}`
  }
  if (skill.executionMode === 'workflow' && skill.defaultAction === action.name) {
    return `${skill.name} · 启动宿主管理的 workflow skill。执行后会自动推进到 blocker，并允许继续提交输入、确认或 agent 结果。`
  }
  return `${skill.name} · ${skill.description} · ${action.description}`
}

function getSkillActionToolDefs(): SkillToolDef[] {
  const manager = getSkillsRuntimeManager()
  return manager.listSkills().flatMap((skill) =>
    skill.actions
      .filter((action) => action.visibility !== 'internal')
      .map((action) => ({
        name: buildToolName(skill.id, action.name),
        description: buildSkillToolDescription(skill, action),
        kind: 'skill_action' as const,
        skillId: skill.id,
        action: action.name,
        timeoutMs: action.timeoutMs,
        params: action.params,
      })),
  )
}

function getSkillToolDefs(): SkillToolDef[] {
  return [...getSkillActionToolDefs(), ...EXECUTION_TOOL_DEFS]
}

function toSchemaParam(param: ToolParam): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: param.type,
    description: param.description,
  }
  if (param.type === 'array') {
    schema.items = { type: 'string' }
  }
  if (param.type === 'object') {
    schema.additionalProperties = true
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

function formatExecutionDetail(detail: SkillExecutionDetail): string {
  const recentSteps = detail.steps.slice(-4).map((step) => `${step.stepId}(${step.status})`).join(', ')
  const recentArtifacts = detail.artifacts.slice(-4).map((artifact) => artifact.path || artifact.label || artifact.id).join(', ')
  return [
    `Execution ID: ${detail.id}`,
    `Skill: ${detail.skillId}`,
    `Status: ${detail.status}`,
    detail.currentStepId ? `Current step: ${detail.currentStepId}` : '',
    detail.blocker ? `Blocker: ${detail.blocker.type} - ${detail.blocker.message}` : '',
    recentSteps ? `Recent steps: ${recentSteps}` : '',
    recentArtifacts ? `Recent artifacts: ${recentArtifacts}` : '',
  ].filter(Boolean).join('\n')
}

function formatRunResult(result: {
  success: boolean
  stdout: string
  stderr: string
  outputDir?: string
  error?: string
  command: string[]
  mode?: 'direct' | 'workflow'
  execution?: SkillExecutionDetail | null
  blocker?: { type: string; message: string } | null
}): string {
  if (result.mode === 'workflow' && result.execution) {
    return formatExecutionDetail(result.execution)
  }
  if (!result.success) {
    const details = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n')
    return `Skill execution failed.\n${details}`.trim()
  }

  const sections: string[] = []
  if (result.outputDir) sections.push(`Output directory: ${result.outputDir}`)
  if (result.command.length > 0) sections.push(`Command: ${result.command.join(' ')}`)
  if (result.stdout.trim()) sections.push(`STDOUT:\n${result.stdout.trim()}`)
  if (result.stderr.trim()) sections.push(`STDERR:\n${result.stderr.trim()}`)
  if (result.blocker) sections.push(`Blocker: ${result.blocker.type} - ${result.blocker.message}`)
  return sections.join('\n\n') || 'Skill execution completed.'
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function asRecord(value: unknown): Record<string, SkillInputValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, SkillInputValue>
}

function findExecutionForSession(sessionId?: string, executionId?: string, skillId?: string): SkillExecutionDetail | null {
  const manager = getSkillsRuntimeManager()
  if (executionId) {
    return manager.getExecution(executionId)
  }
  if (!sessionId) return null
  const active = manager.listExecutions(10, sessionId, true)
  const matched = skillId ? active.find((item) => item.skillId === skillId) : active[0]
  if (!matched) return null
  return manager.getExecution(matched.id)
}

export function getSkillAnthropicTools(): Array<Record<string, unknown>> {
  return getSkillToolDefs().map(toAnthropicTool)
}

export function getSkillOpenAITools(): Array<Record<string, unknown>> {
  return getSkillToolDefs().map(toOpenAITool)
}

export function findSkillToolByName(toolName: string): SkillToolDef | null {
  return getSkillToolDefs().find((item) => item.name === toolName) || null
}

export function findSkillToolBySkillAction(skillId: string, actionName?: string): SkillToolDef | null {
  const defs = getSkillActionToolDefs().filter((item) => item.skillId === skillId)
  if (!actionName) return defs[0] || null
  return defs.find((item) => item.action === actionName) || defs[0] || null
}

export async function executeSkillTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void,
): Promise<string> {
  const tool = findSkillToolByName(toolName)
  if (!tool) {
    return `Unknown skill tool: ${toolName}`
  }

  const manager = getSkillsRuntimeManager()

  if (tool.kind === 'execution_control') {
    switch (tool.name) {
      case 'skill_get_state': {
        const detail = findExecutionForSession(sessionId, asString(args.executionId), asString(args.skillId))
        return detail ? formatExecutionDetail(detail) : 'No active skill execution found.'
      }
      case 'skill_submit_input': {
        const detail = await manager.submitExecutionInput(asString(args.executionId), asRecord(args.inputs))
        return formatExecutionDetail(detail)
      }
      case 'skill_submit_confirmation': {
        const detail = await manager.submitExecutionConfirmation(
          asString(args.executionId),
          asString(args.stepId),
          asBoolean(args.confirmed),
        )
        return formatExecutionDetail(detail)
      }
      case 'skill_submit_agent_result': {
        const detail = await manager.submitExecutionAgentResult({
          executionId: asString(args.executionId),
          stepId: asString(args.stepId),
          textContent: typeof args.textContent === 'string' ? args.textContent : undefined,
          outputs: asRecord(args.outputs),
        })
        return formatExecutionDetail(detail)
      }
      case 'skill_restart_from_step': {
        const detail = await manager.restartExecutionFromStep(
          asString(args.executionId),
          asString(args.stepId),
          asRecord(args.inputs),
        )
        return formatExecutionDetail(detail)
      }
      case 'skill_cancel_execution': {
        const detail = manager.cancelExecution(asString(args.executionId))
        return detail ? formatExecutionDetail(detail) : 'Execution not found.'
      }
      default:
        return `Unknown skill tool: ${toolName}`
    }
  }

  const result = await manager.runSkill({
    skillId: tool.skillId || '',
    action: tool.action || '',
    params: args,
    timeoutMs: tool.timeoutMs,
    triggerType: 'tool',
    sessionId,
    executionMode: 'workflow',
  })
  if (
    registerRunCleanup
    && result.mode === 'workflow'
    && result.execution?.id
    && result.execution.status !== 'completed'
    && result.execution.status !== 'failed'
    && result.execution.status !== 'cancelled'
  ) {
    const executionId = result.execution.id
    registerRunCleanup(() => {
      manager.cancelExecution(executionId)
    })
  }
  const formatted = formatRunResult(result)
  rememberSkillRun(sessionId, {
    toolName,
    skillId: tool.skillId || '',
    action: tool.action || '',
    success: result.success,
    summary: formatted.slice(0, 240),
  })
  return formatted
}

export type { SkillToolDef, ToolParam, SkillActionDefinition }
