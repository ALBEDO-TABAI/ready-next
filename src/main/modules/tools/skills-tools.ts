import type { ZodObject, ZodRawShape } from 'zod'
import { getSkillsRuntimeManager, type SkillState } from '../skills-runtime/runtime-manager'
import { rememberSkillRun } from '../agent-control/session-continuity'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tool-result-types'
import type {
  SkillActionDefinition,
  SkillExecutionDetail,
  SkillInputValue,
} from '../../../shared/skill-execution-types'
import { STATIC_SKILL_TOOL_NAMES as STATIC_SKILL_TOOL_NAMES_PURE } from './skills-tools-static'
import {
  EXECUTION_NOT_FOUND_RE,
  buildSkillExecutionMissingOutput,
  type SkillCoordinatorOperation,
} from './skill-execution-missing'
import {
  EXECUTION_TOOL_DEFS,
  toAnthropicTool,
  toOpenAITool,
  type SkillToolDef,
  type ToolParam,
} from './skill-execution-tool-defs'
import { paramListToZodObject } from './paramList-to-zod'

export { STATIC_SKILL_TOOL_NAMES_PURE as STATIC_SKILL_TOOL_NAMES }

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

// Dynamic-skill-action Zod schema cache (Phase 2.5 PR 12). Keyed by tool name
// (buildToolName is deterministic per (skillId, actionName)). Built lazily on
// first call and rebuilt when the underlying manifest set changes. Changes in
// skill set are detected via a cheap "signature" of name+action pairs — cheaper
// than subscribing to runtime-manager events and covers manifest reload, skill
// add/remove, and action visibility toggles.
let skillActionSchemaCache: Record<string, ZodObject<ZodRawShape>> = {}
let skillActionSchemaSignature = ''

function computeSkillActionSignature(defs: SkillToolDef[]): string {
  return defs
    .map((d) => `${d.name}:${d.params.length}:${d.params.map((p) => `${p.name}/${p.type}/${p.required?'1':'0'}`).join(',')}`)
    .sort()
    .join('|')
}

export function getSkillActionSchemas(): Record<string, ZodObject<ZodRawShape>> {
  try {
    const defs = getSkillActionToolDefs()
    const sig = computeSkillActionSignature(defs)
    if (sig !== skillActionSchemaSignature) {
      const next: Record<string, ZodObject<ZodRawShape>> = {}
      for (const def of defs) {
        if (def.kind !== 'skill_action') continue
        try {
          next[def.name] = paramListToZodObject(def.params)
        } catch {
          // If a malformed manifest breaks derivation, skip that one rather
          // than crashing the registry; static tools keep working.
        }
      }
      skillActionSchemaCache = next
      skillActionSchemaSignature = sig
    }
    return skillActionSchemaCache
  } catch {
    // Runtime manager unavailable (e.g. boot ordering) — return empty so the
    // registry falls through to static schemas only.
    return {}
  }
}

function getSkillToolDefs(): SkillToolDef[] {
  return [...getSkillActionToolDefs(), ...EXECUTION_TOOL_DEFS]
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

function toSkillStepStatus(status: string): 'pending' | 'running' | 'blocked' | 'done' | 'error' {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'done' || normalized === 'completed' || normalized === 'success') return 'done'
  if (normalized === 'running' || normalized === 'active' || normalized === 'in_progress') return 'running'
  if (normalized === 'waiting' || normalized === 'blocked' || normalized === 'paused') return 'blocked'
  if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'error') return 'error'
  return 'pending'
}

function toSkillWaitingFor(blockerType?: string | null): 'none' | 'input' | 'confirmation' | 'agent_result' | 'background' {
  if (blockerType === 'need_input') return 'input'
  if (blockerType === 'need_confirmation') return 'confirmation'
  if (blockerType === 'need_agent_result') return 'agent_result'
  return blockerType ? 'background' : 'none'
}

function toSkillInteractionHint(blockerType?: string | null): 'awaiting_confirmation' | 'awaiting_clarification' | null {
  if (blockerType === 'need_confirmation') return 'awaiting_confirmation'
  if (blockerType === 'need_input' || blockerType === 'need_agent_result') {
    return 'awaiting_clarification'
  }
  return null
}

function buildSkillProjectionPatch(detail: SkillExecutionDetail): Record<string, unknown> {
  const waitingFor = toSkillWaitingFor(detail.blocker?.type || null)
  const resumableActions: Array<'continue' | 'retry' | 'open_artifact' | 'cancel'> = []
  if (waitingFor !== 'none') resumableActions.push('continue')
  if ((detail.artifacts || []).length > 0) resumableActions.push('open_artifact')
  if (detail.status === 'failed' || detail.status === 'cancelled') resumableActions.push('retry')
  resumableActions.push('cancel')

  return {
    module: 'skill',
    message: detail.blocker?.message || `当前步骤：${detail.currentStepId || '进行中'}`,
    taskTitle: `技能执行 · ${detail.skillId}`,
    taskSummary: detail.blocker?.message || `当前步骤：${detail.currentStepId || '进行中'}`,
    taskType: 'multi_step_task',
    interactionState:
      waitingFor === 'confirmation'
        ? 'awaiting_confirmation'
        : waitingFor === 'input' || waitingFor === 'agent_result'
          ? 'awaiting_clarification'
          : 'running',
    steps: detail.steps.map((step) => ({
      id: step.stepId,
      title: step.stepId,
      status: toSkillStepStatus(step.status),
      updatedAt: detail.updatedAt,
    })),
    currentStepId: detail.currentStepId || null,
    waitingFor,
    resumableActions,
    blockedReason: detail.blocker?.message || null,
    taskContinuation: {
      executionId: detail.id,
      stepId: detail.currentStepId || null,
      blockerType: detail.blocker?.type || null,
    },
    recentArtifacts: detail.artifacts.slice(-4).map((artifact) => ({
      id: artifact.id,
      module: 'skill',
      kind: 'skill-artifact',
      label: artifact.label || artifact.path || artifact.id || 'artifact',
      path: artifact.path || null,
      createdAt: detail.updatedAt,
    })),
  }
}

function createSkillExecutionOutput(detail: SkillExecutionDetail): ToolExecutionOutput {
  return createToolExecutionOutput(formatExecutionDetail(detail), {
    projectionPatch: buildSkillProjectionPatch(detail),
    interactionHint: toSkillInteractionHint(detail.blocker?.type || null),
  })
}

async function runSkillCoordinator(params: {
  executionId: string
  operation: SkillCoordinatorOperation
  sessionId?: string
  run: () => Promise<SkillExecutionDetail>
}): Promise<ToolExecutionOutput> {
  try {
    const detail = await params.run()
    return createSkillExecutionOutput(detail)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!EXECUTION_NOT_FOUND_RE.test(message)) {
      throw error
    }
    const activeExecution = findExecutionForSession(params.sessionId)
    return buildSkillExecutionMissingOutput({
      executionId: params.executionId,
      operation: params.operation,
      activeExecution,
      originalMessage: message,
    })
  }
}

function formatRunResult(result: {
  success: boolean
  stdout: string
  stderr: string
  outputDir?: string
  error?: string
  command: string[]
  mode?: 'direct' | 'workflow' | 'reference'
  skillId?: string
  action?: string
  execution?: SkillExecutionDetail | null
  blocker?: { type: string; message: string } | null
}): string {
  if (result.mode === 'workflow' && result.execution) {
    return formatExecutionDetail(result.execution)
  }

  // Reference-mode skills (`runtime: reference`, typically advisory SKILL.md
  // loads) are NOT subprocess executions — they read a markdown guidance file.
  // Wrapping their content in `Command:` / `STDOUT:` envelopes misleads the
  // model and has been observed to trigger redundant `skill_get_state` probes
  // for an execution that never exists. Emit a compact header that marks the
  // payload as guidance and explicitly tells the model no state is tracked.
  if (result.mode === 'reference') {
    if (!result.success) {
      const reason = result.error || result.stderr || 'unknown error'
      return `Skill reference load failed: ${reason}`
    }
    const header = `# Skill guidance (advisory, no execution state): ${result.skillId || 'skill'}${result.action ? ` / ${result.action}` : ''}`
    const body = result.stdout.trim()
    return body ? `${header}\n\n${body}` : header
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
): Promise<string | ToolExecutionOutput> {
  const tool = findSkillToolByName(toolName)
  if (!tool) {
    return `Unknown skill tool: ${toolName}`
  }

  const manager = getSkillsRuntimeManager()

  if (tool.kind === 'execution_control') {
    switch (tool.name) {
      case 'skill_get_state': {
        const explicitId = asString(args.executionId)
        const detail = findExecutionForSession(sessionId, explicitId, asString(args.skillId))
        if (detail) return createSkillExecutionOutput(detail)
        if (explicitId) {
          return buildSkillExecutionMissingOutput({
            executionId: explicitId,
            operation: 'get_state',
            activeExecution: findExecutionForSession(sessionId),
            originalMessage: `Execution not found: ${explicitId}`,
          })
        }
        return 'No active skill execution found.'
      }
      case 'skill_submit_input': {
        const executionId = asString(args.executionId)
        return runSkillCoordinator({
          executionId,
          operation: 'submit_input',
          sessionId,
          run: () => manager.submitExecutionInput(executionId, asRecord(args.inputs)),
        })
      }
      case 'skill_submit_confirmation': {
        const executionId = asString(args.executionId)
        return runSkillCoordinator({
          executionId,
          operation: 'submit_confirmation',
          sessionId,
          run: () => manager.submitExecutionConfirmation(
            executionId,
            asString(args.stepId),
            asBoolean(args.confirmed),
          ),
        })
      }
      case 'skill_submit_agent_result': {
        const executionId = asString(args.executionId)
        return runSkillCoordinator({
          executionId,
          operation: 'submit_agent_result',
          sessionId,
          run: () => manager.submitExecutionAgentResult({
            executionId,
            stepId: asString(args.stepId),
            textContent: typeof args.textContent === 'string' ? args.textContent : undefined,
            outputs: asRecord(args.outputs),
          }),
        })
      }
      case 'skill_restart_from_step': {
        const executionId = asString(args.executionId)
        return runSkillCoordinator({
          executionId,
          operation: 'restart_from_step',
          sessionId,
          run: () => manager.restartExecutionFromStep(
            executionId,
            asString(args.stepId),
            asRecord(args.inputs),
          ),
        })
      }
      case 'skill_cancel_execution': {
        const executionId = asString(args.executionId)
        const detail = manager.cancelExecution(executionId)
        if (detail) return createSkillExecutionOutput(detail)
        return buildSkillExecutionMissingOutput({
          executionId,
          operation: 'cancel_execution',
          activeExecution: findExecutionForSession(sessionId),
          originalMessage: `Execution not found: ${executionId}`,
        })
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
  return result.mode === 'workflow' && result.execution
    ? createSkillExecutionOutput(result.execution)
    : formatted
}

export type { SkillToolDef, ToolParam, SkillActionDefinition }
