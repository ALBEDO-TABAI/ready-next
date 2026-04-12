import { defaultToolGateway } from '../agent-control/tool-gateway'
import { executeBrowserTool } from './browser-tools'
import {
  executeCalendarTool,
} from './calendar-tools'
import {
  executeDocumentTool,
} from './document-tools'
import {
  executeRSSTool,
} from './rss-tools'
import {
  executeSkillTool,
} from './skills-tools'
import {
  executeSystemTool,
} from './system-tools'
import {
  executeFeishuTool,
} from './feishu-tools'
import { executeMemoryTool } from './memory-tools'
import {
  executeSessionRecallTool,
} from './session-recall-tools'

export function getAnthropicTools(): Array<Record<string, unknown>> {
  return defaultToolGateway.getAnthropicToolsForGroups(defaultToolGateway.listCapabilityGroups().map((group) => group.id))
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return defaultToolGateway.getOpenAIToolsForGroups(defaultToolGateway.listCapabilityGroups().map((group) => group.id))
}

export { executeBrowserTool, executeSkillTool, executeFeishuTool, executeMemoryTool, executeSessionRecallTool }
export { executeDocumentTool }
export { executeRSSTool }
export { executeCalendarTool }
export { executeSystemTool }
export { executeToolCall } from './tool-executor'
export type { ToolContext } from './tool-executor'
