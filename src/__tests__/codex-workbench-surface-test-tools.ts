import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import {
  buildReadyToolSurface,
  buildReadyTurnToolAuthorization,
  type ReadyToolTurnSnapshot,
} from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

export function workbenchTestTool(name: string): ToolDefinition {
  const domain: ToolDefinition['domain'] = name.startsWith('document_')
    ? 'document'
    : name.startsWith('file_') || name.startsWith('tag_forge_')
      ? 'file'
      : name.startsWith('rss_')
        ? 'rss'
        : name.startsWith('calendar_')
          ? 'calendar'
          : name === 'map_plan_route'
            ? 'map'
            : name.startsWith('browser_')
              ? 'browser'
          : name.startsWith('web_')
              ? 'general_research'
              : name === 'ask_user_questions'
                ? 'agent_interaction'
                : name.startsWith('skill_')
                  ? 'skill'
                  : name.startsWith('feishu_')
                    ? 'feishu'
                    : 'system'
  const groupId: ToolDefinition['groupId'] = domain === 'file'
    ? 'file_management'
    : domain === 'general_research'
      ? 'general_research'
      : domain === 'agent_interaction'
        ? 'agent_interaction'
        : domain === 'browser'
          ? 'browser_interaction'
        : domain === 'map'
          ? 'map_planning'
          : domain === 'system'
            ? 'system_host'
            : domain
  return {
    name,
    description: name,
    groupId,
    domain,
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: null,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

export function workbenchTestSnapshot(surfaceNames: string[], allowedNames = surfaceNames): ReadyToolTurnSnapshot {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const readyToolSurface = buildReadyToolSurface({
    surfaceId: `surface-${surfaceNames.join('-').slice(0, 48)}`,
    toolDefinitions: surfaceNames.map(workbenchTestTool),
  })
  return {
    readyToolSurface,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: 'auth-workbench-test',
      authorization,
      toolSurface: readyToolSurface,
      allowedToolNames: allowedNames,
    }),
  }
}
