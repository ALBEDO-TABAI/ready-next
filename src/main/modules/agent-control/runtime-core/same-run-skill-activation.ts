import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import { TAG_FORGE_FOLDER_RUNTIME_TOOL_NAMES } from '../domain-adapters/capability-floors'
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
  hasFolderResource: boolean
}): void {
  input.runtimeContext.activateSkillForCurrentRun = (skillId) => {
    if (input.runtimeContext.sameRunActivatedSkillId) {
      if (
        input.runtimeContext.sameRunActivatedSkillId === skillId
        && skillId === 'tag-forge'
        && input.hasFolderResource
      ) {
        return input.allowedToolNames
          .map((name) => input.definitionByName.get(name))
          .filter((definition): definition is ToolDefinition => Boolean(definition))
      }
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
    if (skillId === 'tag-forge' && input.hasFolderResource) {
      const enabled = TAG_FORGE_FOLDER_RUNTIME_TOOL_NAMES
        .map((name) => input.definitionByName.get(name))
        .filter((definition): definition is ToolDefinition => Boolean(definition))
      const enabledNames = enabled.map((definition) => definition.name)
      const enabledGroups = [...new Set(enabled.map((definition) => definition.groupId))]
      input.allowedToolNames.splice(0, input.allowedToolNames.length, ...enabledNames)
      input.requiredCapabilityGroups.splice(0, input.requiredCapabilityGroups.length, ...enabledGroups)
      input.checkpointRequiredToolNames.splice(
        0,
        input.checkpointRequiredToolNames.length,
        ...enabledNames,
      )
      input.checkpointRequiredCapabilityGroups.splice(
        0,
        input.checkpointRequiredCapabilityGroups.length,
        ...enabledGroups,
      )
      appendToolCapabilityLog([
        '[tool_capability]',
        'stage=same_run_skill_activated',
        `skill=${skillId}`,
        `tools=${enabledNames.join('|') || 'none'}`,
      ].join(' '))
      return enabled
    }
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
