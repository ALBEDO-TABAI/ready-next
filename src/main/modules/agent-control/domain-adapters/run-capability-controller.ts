import { rssReferencesFromEnvelope } from '../../../../shared/rss-reference'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import type { BrowserTaskDecisionMode } from '../../../../shared/browser-agent-task'
import type { CapabilityGroupId, CapabilityProfileId } from '../../../../shared/ai-capability-groups'
import type { CapabilityRuntimeSnapshot } from '../../../../shared/ai-capability-runtime'
import type { ToolPolicy } from '../tool-policy/execution-tool-config'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import { getPolicyOpenAIToolBundle } from '../tool-policy/execution-tool-config'
import type { ToolVisibilityPlan } from '../contracts/run-contracts'
import type { CapabilityResolution, CapabilityRuntimeAvailability } from './capability-resolver'
import { buildCapabilityRuntimeSnapshot } from './capability-runtime-snapshot'
import { buildExecutionToolState, type ExecutionIntentContext } from '../execution-intent-resolver'
import { computeCapabilityFloors } from './capability-floors'
import { defaultToolRegistry } from '../tools-runtime/tool-registry'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import { envelopeHasCurrentDocumentContext, envelopeHasLocalDocumentResource } from '../contracts/request-envelope'
import { logAgentMetric } from '../metrics'
import {
  MAX_ARBITRATION_RECURSION,
  resolvePolicyConflicts,
  type PolicyArbitration,
  type PolicyConflictType,
} from '../policy-arbitration'

export type { PolicyArbitration, PolicyConflictType }

export type RunCapabilityMode = 'default' | 'narration'

const NARRATION_VISIBLE_CAPABILITY_GROUP_IDS: CapabilityGroupId[] = [
  'file_management',
  'memory',
  'session_recall',
  'general_research',
]

const NARRATION_ALLOWED_TOOL_NAMES = Object.freeze([
  'file_search',
  'file_locate',
  'file_read_excerpt',
  'file_get_backlinks',
  'file_get_graph',
  'file_inventory',
  'memory_search',
  'memory_list_recent',
  'session_search',
  'web_search',
  'web_fetch',
])

export interface HostShortcutDecision {
  kind: 'none' | 'openclaw'
  reason: string
  command?: string
  authorizationSource: 'explicit_user_command' | 'ui_action' | 'none'
}

interface RunCapabilityBaseParams {
  config: AIModelConfig
  runCapabilityMode?: RunCapabilityMode
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
  sessionId?: string
  /**
   * Stage T PR-T5 — conversation scope id, sourced from
   * `RequestEnvelope.scopeId`. Plumbed onto `toolPolicy.scopeId` so the
   * gateway / registry pass it into
   * `mcp.registry.isAuthorized(toolName, sessionId, scopeId)` for the
   * model-visible MCP tool list.
   */
  scopeId?: string
  /**
   * Stage 4 W3b.2 fix — per-turn skill tool authorization. Threaded
   * through `resolveRunCapabilities` so it's already on `toolPolicy`
   * BEFORE `getPolicyOpenAIToolBundle` computes `allowedToolNames` and
   * `toolResolution`. Without this, the prepared snapshot would carry
   * pre-cutover `allowedToolNames` while the post-cutover mutation in
   * turn-engine only fixed the policy used for subsequent LLM calls —
   * leaving the diagnostic snapshot and text-tool-bridge allowed-name
   * list out of sync. `_baseParams` retains it so
   * `reconcileAfterBrowserDecision` continues with the same value.
   * Stage 10 — required: every model-visible call site computes a
   * determinate authorization before invoking the controller.
   */
  authorization: SkillToolAuthorization
}

export interface PreparedRunCapabilities {
  visibilityPlan: ToolVisibilityPlan
  capabilityResolution: CapabilityResolution
  toolPolicy: ToolPolicy
  allowedToolNames: string[]
  hostShortcutDecision: HostShortcutDecision
  runtimeSnapshot: CapabilityRuntimeSnapshot
  capabilityLogLine: string
  toolResolution: import('../contracts/run-contracts').ToolResolutionDiagnostics
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
  toolResolution: import('../contracts/run-contracts').ToolResolutionDiagnostics
  arbitration: PolicyArbitration
}

function extractOpenclawPairingCommand(userText: string): string | null {
  const text = String(userText || '').trim()
  if (!text) return null
  const direct = text.match(/^\s*(openclaw\s+pairing\s+[^\n\r]+)\s*$/i)
  if (direct) return direct[1].trim()
  return null
}

/**
 * Stage S round 2 (Issue 5) — resolve the active skill's manifest
 * `allowed_tools` from `SkillsRuntimeManager`. Defensive try/catch:
 * skill-runtime is the source of truth at runtime but is occasionally
 * unavailable in early-boot test paths or when the host runtime has
 * not finished init; in those cases we return `null` (identity filter).
 *
 * Production callers feed this onto `toolPolicy.activeSkillAllowedTools`
 * so `getPolicyOpenAIToolBundle` / `getPolicyAnthropicTools` can apply
 * `filterToolsByAllowedTools` without re-resolving the runtime per call.
 */
export function resolveActiveSkillAllowedTools(
  authorization: SkillToolAuthorization,
): ReadonlyArray<string> | null {
  if (authorization.mode !== 'selected') return null
  const skillId = authorization.skillId
  if (!skillId) return null
  try {
    const skill = getSkillsRuntimeManager()
      .listSkills()
      .find((s) => s.id === skillId)
    if (!skill) return null
    const allowed = skill.allowedTools
    if (!Array.isArray(allowed) || allowed.length === 0) return null
    return Object.freeze([...allowed])
  } catch {
    // silent-catch: skill runtime absence keeps capability filtering conservative.
    // Skill runtime unavailable (e.g. boot race / test harness without
    // skills tree). Conservative behavior: identity filter.
    return null
  }
}

export function resolveCapabilityGroupIdsForAllowedTools(
  allowedTools: ReadonlyArray<string> | null,
  resolveGroupId: (toolName: string) => CapabilityGroupId | null,
): CapabilityGroupId[] {
  if (!allowedTools || allowedTools.length === 0) return []
  const groupIds = new Set<CapabilityGroupId>()
  for (const toolName of allowedTools) {
    const groupId = resolveGroupId(toolName)
    if (groupId) groupIds.add(groupId)
  }
  return [...groupIds]
}

const READ_ONLY_RESEARCH_SKILL_TOOL_NAMES = new Set([
  'web_search_domains',
  'web_search',
  'web_fetch',
])

export function isReadOnlyResearchSkillToolSet(
  toolNames: ReadonlyArray<string> | null | undefined,
): boolean {
  return Boolean(
    toolNames &&
    toolNames.length > 0 &&
    toolNames.every((toolName) => READ_ONLY_RESEARCH_SKILL_TOOL_NAMES.has(toolName)),
  )
}

function resolveToolGroupIdFromRegistry(toolName: string): CapabilityGroupId | null {
  return defaultToolRegistry.getToolDefinitionForExecution(toolName)?.groupId || null
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
    `preferredSkillTools=${params.toolPolicy.preferredSkillToolNames?.join('|') || 'none'}`,
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
  const activeSkillAllowedTools = resolveActiveSkillAllowedTools(baseParams.authorization)
  const requiredCapabilityGroupIds = resolveCapabilityGroupIdsForAllowedTools(
    activeSkillAllowedTools,
    resolveToolGroupIdFromRegistry,
  )
  let { visibilityPlan, toolPolicy, capabilityResolution } = buildExecutionToolState({
    config: baseParams.config,
    capabilityProfile: baseParams.capabilityProfile,
    supportsToolCalls: baseParams.supportsToolCalls,
    hasVideoInputs: baseParams.hasVideoInputs,
    hasIncomingVideo: baseParams.hasIncomingVideo,
    keepToolsWithVideo: baseParams.keepToolsWithVideo,
    preferredSkillToolNames: baseParams.preferredSkillToolNames,
    requiredCapabilityGroupIds,
    contextualUserInput: baseParams.executionIntentContext.contextualUserInput,
    userInstructionText: baseParams.executionIntentContext.userInstructionText,
    intentClassification: baseParams.executionIntentContext.intentClassification,
    hasDocumentEnvironment: baseParams.executionIntentContext.hasDocumentEnvironment,
    hasWidgetTargetContext: baseParams.executionIntentContext.hasWidgetTargetContext,
    explicitWidgetCreateIntent: baseParams.executionIntentContext.explicitWidgetCreateIntent,
    documentWidgetTaskKind: baseParams.executionIntentContext.documentWidgetTaskKind,
    documentWidgetProfile: baseParams.executionIntentContext.documentWidgetProfile,
    mapSemanticIntent: baseParams.executionIntentContext.mapSemanticIntent ?? null,
    browserDecisionMode: baseParams.browserDecisionMode,
    browserHostAvailable: baseParams.runtimeAvailability.browserHostAvailable,
    feishuConnected: baseParams.runtimeAvailability.feishuConnected,
    sessionId: baseParams.sessionId,
  })

  if (baseParams.runCapabilityMode === 'narration') {
    visibilityPlan = {
      ...visibilityPlan,
      allowBrowserTools: false,
      preferredSkillToolNames: null,
      visibleCapabilityGroupIds: NARRATION_VISIBLE_CAPABILITY_GROUP_IDS,
      suppressedCapabilityGroupIds: Array.from(new Set([
        ...(visibilityPlan.suppressedCapabilityGroupIds || []),
        'browser_interaction',
        'browser_content_tasks',
        'document',
        'rss',
        'calendar',
        'skills',
        'pet',
        'channel_feishu',
        'map_planning',
        'mcp',
        'agent_interaction',
        'skill_install',
      ] as CapabilityGroupId[])),
    }
    capabilityResolution = {
      ...capabilityResolution,
      visibleCapabilityGroupIds: NARRATION_VISIBLE_CAPABILITY_GROUP_IDS,
      suppressedCapabilityGroupIds: visibilityPlan.suppressedCapabilityGroupIds || [],
    }
    toolPolicy = {
      ...toolPolicy,
      forceDocumentTool: false,
      allowDocumentTools: false,
      forceDesignTool: false,
      preferredDesignTool: null,
      primaryDesignInstruction: null,
      allowMultipleDesignArtifacts: false,
      preferSectionRewrite: false,
      preferFormatOnly: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
      documentWidgetSourceText: null,
      allowBrowserTools: false,
      preferredSkillToolNames: null,
      visibleCapabilityGroupIds: NARRATION_VISIBLE_CAPABILITY_GROUP_IDS,
      activeSkillAllowedTools: NARRATION_ALLOWED_TOOL_NAMES,
    }
  }

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
      skills: Boolean(toolPolicy.preferredSkillToolNames?.length),
    },
    enabledChannelTypes: baseParams.hostContext.enabledChannelTypes,
    connectedChannelTypes: baseParams.hostContext.connectedChannelTypes,
  })

  // Stage 4 W3b.2 fix — set authorization on toolPolicy BEFORE bundling
  // so allowedToolNames + toolResolution are computed with the same
  // skill-list filter the model will see. Without this, the diagnostic
  // snapshot and the text-tool-bridge allowed-name list drift from the
  // post-cutover policy applied later in turn-engine.
  toolPolicy.authorization = baseParams.authorization

  // Stage T PR-T5 — thread scopeId from RequestEnvelope onto the policy
  // so the bundle path (gateway → registry → mcp.registry.isAuthorized)
  // sees a consistent (sessionId, scopeId) tuple per turn.
  toolPolicy.scopeId = baseParams.scopeId

  // Stage S round 2 (Issue 3) — vision capability filter.
  //
  // The three resolved capability flags travel on `capabilityResolution`
  // (see capability-resolver.ts). Stage S round 1 only recorded the
  // decision for observability; round 2 makes it actually filter the
  // tool bundle by attaching `capabilityResolution` to `toolPolicy`.
  // Both `getPolicyAnthropicTools` and `getPolicyOpenAIToolBundle` then
  // route the tool list through `filterToolsByVisionCapability`, dropping
  // any vision-bearing tool when `supportsVision !== true`. Conservative
  // default: when the flag is missing/undefined, the helper treats it
  // as `false` (deny vision tools).
  toolPolicy.capabilityResolution = { supportsVision: capabilityResolution.supportsVision === true }

  // Stage S round 2 (Issue 5) — manifest `allowed_tools` filter.
  //
  // When the per-turn authorization picked a skill (`mode:'selected'`),
  // resolve its compiled `allowedTools` array off `SkillsRuntimeManager`
  // and attach to the policy. The bundle path then strips the model-
  // visible list down to the manifest's declared toolset. We resolve
  // here (not in the bundle) so the lookup is single-shot per turn and
  // skill-runtime crashes (e.g. host startup race) cannot fault the
  // tool bundle path. `null` / empty → identity (no filtering).
  toolPolicy.activeSkillAllowedTools = activeSkillAllowedTools

  // P1-4 — 唯一裁决点计算能力地板并挂到 toolPolicy；SDK executor 消费同一 computeCapabilityFloors。
  //   bundle 侧把地板并入 activeSkillAllowedTools 过滤集，保证技能收窄不移除地板项（parity）。
  toolPolicy.capabilityFloors = computeCapabilityFloors({
    authorization: baseParams.authorization,
    hasRSSResource: rssReferencesFromEnvelope(baseParams.executionIntentContext.requestEnvelope).length > 0,
    hasLocalDocumentResource: envelopeHasLocalDocumentResource(baseParams.executionIntentContext.requestEnvelope),
    hasCurrentDocumentContext: envelopeHasCurrentDocumentContext(baseParams.executionIntentContext.requestEnvelope),
  })

  const visionCapable = capabilityResolution.supportsVision === true
  if (!visionCapable) {
    try {
      logAgentMetric('capability_gate_arbitration_denied', {
        capability: 'vision',
        supportsVision: capabilityResolution.supportsVision === true,
      })
    } catch {
      // metrics must never break the resolver
    }
  }

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
