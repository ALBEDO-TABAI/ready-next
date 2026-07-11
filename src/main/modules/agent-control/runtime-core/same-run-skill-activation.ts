import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { isToolEnabledForCurrentAuthorization } from './agent-sdk-tool-executor'
import type { ToolBridgeRuntimeContext } from './agent-sdk-types'

export function installSameRunSkillActivation(input: {
  runtimeContext: ToolBridgeRuntimeContext
  latentDefinitions: readonly ToolDefinition[]
  resolveAuthorization: () => SkillToolAuthorization
  allowedToolNames: string[]
  definitionByName: Map<string, ToolDefinition>
  requiredCapabilityGroups: string[]
  checkpointRequiredCapabilityGroups: string[]
  checkpointRequiredToolNames: string[]
}): void {
  input.runtimeContext.activateSkillForCurrentRun = (skillId) => {
    if (input.runtimeContext.sameRunActivatedSkillId) {
      return input.runtimeContext.sameRunActivatedSkillId === skillId
        ? input.latentDefinitions.filter((definition) =>
            isToolEnabledForCurrentAuthorization(definition.name, input.runtimeContext.authorization),
          )
        : null
    }
    const authorization = input.resolveAuthorization()
    if (authorization.mode !== 'selected' || authorization.skillId !== skillId) return null
    input.runtimeContext.authorization = authorization
    input.runtimeContext.sameRunActivatedSkillId = skillId
    const enabled = input.latentDefinitions.filter((definition) =>
      isToolEnabledForCurrentAuthorization(definition.name, authorization),
    )
    for (const definition of enabled) {
      if (!input.allowedToolNames.includes(definition.name)) input.allowedToolNames.push(definition.name)
      input.definitionByName.set(definition.name, definition)
      if (!input.requiredCapabilityGroups.includes(definition.groupId)) {
        input.requiredCapabilityGroups.push(definition.groupId)
      }
      if (!input.checkpointRequiredToolNames.includes(definition.name)) {
        input.checkpointRequiredToolNames.push(definition.name)
      }
    }
    input.checkpointRequiredCapabilityGroups.splice(
      0,
      input.checkpointRequiredCapabilityGroups.length,
      ...input.requiredCapabilityGroups,
    )
    appendToolCapabilityLog([
      '[tool_capability]',
      'stage=same_run_skill_activated',
      `skill=${skillId}`,
      `tools=${enabled.map((definition) => definition.name).join('|') || 'none'}`,
    ].join(' '))
    return enabled
  }
}
