/**
 * Unified tool dispatcher.
 * Routes tool calls by prefix to the appropriate executor.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import type { AgentControlRuntime } from '../agent-control/runtime'
import { defaultToolRegistry } from '../agent-control/tool-registry'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'
import type { ConversationScope } from '../agent-control/types'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
  type ToolInteractionHint,
} from '../agent-control/tool-result-types'
import { executeBrowserTool } from './browser-tools'
import { executeCalendarTool } from './calendar-tools'
import { executeDocumentTool } from './document-tools'
import { executeFileManagementTool } from './file-management-tools'
import { executeRSSTool } from './rss-tools'
import { executeSkillTool, getSkillActionSchemas } from './skills-tools'
import { executeSystemTool } from './system-tools'
import { executeFeishuTool } from './feishu-tools'
import { executeMemoryTool } from './memory-tools'
import { executeSessionRecallTool } from './session-recall-tools'
import {
  ToolDomainError,
  errorKindFor,
  errorMessageOf,
  isTerminalInfrastructureError,
} from './tool-errors'
import { getToolInputSchemas } from './schemas'
import { validateToolInput } from './tool-input-validator'
import {
  buildToolNotAllowedMessage,
  buildUnknownToolMessage,
  normalizeAllowedToolSet,
} from './tool-not-allowed-message'

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

  // Phase 2.5: Zod input validation runs for every tool. The registry is the
  // union of every per-domain static map plus the dynamic skill-action cache
  // (PR 12 — user manifests derive to Zod schemas via paramListToZodObject,
  // cached in skills-tools.ts and refreshed when the skill set changes).
  // Tools with no registered schema pass through unchanged because
  // validateToolInput treats a missing entry as { ok: true }.
  {
    // Dynamic cache first, static second: static schemas (including the 6
    // skill control tools) always win over dynamic ones. This is a belt
    // against a hypothetical user manifest that accidentally names an
    // action the same as a reserved control-tool name.
    const mergedSchemas = { ...getSkillActionSchemas(), ...getToolInputSchemas() }
    const outcome = validateToolInput(toolName, args, mergedSchemas)
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
          return executeFileManagementTool(toolName, args, { abortSignal: context.abortSignal })

        case 'rss':
          return executeRSSTool(toolName, args, { emitToolAction: context.emitToolAction })

        case 'calendar':
          return executeCalendarTool(toolName, args, { emitToolAction: context.emitToolAction })

        case 'skill':
          return executeSkillTool(toolName, args, context.sessionId, context.registerRunCleanup, context.abortSignal, context.agentContext, {
            scopeId: context.scopeId || context.scope?.id || context.sessionId,
            runId: context.runId,
            frameSkillId: context.frameSkillId ?? null,
          })

        case 'system':
          return executeSystemTool(toolName, args)

        case 'feishu':
          return executeFeishuTool(toolName, args, { sidecarManager: context.sidecarManager })

        case 'memory':
          return executeMemoryTool(toolName, args, context)

        case 'session':
          return executeSessionRecallTool(toolName, args, context)

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
