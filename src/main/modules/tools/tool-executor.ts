/**
 * Unified tool dispatcher.
 * Routes tool calls by prefix to the appropriate executor.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import type { AgentControlRuntime } from '../agent-control/runtime'
import {
  defaultToolRegistry,
  resolveToolInputSchemaForExecution,
} from '../agent-control/tool-registry'
import type { ToolDefinition } from '../agent-control/tool-definition'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'
import type { ConversationScope } from '../agent-control/types'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import type { ToolRuntimeActiveFrameContext } from '../agent-control/tool-runtime'
import type { TurnFeatureFlags } from '../agent-control/turn-feature-flags'
import {
  SKILL_TOOL_AUTHORIZATION_NOT_SET,
  checkSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../agent-control/skill-tool-authorization'
import { PRIMITIVE_TOOL_DEFS } from './skill-primitives/tool-defs'
import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../skills-runtime/runtime-manager'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
  type ToolInteractionHint,
} from '../agent-control/tool-result-types'
import { executeBrowserTool } from './browser-tools'
import { executeCalendarTool } from './calendar-tools'
import { executeDocumentTool } from './document-tools'
import { executeRSSTool } from './rss-tools'
import { executeSkillTool, findSkillToolByNameForExecution } from './skills-tools'
import { executeSystemTool } from './system-tools'
import { executeFeishuTool } from './feishu-tools'
import { executeMemoryTool } from './memory-tools'
import { executePetTool } from './pet-tools'
import { executeSessionRecallTool } from './session-recall-tools'
import {
  ToolDomainError,
  errorKindFor,
  errorMessageOf,
  isTerminalInfrastructureError,
} from './tool-errors'
import { validateToolInput } from './tool-input-validator'
import {
  buildToolNotAllowedMessage,
  buildUnknownToolMessage,
  normalizeAllowedToolSet,
} from './tool-not-allowed-message'
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from './skills-tools-static'

export interface ToolContext {
  browserController?: BrowserController | null
  sidecarManager?: SidecarManager | null
  runtime?: AgentControlRuntime | null
  scope?: ConversationScope | null
  allowedToolNames?: Set<string> | string[] | null
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abortSignal?: AbortSignal
  sessionId?: string
  scopeId?: string
  runId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  taskProjectionId?: string
  frameSkillId?: string | null
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
  agentContext?: AgentSpawnContext | null
  /**
   * Phase 3 (skill-child-loop) — same-turn live active-frame slot. Forwarded
   * by `toToolExecutorContext` so domain dispatchers (notably
   * `skills-tools.ts` for `skill_read_artifact`) can prefer fresh artifact
   * roots / handles emitted by an earlier tool in the same batch.
   */
  activeFrame?: ToolRuntimeActiveFrameContext | null
  invoker?: 'model' | 'child_runner' | 'host'
  allowInternal?: boolean
  turnFeatureFlags?: TurnFeatureFlags
  skillRuntimeManager?: SkillsRuntimeManager | null
  childInternalSkillAction?: {
    skillId: string
    action: string
    childRunId: string
    outputDir: string | null
    runStatePath: string | null
  } | null
  /**
   * Stage 4 W3 — per-turn skill tool authorization. The default value
   * (`SKILL_TOOL_AUTHORIZATION_NOT_SET`, i.e. `mode:'none', reason:'not_set'`)
   * is treated as a back-compat short-circuit by admission below: skill_*
   * tools pass through, and the new `authorization_denied` errorKind is
   * never emitted. Once W3b cutover wires `turn-engine` and `ToolPolicy`
   * to populate real authorization, the default is no longer reached for
   * model turns and the cutover becomes live.
   */
  authorization?: SkillToolAuthorization
}

function isFrameScopedInternalSkillActionAllowed(
  toolName: string,
  context: ToolContext,
  allowedToolNames: Set<string> | null,
): boolean {
  if (!allowedToolNames?.has(toolName)) return false
  const skillTool = findSkillToolByNameForExecution(toolName)
  const skillId = skillTool?.kind === 'skill_action'
    ? skillTool.skillId
    : STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]?.skillId || null
  if (!skillId) return false
  const frameSkillId = context.frameSkillId || context.activeFrame?.runContract?.skillId || null
  return Boolean(frameSkillId && frameSkillId === skillId)
}

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionOutput> {
  // Check registration BEFORE admission so the model can distinguish
  // "fabricated tool name" from "real tool but not allowed this turn" —
  // see tool-not-allowed-message.ts for the rationale.
  const definition = defaultToolRegistry.getToolDefinitionForExecution(toolName)
  if (!definition) {
    return createToolExecutionOutput(buildUnknownToolMessage(toolName), {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        reason: 'tool_not_registered',
        toolName,
      },
    })
  }

  const allowedToolNames = normalizeAllowedToolSet(context.allowedToolNames)
  const allowsChildInternal =
    context.allowInternal === true && context.invoker === 'child_runner'
  const allowsFrameScopedInternal =
    definition.executionVisibility === 'internal'
    && isFrameScopedInternalSkillActionAllowed(toolName, context, allowedToolNames)
  const childInternalStrictAdmission =
    context.turnFeatureFlags?.childInternalStrictAdmission ?? true
  if (
    childInternalStrictAdmission
    && definition.executionVisibility === 'internal'
    && !allowsChildInternal
    && !allowsFrameScopedInternal
  ) {
    return createToolExecutionOutput(`Tool ${toolName} is internal-only and cannot be called from this context.`, {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        reason: 'internal_tool_not_allowed',
        toolName,
      },
    })
  }

  // Stage 4 W3 — per-turn skill tool authorization MUST run BEFORE the
  // legacy allowedToolNames checks below, otherwise a model-issued
  // skill_* tool that's both unauthorized AND missing from this turn's
  // allowedToolNames would be intercepted as `tool_restricted_this_turn`
  // (legacy errorKind) instead of the canonical `authorization_denied`
  // (per v6 plan §10 互斥语义: skill 工具被 admission 拒 → authorization_denied).
  //
  // Only enforced for model-issued calls (invoker:'model' or undefined).
  // child_runner / host invokers continue through their own admission
  // paths (the child-internal admission above for child_runner, and the
  // legacy allowedToolNames gate below for host).
  //
  // The `'not_set'` default (W3a) short-circuits to allow, preserving
  // pre-cutover behavior — the legacy allowedToolNames check below
  // still runs for skill_* tools, so models hitting unallowed skills
  // still see `tool_restricted_this_turn` until W3b switches the
  // default away from `not_set` for model turns.
  const invoker = context.invoker ?? 'model'
  const authorization = context.authorization ?? SKILL_TOOL_AUTHORIZATION_NOT_SET
  if (invoker === 'model' && toolName.startsWith('skill_')) {
    const isPrimitive = PRIMITIVE_TOOL_DEFS.some((d) => d.name === toolName)
    const decision = checkSkillToolAuthorization(toolName, authorization, isPrimitive)
    if (!decision.allowed) {
      logAgentMetric(TOOL_ERROR_METRICS.authorizationDenied, {
        toolName,
        reason: decision.reason,
        mode: authorization.mode,
        source: authorization.mode === 'selected' ? authorization.source : null,
        sessionId: context.sessionId || null,
      })
      return createToolExecutionOutput(
        `Tool ${toolName} is not authorized for this turn (${decision.reason}).`,
        {
          shape: 'json',
          data: {
            errorKind: 'authorization_denied',
            reason: decision.reason,
            toolName,
          },
        },
      )
    }
  }

  if (definition.requiresExplicitAllowlist && !allowedToolNames?.has(toolName)) {
    return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames || new Set()), {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        reason: 'tool_restricted_this_turn',
        toolName,
      },
    })
  }
  if (allowedToolNames && !allowedToolNames.has(toolName)) {
    return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames), {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        reason: 'tool_restricted_this_turn',
        toolName,
      },
    })
  }

  if (context.abortSignal?.aborted) {
    const error = new Error('Operation aborted')
    error.name = 'AbortError'
    throw error
  }

  // Phase 2 (B plan child-loop): single-source schema admission. The
  // resolver in `tool-registry.ts` consults the static registry first
  // (which already includes static-manifest-derived skill action schemas)
  // and falls back to the dynamic `getSkillActionSchemas()` cache for
  // user-installed manifests. The split-schema hazard — where a forced
  // dispatch could pass through `turn-frame-steering` because the dynamic
  // cache was invisible there but be rejected later in the executor — is
  // collapsed into one ordering. Tools with no registered schema pass
  // through unchanged because `validateToolInput` treats a missing entry
  // as `{ ok: true }`.
  {
    const resolvedSchema = resolveToolInputSchemaForExecution(toolName)
    const schemas = resolvedSchema ? { [toolName]: resolvedSchema } : {}
    const outcome = validateToolInput(toolName, args, schemas)
    if (!outcome.ok) {
      logAgentMetric(TOOL_ERROR_METRICS.inputValidation, {
        toolName,
        domain: definition.domain,
        issueCount: outcome.issueCount,
        firstCode: outcome.firstCode,
        firstPath: outcome.firstPath,
        sessionId: context.sessionId || null,
      })
      return outcome.output
    }
    args = outcome.data
  }

  try {
    const rawResult = await (async () => {
      switch (definition.domain) {
        case 'browser':
          if (!context.browserController) {
            return 'Browser controller is not available'
          }
          return executeBrowserTool(toolName, args, context.browserController, context.abortSignal, context.sessionId)

        case 'document':
          return executeDocumentTool(toolName, args, {
            emitToolAction: context.emitToolAction,
            requestModuleToolAction: context.requestModuleToolAction,
          })

        case 'file':
          {
            const { executeFileManagementTool } = await import('./file-management-tools')
            return executeFileManagementTool(toolName, args, { abortSignal: context.abortSignal })
          }

        case 'rss':
          return executeRSSTool(toolName, args, { emitToolAction: context.emitToolAction })

        case 'calendar':
          return executeCalendarTool(toolName, args, { emitToolAction: context.emitToolAction })

        case 'skill':
          if (definition.executionVisibility === 'internal' && allowsChildInternal) {
            return executeChildInternalSkillTool(toolName, args, definition, context)
          }
          return executeSkillTool(toolName, args, context.sessionId, context.registerRunCleanup, context.abortSignal, context.agentContext, {
            scopeId: context.scopeId || context.scope?.id || context.sessionId,
            runId: context.runId,
            frameSkillId: context.frameSkillId ?? null,
            // Phase 3 — forward the live active-frame slot so the skill
            // dispatcher (`skill_read_artifact`) can prefer fresh artifact
            // roots emitted by earlier tools in the same batch.
            activeFrame: context.activeFrame ?? null,
          })

        case 'system':
          return executeSystemTool(toolName, args)

        case 'feishu':
          return executeFeishuTool(toolName, args, { sidecarManager: context.sidecarManager })

        case 'memory':
          return executeMemoryTool(toolName, args, context)

        case 'session':
          return executeSessionRecallTool(toolName, args, context)

        case 'pet':
          return executePetTool(toolName, args)

        default:
          return `Unknown tool: ${toolName}`
      }
    })()

    return toStructuredToolResult(toolName, rawResult)
  } catch (error) {
    if (isTerminalInfrastructureError(error)) {
      throw error
    }
    const kind = errorKindFor(error)
    const message = errorMessageOf(error)
    const detail = error instanceof ToolDomainError ? error.detail : null
    logAgentMetric(TOOL_ERROR_METRICS.surfaced, {
      toolName,
      errorKind: kind,
      message: message.slice(0, 200),
    })
    // Phase 4: skill_execution_missing metric retired with the
    // skill_executions state machine. The errorKind still exists for other
    // callers but no longer has a dedicated bucketed metric.
    void detail
    return createToolExecutionOutput(`工具 ${toolName} 失败：${message}`, {
      shape: 'json',
      data: {
        errorKind: kind,
        toolName,
        message,
        detail,
      },
    })
  }
}

function toStructuredToolResult(toolName: string, rawResult: string | ToolExecutionOutput): ToolExecutionOutput {
  const normalized = normalizeToolExecutionOutput(rawResult)
  if (normalized.interactionHint) {
    return normalized
  }

  const interactionHint = inferToolInteractionHint(toolName, normalized.text)
  return interactionHint
    ? {
      ...normalized,
      interactionHint,
    }
    : normalized
}

function inferToolInteractionHint(toolName: string, resultText: string): ToolInteractionHint | null {
  if (!toolName.startsWith('skill_')) return null
  const blockerType = resultText.match(/^Blocker:\s*([^-\n]+)-/m)?.[1]?.trim() || null
  if (blockerType === 'need_confirmation') {
    return 'awaiting_confirmation'
  }
  if (blockerType === 'need_input' || blockerType === 'need_agent_result') {
    return 'awaiting_clarification'
  }
  return null
}

async function executeChildInternalSkillTool(
  toolName: string,
  args: Record<string, unknown>,
  definition: ToolDefinition,
  context: ToolContext,
): Promise<ToolExecutionOutput> {
  const action = context.childInternalSkillAction
  if (!action) {
    return createInternalSkillError({
      errorKind: 'host_unavailable',
      message: 'Child internal skill context is missing',
      detail: { reason: 'child_internal_context_missing', toolName },
    })
  }

  const runtimeManager = context.skillRuntimeManager ?? await getDefaultSkillsRuntimeManager()
  if (!runtimeManager) {
    return createInternalSkillError({
      errorKind: 'host_unavailable',
      message: 'Skills runtime manager is not configured',
      detail: { reason: 'runtime_manager_missing', toolName },
    })
  }

  const request: SkillRunRequest = {
    skillId: action.skillId,
    action: action.action,
    params: {
      ...args,
      __childRunContext: {
        childRunId: action.childRunId,
        scopeId: context.scopeId || context.scope?.id || context.sessionId || null,
        sessionId: context.sessionId || null,
        outputDir: action.outputDir,
        runStatePath: action.runStatePath,
      },
    },
    timeoutMs: definition.executionTimeoutMs,
    signal: context.abortSignal,
    triggerType: 'tool',
    sessionId: context.sessionId,
    agentContext: context.agentContext,
  }

  const fromChild = (runtimeManager as unknown as {
    runSkillFromChildRunner?: (req: SkillRunRequest) => Promise<SkillRunResult>
  }).runSkillFromChildRunner
  if (!fromChild) {
    return createInternalSkillError({
      errorKind: 'host_unavailable',
      message: 'Skills runtime manager does not expose child runner execution',
      detail: {
        reason: 'runSkillFromChildRunner_missing',
        toolName,
        skillId: action.skillId,
        action: action.action,
        childRunId: action.childRunId,
      },
    })
  }

  let result: SkillRunResult
  try {
    result = await fromChild.call(runtimeManager, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const looksAborted = context.abortSignal?.aborted
      || (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message)))
    return createInternalSkillError({
      errorKind: looksAborted ? 'aborted' : 'tool_failed',
      message,
      detail: {
        toolName,
        skillId: action.skillId,
        action: action.action,
        childRunId: action.childRunId,
      },
    })
  }

  const text = result.success
    ? `child gateway ok: ${action.skillId}/${action.action}`
    : `child gateway skill_action_failed: ${result.error || 'skill returned success=false'}`
  return createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      ok: result.success,
      skillId: action.skillId,
      action: action.action,
      childRunId: action.childRunId,
      runStatus: result.status ?? null,
      outputDir: result.outputDir ?? null,
      skillRunResult: result as unknown as Record<string, unknown>,
    },
  })
}

function createInternalSkillError(args: {
  errorKind: string
  message: string
  detail?: Record<string, unknown>
}): ToolExecutionOutput {
  return createToolExecutionOutput(`child gateway ${args.errorKind}: ${args.message}`, {
    shape: 'json',
    data: {
      status: 'error',
      errorKind: args.errorKind,
      message: args.message,
      ...(args.detail || {}),
    },
  })
}

async function getDefaultSkillsRuntimeManager(): Promise<SkillsRuntimeManager | null> {
  try {
    const mod = await import('../skills-runtime/runtime-manager')
    return mod.getSkillsRuntimeManager()
  } catch {
    return null
  }
}
