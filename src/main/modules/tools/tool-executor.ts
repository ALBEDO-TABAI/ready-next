/**
 * Unified tool dispatcher.
 * Routes tool calls by prefix to the appropriate executor.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import type { AgentControlRuntime } from '../agent-control/runtime'
import { defaultToolGateway } from '../agent-control/tool-gateway'
import type { ConversationScope } from '../agent-control/types'
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
import { executeSkillTool } from './skills-tools'
import { executeSystemTool } from './system-tools'
import { executeFeishuTool } from './feishu-tools'
import { executeMemoryTool } from './memory-tools'
import { executeSessionRecallTool } from './session-recall-tools'

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
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
}

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionOutput> {
  const allowedToolNames = context.allowedToolNames instanceof Set
    ? context.allowedToolNames
    : Array.isArray(context.allowedToolNames)
      ? new Set(context.allowedToolNames)
      : null
  if (allowedToolNames && !allowedToolNames.has(toolName)) {
    return createToolExecutionOutput(`Tool not allowed in current context: ${toolName}`, {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        toolName,
      },
    })
  }

  const definition = defaultToolGateway.getToolDefinition(toolName)
  if (!definition) {
    return createToolExecutionOutput(`Unknown tool: ${toolName}`, {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        toolName,
      },
    })
  }

  if (context.abortSignal?.aborted) {
    const error = new Error('Operation aborted')
    error.name = 'AbortError'
    throw error
  }

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

      case 'rss':
        return executeRSSTool(toolName, args, { emitToolAction: context.emitToolAction })

      case 'calendar':
        return executeCalendarTool(toolName, args, { emitToolAction: context.emitToolAction })

      case 'skill':
        return executeSkillTool(toolName, args, context.sessionId, context.registerRunCleanup)

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
