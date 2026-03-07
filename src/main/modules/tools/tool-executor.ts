/**
 * Unified tool dispatcher.
 * Routes tool calls by prefix to the appropriate executor.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import { executeBrowserTool } from './browser-tools'
import { executeDocumentTool } from './document-tools'
import { executeSkillTool } from './skills-tools'
import { executeSystemTool } from './system-tools'

export interface ToolContext {
  browserController?: BrowserController | null
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
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
    return executeDocumentTool(toolName, args, { emitToolAction: context.emitToolAction })
  }

  if (toolName.startsWith('skill_')) {
    return executeSkillTool(toolName, args, context.sessionId)
  }

  if (toolName.startsWith('system_')) {
    return executeSystemTool(toolName, args)
  }

  // Future: calendar_*, rss_* tool families
  return `Unknown tool: ${toolName}`
}
