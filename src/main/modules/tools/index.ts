import {
  getAnthropicTools as getBrowserAnthropicTools,
  getOpenAITools as getBrowserOpenAITools,
  executeBrowserTool,
} from './browser-tools'
import {
  getCalendarAnthropicTools,
  getCalendarOpenAITools,
  executeCalendarTool,
} from './calendar-tools'
import {
  getDocumentAnthropicTools,
  getDocumentOpenAITools,
  executeDocumentTool,
} from './document-tools'
import {
  getRSSAnthropicTools,
  getRSSOpenAITools,
  executeRSSTool,
} from './rss-tools'
import {
  getSkillAnthropicTools,
  getSkillOpenAITools,
  executeSkillTool,
} from './skills-tools'
import {
  getSystemAnthropicTools,
  getSystemOpenAITools,
  executeSystemTool,
} from './system-tools'
import {
  getFeishuAnthropicTools,
  getFeishuOpenAITools,
  executeFeishuTool,
} from './feishu-tools'
import {
  getMemoryAnthropicTools,
  getMemoryOpenAITools,
  executeMemoryTool,
} from './memory-tools'

export function getAnthropicTools(): Array<Record<string, unknown>> {
  return [
    ...getBrowserAnthropicTools(),
    ...getDocumentAnthropicTools(),
    ...getRSSAnthropicTools(),
    ...getCalendarAnthropicTools(),
    ...getSkillAnthropicTools(),
    ...getSystemAnthropicTools(),
    ...getFeishuAnthropicTools(),
    ...getMemoryAnthropicTools(),
  ]
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return [
    ...getBrowserOpenAITools(),
    ...getDocumentOpenAITools(),
    ...getRSSOpenAITools(),
    ...getCalendarOpenAITools(),
    ...getSkillOpenAITools(),
    ...getSystemOpenAITools(),
    ...getFeishuOpenAITools(),
    ...getMemoryOpenAITools(),
  ]
}

export { executeBrowserTool, executeSkillTool, executeFeishuTool, executeMemoryTool }
export { executeDocumentTool }
export { executeRSSTool }
export { executeCalendarTool }
export { executeSystemTool }
export { getDocumentAnthropicTools, getDocumentOpenAITools }
export { getMemoryAnthropicTools, getMemoryOpenAITools }
export { executeToolCall } from './tool-executor'
export type { ToolContext } from './tool-executor'
