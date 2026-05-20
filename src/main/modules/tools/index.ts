import { defaultToolGateway } from '../agent-control/tools-runtime/tool-gateway'
import type { ToolRegistryReader } from '../agent-control/tools-runtime/tool-registry'
import type { SkillToolAuthorization } from '../agent-control/skills/skill-tool-authorization'
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
import { executePetTool } from './pet-tools'
import {
  executeSessionRecallTool,
} from './session-recall-tools'

export function getAnthropicTools(
  authorization: SkillToolAuthorization,
  sessionId?: string,
  scopeId?: string,
): Array<Record<string, unknown>> {
  return defaultToolGateway.getAnthropicToolsForGroups(
    defaultToolGateway.listCapabilityGroups().map((group) => group.id),
    sessionId,
    authorization,
    scopeId,
  )
}

export function getOpenAITools(
  authorization: SkillToolAuthorization,
  sessionId?: string,
  scopeId?: string,
): Array<Record<string, unknown>> {
  return defaultToolGateway.getOpenAIToolsForGroups(
    defaultToolGateway.listCapabilityGroups().map((group) => group.id),
    sessionId,
    authorization,
    scopeId,
  )
}

export { executeBrowserTool, executeSkillTool, executeFeishuTool, executeMemoryTool, executePetTool, executeSessionRecallTool }
export { executeDocumentTool }
export { executeRSSTool }
export { executeCalendarTool }
export { executeSystemTool }
export { executeGeneralResearchTool } from './general-research-tools'
export { executeToolCall } from './tool-executor'
export type { ToolContext } from './tool-executor'
export type {
  ToolConcurrency,
  ToolDefinition,
  ToolDefinitionSchema,
  ToolDomain,
  ToolInterruptBehavior,
  ToolKind,
  ToolProjectionHint,
  ToolTimeoutProfile,
} from '../agent-control/tools-runtime/tool-definition'
export type {
  ToolExecutionOutput,
  ToolInteractionHint,
  ToolResultShape,
} from '../agent-control/tools-runtime/tool-result-types'
export type { ToolRegistryReader }
