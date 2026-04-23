import type { AIModelConfig } from '../../../shared/ai-providers'
import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type { CapabilityProfileId } from '../../../shared/ai-capability-groups'
import type { CapabilityRuntimeSnapshot } from '../../../shared/ai-capability-runtime'
import type { ToolPolicy } from './execution-tool-config'
import { getPolicyOpenAIToolBundle } from './execution-tool-config'
import type { ToolVisibilityPlan } from './run-contracts'
import type { CapabilityResolution, CapabilityRuntimeAvailability } from './capability-resolver'
import { buildCapabilityRuntimeSnapshot } from './capability-runtime-snapshot'
import { buildExecutionToolState, type ExecutionIntentContext } from './execution-intent-resolver'
import { logAgentMetric } from './metrics'
import {
  MAX_ARBITRATION_RECURSION,
  resolvePolicyConflicts,
  type PolicyArbitration,
  type PolicyConflictType,
} from './policy-arbitration'

export type { PolicyArbitration, PolicyConflictType }

export interface HostShortcutDecision {
  kind: 'none' | 'openclaw'
  reason: string
  command?: string
  authorizationSource: 'explicit_user_command' | 'ui_action' | 'none'
}

interface RunCapabilityBaseParams {
  config: AIModelConfig
  capabilityProfile: CapabilityProfileId
  supportsToolCalls: boolean
  hasVideoInputs: boolean
  hasIncomingVideo: boolean
  keepToolsWithVideo: boolean
  preferredSkillToolNames?: string[] | null
  executionIntentContext: ExecutionIntentContext
  browserDecisionMode: BrowserTaskDecisionMode
  runtimeAvailability: CapabilityRuntimeAvailability
  hostContext: {
    userText: string
    enabledChannelTypes?: string[]
    connectedChannelTypes?: string[]
  }
}

export interface PreparedRunCapabilities {
  visibilityPlan: ToolVisibilityPlan
  capabilityResolution: CapabilityResolution
  toolPolicy: ToolPolicy
  allowedToolNames: string[]
  hostShortcutDecision: HostShortcutDecision
  runtimeSnapshot: CapabilityRuntimeSnapshot
  capabilityLogLine: string
  toolResolution: import('./run-contracts').ToolResolutionDiagnostics
  arbitration: PolicyArbitration
  _baseParams: RunCapabilityBaseParams
}

export interface ReconciledRunCapabilities {
  visibilityPlan: ToolVisibilityPlan
  capabilityResolution: CapabilityResolution
  toolPolicy: ToolPolicy
  allowedToolNames: string[]
  hostShortcutDecision: HostShortcutDecision
  runtimeSnapshot: CapabilityRuntimeSnapshot
  capabilityLogLine: string
  toolResolution: import('./run-contracts').ToolResolutionDiagnostics
  arbitration: PolicyArbitration
}

function extractOpenclawPairingCommand(userText: string): string | null {
  const text = String(userText || '').trim()
  if (!text) return null
  const direct = text.match(/^\s*(openclaw\s+pairing\s+[^\n\r]+)\s*$/i)
  if (direct) return direct[1].trim()
  return null
}

function resolveHostShortcutDecision(params: {
  visibilityPlan: ToolVisibilityPlan
  hostContext: RunCapabilityBaseParams['hostContext']
}): HostShortcutDecision {
  const openclawCommand = extractOpenclawPairingCommand(params.hostContext.userText)
  if (params.visibilityPlan.hasTools && openclawCommand) {
    return {
      kind: 'openclaw',
      reason: 'pairing_command',
      command: openclawCommand,
      authorizationSource: 'explicit_user_command',
    }
  }

  return {
    kind: 'none',
    reason: 'tool_loop_or_simple_response',
    authorizationSource: 'none',
  }
}

function buildCapabilityLogLine(params: {
  visibilityPlan: ToolVisibilityPlan
  toolPolicy: ToolPolicy
  runtimeSnapshot: CapabilityRuntimeSnapshot
  hasVideoInputs: boolean
  hasIncomingVideo: boolean
}): string {
  return [
    `hasTools=${params.visibilityPlan.hasTools}`,
    `forceDocumentTool=${params.toolPolicy.forceDocumentTool}`,
    `forceDesignTool=${params.toolPolicy.forceDesignTool}`,
    `preferredDesignTool=${params.toolPolicy.preferredDesignTool || 'none'}`,
    `allowMultipleDesignArtifacts=${params.toolPolicy.allowMultipleDesignArtifacts}`,
    `preferSectionRewrite=${params.toolPolicy.preferSectionRewrite}`,
    `preferFormatOnly=${params.toolPolicy.preferFormatOnly}`,
    `documentWidgetTaskKind=${params.toolPolicy.documentWidgetTaskKind || 'none'}`,
    `allowBrowserTools=${params.toolPolicy.allowBrowserTools}`,
    `preferredSkillTools=${params.toolPolicy.preferredSkillToolNames?.join('|') || 'all'}`,
    `visibleCapabilityGroups=${params.visibilityPlan.visibleCapabilityGroupIds?.join('|') || 'none'}`,
    `suppressedCapabilityGroups=${params.visibilityPlan.suppressedCapabilityGroupIds?.join('|') || 'none'}`,
    `hasVideoInputs=${params.hasVideoInputs}`,
    `incomingVideo=${params.hasIncomingVideo}`,
    `keepToolsWithVideo=${params.visibilityPlan.keepToolsWithVideo}`,
    `feishuConnected=${params.runtimeSnapshot.environment.feishuConnected}`,
    `browserHostAvailable=${params.runtimeSnapshot.environment.browserHostAvailable}`,
  ].join(', ')
}

function resolveRunCapabilities(
  baseParams: RunCapabilityBaseParams,
  recursionDepth = 0,
): Omit<PreparedRunCapabilities, '_baseParams'> {
  const { visibilityPlan, toolPolicy, capabilityResolution } = buildExecutionToolState({
    config: baseParams.config,
    capabilityProfile: baseParams.capabilityProfile,
    supportsToolCalls: baseParams.supportsToolCalls,
    hasVideoInputs: baseParams.hasVideoInputs,
    hasIncomingVideo: baseParams.hasIncomingVideo,
    keepToolsWithVideo: baseParams.keepToolsWithVideo,
    preferredSkillToolNames: baseParams.preferredSkillToolNames,
    contextualUserInput: baseParams.executionIntentContext.contextualUserInput,
    userInstructionText: baseParams.executionIntentContext.userInstructionText,
    intentClassification: baseParams.executionIntentContext.intentClassification,
    hasDocumentEnvironment: baseParams.executionIntentContext.hasDocumentEnvironment,
    hasWidgetTargetContext: baseParams.executionIntentContext.hasWidgetTargetContext,
    explicitWidgetCreateIntent: baseParams.executionIntentContext.explicitWidgetCreateIntent,
    documentWidgetTaskKind: baseParams.executionIntentContext.documentWidgetTaskKind,
    documentWidgetProfile: baseParams.executionIntentContext.documentWidgetProfile,
    browserDecisionMode: baseParams.browserDecisionMode,
    browserHostAvailable: baseParams.runtimeAvailability.browserHostAvailable,
    feishuConnected: baseParams.runtimeAvailability.feishuConnected,
  })

  const { conflicts, demotedBrowserDecisionMode, skillPassthroughApplied } = resolvePolicyConflicts({
    toolPolicy,
    browserDecisionMode: baseParams.browserDecisionMode,
    executionIntentContext: baseParams.executionIntentContext,
  })

  if (skillPassthroughApplied) {
    try {
      logAgentMetric('policy_conflict_resolved', {
        conflictType: 'force_document_x_skill_preferred',
        resolution: 'skill_tool_passthrough',
        forceDocumentTool: toolPolicy.forceDocumentTool,
        preferredSkillToolCount: toolPolicy.preferredSkillToolNames?.length || 0,
      })
    } catch {
      // metrics must never break the resolver
    }
  }

  if (
    conflicts.length > 0 &&
    demotedBrowserDecisionMode &&
    demotedBrowserDecisionMode !== baseParams.browserDecisionMode &&
    recursionDepth < MAX_ARBITRATION_RECURSION
  ) {
    const resolutionApplied = [`demote_browser_decision:${baseParams.browserDecisionMode}->${demotedBrowserDecisionMode}`]
    if (skillPassthroughApplied) {
      resolutionApplied.push('skill_tool_passthrough')
    }
    for (const conflict of conflicts) {
      if (conflict === 'force_document_x_skill_preferred') continue
      try {
        logAgentMetric('policy_conflict_resolved', {
          conflictType: conflict,
          from: baseParams.browserDecisionMode,
          to: demotedBrowserDecisionMode,
          documentWidgetTaskKind: baseParams.executionIntentContext.documentWidgetTaskKind || null,
          forceDocumentTool: toolPolicy.forceDocumentTool,
        })
      } catch {
        // metrics must never break the resolver
      }
    }
    const nested = resolveRunCapabilities(
      { ...baseParams, browserDecisionMode: demotedBrowserDecisionMode },
      recursionDepth + 1,
    )
    return {
      ...nested,
      arbitration: {
        conflictsDetected: conflicts,
        resolutionApplied: [...resolutionApplied, ...nested.arbitration.resolutionApplied],
        recursionDepth: nested.arbitration.recursionDepth + 1,
      },
    }
  }

  const runtimeSnapshot = buildCapabilityRuntimeSnapshot({
    config: baseParams.config,
    profile: baseParams.capabilityProfile,
    browserDecisionMode: baseParams.browserDecisionMode,
    runtimeAvailability: baseParams.runtimeAvailability,
    intentGroupModes: {
      document: toolPolicy.allowDocumentTools,
    },
    enabledChannelTypes: baseParams.hostContext.enabledChannelTypes,
    connectedChannelTypes: baseParams.hostContext.connectedChannelTypes,
  })

  const toolBundle = getPolicyOpenAIToolBundle(toolPolicy)

  return {
    visibilityPlan,
    capabilityResolution,
    toolPolicy,
    allowedToolNames: toolBundle.toolNames,
    hostShortcutDecision: resolveHostShortcutDecision({
      visibilityPlan,
      hostContext: baseParams.hostContext,
    }),
    runtimeSnapshot,
    capabilityLogLine: buildCapabilityLogLine({
      visibilityPlan,
      toolPolicy,
      runtimeSnapshot,
      hasVideoInputs: baseParams.hasVideoInputs,
      hasIncomingVideo: baseParams.hasIncomingVideo,
    }),
    toolResolution: toolBundle.toolResolution,
    arbitration: {
      conflictsDetected: conflicts,
      resolutionApplied: skillPassthroughApplied ? ['skill_tool_passthrough'] : [],
      recursionDepth: 0,
    },
  }
}

export function prepareInitialRun(params: RunCapabilityBaseParams): PreparedRunCapabilities {
  return {
    ...resolveRunCapabilities(params),
    _baseParams: params,
  }
}

export function reconcileAfterBrowserDecision(params: {
  prepared: PreparedRunCapabilities
  browserDecisionMode: BrowserTaskDecisionMode
}): ReconciledRunCapabilities {
  return resolveRunCapabilities({
    ...params.prepared._baseParams,
    browserDecisionMode: params.browserDecisionMode,
  })
}
