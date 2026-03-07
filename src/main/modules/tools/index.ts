import {
  getAnthropicTools as getBrowserAnthropicTools,
  getOpenAITools as getBrowserOpenAITools,
  executeBrowserTool,
} from './browser-tools'
import {
  getDocumentAnthropicTools,
  getDocumentOpenAITools,
  executeDocumentTool,
} from './document-tools'
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

export function getAnthropicTools(): Array<Record<string, unknown>> {
  return [
    ...getBrowserAnthropicTools(),
    ...getDocumentAnthropicTools(),
    ...getSkillAnthropicTools(),
    ...getSystemAnthropicTools(),
  ]
}

export function getOpenAITools(): Array<Record<string, unknown>> {
  return [
    ...getBrowserOpenAITools(),
    ...getDocumentOpenAITools(),
    ...getSkillOpenAITools(),
    ...getSystemOpenAITools(),
  ]
}

export { executeBrowserTool, executeSkillTool }
export { executeDocumentTool }
export { executeSystemTool }
export { getDocumentAnthropicTools, getDocumentOpenAITools }
export { executeToolCall } from './tool-executor'
export type { ToolContext } from './tool-executor'
