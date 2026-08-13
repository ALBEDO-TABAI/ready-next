import { buildExplicitNoSkillAuthorization } from '../../main/modules/agent-control/skills/skill-tool-authorization'
import type { ToolDefinition } from '../../main/modules/agent-control/tools-runtime/tool-definition'
import {
  buildReadyToolSurface,
  buildReadyTurnToolAuthorization,
  type ReadyToolSurface,
} from '../../main/modules/agent-control/codex-runtime/codex-tool-surface'

function definition(name: string): ToolDefinition {
  return {
    name,
    groupId: 'agent_interaction',
    domain: 'document',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: null,
    description: `Fixture tool ${name}`,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

export function createCodexToolFixture(toolNames: string[] = ['ready_read']) {
  return createCodexToolFixtureFromDefinitions(toolNames.map(definition))
}

export function createCodexToolFixtureFromDefinitions(toolDefinitions: ToolDefinition[]) {
  const readyToolSurface = buildReadyToolSurface({
    surfaceId: 'surface-1',
    toolDefinitions,
  })
  return {
    readyToolSurface,
    readyTurnToolAuthorization: createCodexAuthorizationForSurface(readyToolSurface),
  }
}

export function createCodexAuthorizationForSurface(
  readyToolSurface: ReadyToolSurface,
  authorizationId = 'authorization-1',
) {
  return buildReadyTurnToolAuthorization({
    authorizationId,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    toolSurface: readyToolSurface,
  })
}
