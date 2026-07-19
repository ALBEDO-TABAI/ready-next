import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import type { ResolvedSkillSurfaceComposition } from '../skills/skill-surface-composition'
import type { PreparedSkillTurnTruth } from '../contracts/browser-workflow-control'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { SkillTurnIdentity } from '../skills/skill-turn-identity'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { isToolEnabledForCurrentAuthorization } from './agent-sdk-tool-executor'
import type { ToolBridgeRuntimeContext } from './agent-sdk-types'

function definitionsForNames(
  names: Iterable<string>,
  definitionByName: Map<string, ToolDefinition>,
): ToolDefinition[] {
  const definitions: ToolDefinition[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const definition = definitionByName.get(name)
    if (definition) definitions.push(definition)
  }
  return definitions
}

export function activateBrowserCapabilityForCurrentRun(input: {
  runtimeContext: Pick<ToolBridgeRuntimeContext, 'activatedCapabilityGroups' | 'skillSurfaceComposition'>
  latentDefinitions: readonly ToolDefinition[]
  allowedToolNames: string[]
  definitionByName: Map<string, ToolDefinition>
  requiredCapabilityGroups: string[]
  checkpointRequiredCapabilityGroups: string[]
  checkpointRequiredToolNames: string[]
}): ToolDefinition[] {
  if (!input.runtimeContext.activatedCapabilityGroups.includes('browser')) {
    input.runtimeContext.activatedCapabilityGroups.push('browser')
  }
  if (input.runtimeContext.skillSurfaceComposition === 'exclusive') return []

  const enabled = [...input.latentDefinitions]
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
  return enabled
}

export function installSameRunSkillActivation(input: {
  runtimeContext: ToolBridgeRuntimeContext
  latentDefinitions: readonly ToolDefinition[]
  resolvePreparedSkill: () => { authorization: SkillToolAuthorization; identity: SkillTurnIdentity }
  resolveComposition: (authorization: SkillToolAuthorization) => ResolvedSkillSurfaceComposition
  buildPreparedTruth: (input: {
    authorization: SkillToolAuthorization
    identity: SkillTurnIdentity
    surface: ResolvedSkillSurfaceComposition
  }) => PreparedSkillTurnTruth
  resolveExclusiveFloorToolNames: (authorization: SkillToolAuthorization) => Iterable<string>
  allowedToolNames: string[]
  definitionByName: Map<string, ToolDefinition>
  requiredCapabilityGroups: string[]
  checkpointRequiredCapabilityGroups: string[]
  checkpointRequiredToolNames: string[]
}): void {
  input.runtimeContext.activateSkillForCurrentRun = (skillId) => {
    if (input.runtimeContext.sameRunActivatedSkillId) {
      if (input.runtimeContext.sameRunActivatedSkillId !== skillId) return null
      return definitionsForNames(input.allowedToolNames, input.definitionByName)
    }

    const prepared = input.resolvePreparedSkill()
    const { authorization } = prepared
    if (authorization.mode !== 'selected' || authorization.skillId !== skillId) return null
    const surface = input.resolveComposition(authorization)
    input.runtimeContext.authorization = authorization
    input.runtimeContext.sameRunActivatedSkillId = skillId
    input.runtimeContext.skillSurfaceComposition = surface.composition
    input.runtimeContext.exclusiveScopeRef = surface.exclusiveScopeRef
    input.runtimeContext.preparedSkillTurn = input.buildPreparedTruth({
      authorization,
      identity: prepared.identity,
      surface,
    })

    const authorizedNames = new Set([
      ...authorization.allowedTypedActions,
      ...authorization.allowedPrimitives,
    ])
    const authorized = [...input.definitionByName.values()].filter((definition) =>
      authorizedNames.has(definition.name)
      && isToolEnabledForCurrentAuthorization(definition.name, authorization),
    )
    let enabled: ToolDefinition[]
    if (surface.composition === 'exclusive') {
      const exclusiveNames = new Set<string>([
        ...authorized.map((definition) => definition.name),
        ...input.resolveExclusiveFloorToolNames(authorization),
      ])
      if (input.definitionByName.has('declare_completion_criteria')) {
        exclusiveNames.add('declare_completion_criteria')
      }
      enabled = definitionsForNames(exclusiveNames, input.definitionByName)
      input.allowedToolNames.splice(0, input.allowedToolNames.length, ...enabled.map((definition) => definition.name))
    } else {
      enabled = authorized
      for (const definition of enabled) {
        if (!input.allowedToolNames.includes(definition.name)) input.allowedToolNames.push(definition.name)
      }
    }

    for (const definition of enabled) input.definitionByName.set(definition.name, definition)
    const enabledGroups = [...new Set(
      input.allowedToolNames
        .map((name) => input.definitionByName.get(name)?.groupId)
        .filter((groupId) => groupId !== undefined),
    )]
    input.requiredCapabilityGroups.splice(0, input.requiredCapabilityGroups.length, ...enabledGroups)
    input.checkpointRequiredToolNames.splice(
      0,
      input.checkpointRequiredToolNames.length,
      ...input.allowedToolNames,
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
      `composition=${surface.composition}`,
      `tools=${enabled.map((definition) => definition.name).join('|') || 'none'}`,
    ].join(' '))
    return enabled
  }
}
