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
  getDesignAnthropicTools,
  getDesignOpenAITools,
  executeDesignTool,
} from './design-tools'
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
  getVideoAnthropicTools,
  getVideoOpenAITools,
  executeVideoTool,
} from './video-tools'
import {
  getFeishuAnthropicTools,
  getFeishuOpenAITools,
  executeFeishuTool,
} from './feishu-tools'

export function getAnthropicTools(): Array<Record<string, unknown>> {
  return [
    ...getBrowserAnthropicTools(),
    ...getDocumentAnthropicTools(),
    ...getDesignAnthropicTools(),
    ...getVideoAnthropicTools(),
    ...getRSSAnthropicTools(),
    ...getCalendarAnthropicTools(),
    ...getSkillAnthropicTools(),
    ...getSystemAnthropicTools(),
    ...getFeishuAnthropicTools(),
  ]
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return [
    ...getBrowserOpenAITools(),
    ...getDocumentOpenAITools(),
    ...getDesignOpenAITools(),
    ...getVideoOpenAITools(),
    ...getRSSOpenAITools(),
    ...getCalendarOpenAITools(),
    ...getSkillOpenAITools(),
    ...getSystemOpenAITools(),
    ...getFeishuOpenAITools(),
  ]
}

export { executeBrowserTool, executeSkillTool, executeFeishuTool }
export { executeDocumentTool }
export { executeDesignTool }
export { executeVideoTool }
export { executeRSSTool }
export { executeCalendarTool }
export { executeSystemTool }
export { getDocumentAnthropicTools, getDocumentOpenAITools }
export { getDesignAnthropicTools, getDesignOpenAITools }
export { executeToolCall } from './tool-executor'
export type { ToolContext } from './tool-executor'
