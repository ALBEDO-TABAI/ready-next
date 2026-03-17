/**
 * Unified tool dispatcher.
 * Routes tool calls by prefix to the appropriate executor.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import type { AgentControlRuntime } from '../agent-control/runtime'
import type { ConversationScope } from '../agent-control/types'
import { executeBrowserTool } from './browser-tools'
import { executeCalendarTool } from './calendar-tools'
import { executeDocumentTool } from './document-tools'
import { executeRSSTool } from './rss-tools'
import { executeSkillTool } from './skills-tools'
import { executeSystemTool } from './system-tools'
import { executeFeishuTool } from './feishu-tools'
import { executeMemoryTool } from './memory-tools'

export interface ToolContext {
  browserController?: BrowserController | null
  sidecarManager?: SidecarManager | null
  runtime?: AgentControlRuntime | null
  scope?: ConversationScope | null
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abortSignal?: AbortSignal
  sessionId?: string
}

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  if (toolName.startsWith('browser_')) {
    if (!context.browserController) {
      return 'Browser controller is not available'
    }
    return executeBrowserTool(toolName, args, context.browserController, context.abortSignal, context.sessionId)
  }

  if (toolName.startsWith('document_')) {
    return executeDocumentTool(toolName, args, {
      emitToolAction: context.emitToolAction,
      requestModuleToolAction: context.requestModuleToolAction,
    })
  }

  if (toolName.startsWith('rss_')) {
    return executeRSSTool(toolName, args, { emitToolAction: context.emitToolAction })
  }

  if (toolName.startsWith('calendar_')) {
    return executeCalendarTool(toolName, args, { emitToolAction: context.emitToolAction })
  }

  if (toolName.startsWith('skill_')) {
    return executeSkillTool(toolName, args, context.sessionId)
  }

  if (toolName.startsWith('system_')) {
    return executeSystemTool(toolName, args)
  }

  if (toolName.startsWith('feishu_')) {
    return executeFeishuTool(toolName, args, { sidecarManager: context.sidecarManager })
  }

  if (toolName.startsWith('memory_')) {
    return executeMemoryTool(toolName, args, context)
  }

  return `Unknown tool: ${toolName}`
}
