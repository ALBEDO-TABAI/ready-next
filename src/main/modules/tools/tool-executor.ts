/**
 * Unified tool dispatcher.
 * Routes tool calls by prefix to the appropriate executor.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import { executeBrowserTool } from './browser-tools'
import { executeCalendarTool } from './calendar-tools'
import { executeDesignTool } from './design-tools'
import { executeDocumentTool } from './document-tools'
import { executeRSSTool } from './rss-tools'
import { executeSkillTool } from './skills-tools'
import { executeSystemTool } from './system-tools'
import { executeVideoTool } from './video-tools'
import { executeFeishuTool } from './feishu-tools'

export interface ToolContext {
  browserController?: BrowserController | null
  sidecarManager?: SidecarManager | null
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
    return executeDocumentTool(toolName, args, { emitToolAction: context.emitToolAction })
  }

  if (toolName.startsWith('design_')) {
    return executeDesignTool(toolName, args, {
      emitToolAction: context.emitToolAction,
      requestToolAction: context.requestModuleToolAction,
    })
  }

  if (toolName.startsWith('video_')) {
    return executeVideoTool(toolName, args, { emitToolAction: context.emitToolAction })
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

  return `Unknown tool: ${toolName}`
}
