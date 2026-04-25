import type { ZodObject, ZodRawShape } from 'zod'
import { getSkillsRuntimeManager, type SkillState } from '../skills-runtime/runtime-manager'
import { rememberSkillRun } from '../agent-control/session-continuity'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tool-result-types'
import {
  readSkillTaskProjection,
  recordSkillTaskEvent,
  type SkillTaskEventStatus,
} from '../agent-control/skill-task-tracker'
import type {
  SkillActionDefinition,
  SkillInputValue,
} from '../../../shared/skill-execution-types'
import { STATIC_SKILL_TOOL_NAMES as STATIC_SKILL_TOOL_NAMES_PURE } from './skills-tools-static'
import { getLastReferenceSkill } from '../agent-control/skill-reference-hints'
import { filterSkillPrimitivesBySession } from './skill-tool-session-gate'
import { PRIMITIVE_TOOL_DEFS } from './skill-primitives/tool-defs'
import {
  executeAskUser,
  executeReadArtifact,
  executeRunShell,
  executeWriteArtifact,
} from './skill-primitives'
import { SHELL_ALLOWLIST } from './skill-primitives/run-shell'
import { getAskUserQuestionEmitter } from '../agent-control/ask-user-bridge'
import { getSkillHostController } from '../skills-runtime/skill-host-controller'
import {
  toAnthropicTool,
  toOpenAITool,
  type SkillToolDef,
  type ToolParam,
} from './skill-tool-types'
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

/**
 * Phase 4: skill_executions state machine retired. The 6 execution-control
 * tools (skill_get_state / skill_submit_* / skill_restart_from_step /
 * skill_cancel_execution) no longer exist. The LLM-facing tool list is now
 * just skill_action tools + the 4 skill primitives (gated by reference-skill
 * hint presence).
 */
function getSkillToolDefs(sessionId?: string): SkillToolDef[] {
  const hasReferenceHint = (sid: string) => getLastReferenceSkill(sid) !== null

  const primitiveTools = filterSkillPrimitivesBySession(
    PRIMITIVE_TOOL_DEFS,
    sessionId,
    // Phase 4: hasActiveExecution is permanently false — no execution state.
    () => false,
    hasReferenceHint,
  )
  return [...getSkillActionToolDefs(), ...primitiveTools]
}

/**
 * Phase 4 stub — the in-memory todo tracker replaces SkillExecutionDetail as
 * the projection source. PR2 rewrites this to consume SkillTaskTracker state +
 * EphemeralExecutionStore.findPendingForSession. For PR1 we always return
 * null so the renderer task card falls through to generic conversation view.
 */
function buildSkillProjectionPatch(params: {
  sessionId?: string
  skillId?: string
}): Record<string, unknown> | null {
  const projection = readSkillTaskProjection(params)
  return projection ? { ...projection } : null
}

function formatRunResult(result: {
  success: boolean
  stdout: string
  stderr: string
  outputDir?: string
  error?: string
  command: string[]
  // Phase 4: mode='workflow' is deprecated; runSkill no longer returns it in
  // the todo-projection world. The union keeps 'workflow' here temporarily to
  // stay compatible with SkillRunResult until PR1-D trims that type.
  mode?: 'direct' | 'reference' | 'workflow'
  skillId?: string
  action?: string
}): string {
  // Reference-mode skills (`runtime: reference`, typically advisory SKILL.md
  // loads) are NOT subprocess executions — they read a markdown guidance file.
  // Wrapping their content in `Command:` / `STDOUT:` envelopes misleads the
  // model and has been observed to trigger redundant guidance probes for a
  // state that never exists. Emit a compact header that marks the payload as
  // guidance and explicitly tells the model no state is tracked.
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
  return sections.join('\n\n') || 'Skill execution completed.'
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Decide which skillId the Phase 1 primitives should operate on for the
 * current session. Phase 4: there's no active-execution concept, so the
 * decision is driven entirely by the reference-skill hint registered by the
 * orchestrator. Returns null when no hint is armed — handlers refuse with a
 * structured `primitive_no_skill_context` errorKind.
 */
function resolvePrimitiveSkillId(sessionId?: string): string | null {
  if (!sessionId) return null
  const hint = getLastReferenceSkill(sessionId)
  if (hint && hint.id) return hint.id
  return null
}

function findSkillName(manager: ReturnType<typeof getSkillsRuntimeManager>, skillId?: string | null): string | undefined {
  if (!skillId) return undefined
  return manager.listSkills().find((skill) => skill.id === skillId)?.name || skillId
}

function artifactLabel(path?: string | null): string | null {
  if (!path) return null
  return path.split(/[\\/]/).pop() || path
}

function attachSkillProjection(output: string | ToolExecutionOutput, params: {
  sessionId?: string
  skillId?: string
}): ToolExecutionOutput {
  const normalized = normalizeToolExecutionOutput(output)
  const projectionPatch = buildSkillProjectionPatch(params)
  if (!projectionPatch) return normalized
  return createToolExecutionOutput(normalized.text, {
    shape: 'projection_patch',
    data: normalized.data,
    projectionPatch,
    interactionHint: normalized.interactionHint,
  })
}

function recordPrimitiveOutcome(params: {
  sessionId?: string
  skillId?: string | null
  skillName?: string
  toolName: string
  status: SkillTaskEventStatus
  message?: string
  output?: ToolExecutionOutput
}): void {
  const data = params.output?.data || {}
  const artifactPath = typeof data.absolutePath === 'string'
    ? data.absolutePath
    : typeof data.stdoutArtifactPath === 'string'
      ? data.stdoutArtifactPath
      : typeof data.stderrArtifactPath === 'string'
        ? data.stderrArtifactPath
        : null
  recordSkillTaskEvent({
    sessionId: params.sessionId,
    skillId: params.skillId || undefined,
    skillName: params.skillName,
    toolName: params.toolName,
    status: params.status,
    message: params.message,
    artifactPath,
    artifactLabel: artifactLabel(artifactPath),
  })
}

export function getSkillAnthropicTools(sessionId?: string): Array<Record<string, unknown>> {
  return getSkillToolDefs(sessionId).map(toAnthropicTool)
}

export function getSkillOpenAITools(sessionId?: string): Array<Record<string, unknown>> {
  return getSkillToolDefs(sessionId).map(toOpenAITool)
}

// Handler lookup always sees the full skill tool set (action + primitives).
// Gating is a LISTING concern, not an execution concern.
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
  // Phase 4: registerRunCleanup parameter kept for signature stability with
  // tool-runtime-context-builder + run-resource-reaper contract test, but no
  // longer used (the only previous use — cancel-execution cleanup on
  // orphaned workflow — is gone along with the state machine).
  _registerRunCleanup?: (cleanup: () => void | Promise<void>) => void,
  abortSignal?: AbortSignal,
): Promise<string | ToolExecutionOutput> {
  const tool = findSkillToolByName(toolName)
  if (!tool) {
    return `Unknown skill tool: ${toolName}`
  }

  const manager = getSkillsRuntimeManager()

  if (tool.kind === 'primitive') {
    const skillId = resolvePrimitiveSkillId(sessionId)
    const skillName = findSkillName(manager, skillId)
    if (tool.name === 'skill_ask_user') {
      recordPrimitiveOutcome({
        sessionId,
        skillId,
        skillName,
        toolName,
        status: 'blocked',
        message: asString(args.question) || '等待用户补充信息',
      })
      try {
        const output = await executeAskUser(
          {
            question: asString(args.question),
            options: Array.isArray(args.options)
              ? (args.options as unknown[]).filter((v) => typeof v === 'string') as string[]
              : undefined,
            placeholder: typeof args.placeholder === 'string' ? args.placeholder : undefined,
          },
          {
            sessionId,
            skillId: skillId || undefined,
            signal: abortSignal,
            emitAskUserQuestion: getAskUserQuestionEmitter(),
          },
        )
        recordPrimitiveOutcome({
          sessionId,
          skillId,
          skillName,
          toolName,
          status: 'done',
          message: '用户已回复',
          output,
        })
        return attachSkillProjection(output, { sessionId, skillId: skillId || undefined })
      } catch (error) {
        recordPrimitiveOutcome({
          sessionId,
          skillId,
          skillName,
          toolName,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    if (!skillId) {
      return createToolExecutionOutput(
        `Cannot invoke ${toolName}: no active skill execution or reference-skill hint for this session. Load a skill first, then retry.`,
        {
          shape: 'json',
          data: {
            errorKind: 'primitive_no_skill_context',
            toolName,
            sessionId: sessionId || null,
          },
        },
      )
    }
    if (tool.name === 'skill_run_shell') {
      try {
        // B-arch-4 — when the active reference-skill declares
        // host_requirements.shell_allowlist_extensions, fold them into the
        // base SHELL_ALLOWLIST so skill-specific commands (e.g. ffmpeg for
        // video skills, when added) are accepted only while that hint is
        // armed. Other sessions / non-skill tool calls keep the base list.
        const referenceSkillId = sessionId ? (getLastReferenceSkill(sessionId)?.id ?? null) : null
        const skillDef = manager.listSkills().find((skill) => skill.id === skillId)
        const hostRequirements = skillDef?.hostRequirements ?? null
        const effectiveAllowlist = getSkillHostController().getEffectiveShellAllowlist(
          sessionId,
          referenceSkillId,
          SHELL_ALLOWLIST,
          hostRequirements,
        )
        const output = await executeRunShell(
          {
            command: asString(args.command),
            timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
            stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
          },
          {
            skillId,
            signal: abortSignal,
            runtimeBinDir: manager.getRuntimeBinDir(),
            venvBinDir: manager.getSharedVenvBinDir(),
            effectiveAllowlist,
          },
        )
        recordPrimitiveOutcome({ sessionId, skillId, skillName, toolName, status: 'done', output })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          sessionId,
          skillId,
          skillName,
          toolName,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    if (tool.name === 'skill_write_artifact') {
      try {
        const output = await executeWriteArtifact(
          {
            relativePath: asString(args.relativePath),
            content: typeof args.content === 'string' ? args.content : '',
            encoding: args.encoding === 'base64' ? 'base64' : 'utf-8',
          },
          { skillId },
        )
        recordPrimitiveOutcome({ sessionId, skillId, skillName, toolName, status: 'done', output })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          sessionId,
          skillId,
          skillName,
          toolName,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    if (tool.name === 'skill_read_artifact') {
      try {
        const output = await executeReadArtifact(
          {
            relativePath: asString(args.relativePath),
            maxBytes: typeof args.maxBytes === 'number' ? args.maxBytes : undefined,
          },
          { skillId },
        )
        recordPrimitiveOutcome({ sessionId, skillId, skillName, toolName, status: 'done', output })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          sessionId,
          skillId,
          skillName,
          toolName,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    return `Unknown skill primitive: ${toolName}`
  }

  // Phase 4: execution_control (skill_get_state / skill_submit_* /
  // skill_restart_from_step / skill_cancel_execution) branch retired.

  const result = await manager.runSkill({
    skillId: tool.skillId || '',
    action: tool.action || '',
    params: args,
    timeoutMs: tool.timeoutMs,
    triggerType: 'tool',
    sessionId,
  })
  const formatted = formatRunResult(result)
  recordSkillTaskEvent({
    sessionId,
    skillId: tool.skillId || undefined,
    skillName: findSkillName(manager, tool.skillId),
    toolName,
    // B-arch-4 — when SkillRunResult.status is populated by
    // SkillHostController.detectStatus, propagate it (so 'blocked' surfaces in
    // the task projection). Falls back to the legacy success-mapping when the
    // skill didn't opt into host_requirements.status_detection.
    status: result.status ?? (result.success ? 'done' : 'error'),
    message: result.success ? undefined : result.error || result.stderr || '技能执行失败',
    artifactPath: result.outputDir || undefined,
    artifactLabel: result.outputDir ? '技能输出目录' : undefined,
  })
  rememberSkillRun(sessionId, {
    toolName,
    skillId: tool.skillId || '',
    action: tool.action || '',
    success: result.success,
    summary: formatted.slice(0, 240),
  })
  const projectionPatch = buildSkillProjectionPatch({
    sessionId,
    skillId: tool.skillId || undefined,
  })
  if (!projectionPatch) return formatted
  return createToolExecutionOutput(formatted, { projectionPatch })
}

export type { SkillToolDef, ToolParam, SkillActionDefinition }
// Phase 4: SkillInputValue re-export preserved as a type-only passthrough for
// callers that still import it from here (no runtime impact).
export type { SkillInputValue }
