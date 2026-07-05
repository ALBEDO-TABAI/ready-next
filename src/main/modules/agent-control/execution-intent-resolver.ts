import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type { AIModelConfig } from '../../../shared/ai-providers'
import { getDefaultConfig } from '../../../shared/ai-providers'
import type { CapabilityGroupId, CapabilityProfileId } from '../../../shared/ai-capability-groups'
import type { ToolVisibilityPlan } from './contracts/run-contracts'
import { buildToolVisibilityPlan } from './tool-policy/execution-tool-policy'
import type { ToolPolicy } from './tool-policy/execution-tool-config'
import { resolveCapabilityResolution, type CapabilityResolution } from './domain-adapters/capability-resolver'
import type { IntentClassification } from './intent-classifier'
import { classifyIntent } from './intent-classifier'
import type { RequestEnvelope } from './contracts/request-envelope'
import { buildRequestEnvelope } from './contracts/request-envelope'
import {
  extractPrimaryUserInstruction,
  hasExplicitDocumentWidgetCreateIntent,
  inferDocumentWidgetTaskKind,
  shouldForceDocumentToolCall,
  shouldPreferFormatOnly,
  shouldPreferSectionRewrite,
  type DocumentWidgetTaskKind,
} from '../claude-bridge/tool-policy-heuristics'
import { isRetryOnlyPrompt, resolveToolPolicyInput } from '../claude-bridge/tool-policy-context'
import { inferDocumentWidgetProfile, type DocumentWidgetProfile } from '../claude-bridge/widget-guidance'
import { classifyStructuredDocumentIntent, type StructuredDocumentIntent } from '../document-engine/pipeline/document-task-types'
import { buildDocumentTaskPlan, type DocumentTaskPlan } from '../document-engine/pipeline/document-task-plan'
import { logAgentMetric } from './metrics'
import type { ActiveWidgetEditLease } from './widget-edit-lease'
import {
  isMapSemanticIntentActive,
  type MapSemanticIntent,
} from './map-semantic-intent'

export interface ExecutionIntentContext {
  requestEnvelope: RequestEnvelope
  intentClassification: IntentClassification
  contextualUserInput: string
  userInstructionText: string
  hasDocumentEnvironment: boolean
  hasWidgetTargetContext: boolean
  explicitWidgetCreateIntent: boolean
  documentWidgetTaskKind: DocumentWidgetTaskKind
  documentWidgetProfile: DocumentWidgetProfile | null
  structuredDocumentIntent: StructuredDocumentIntent
  documentTaskPlan: DocumentTaskPlan | null
  shouldUseDocumentTaskPlan: boolean
  mapSemanticIntent?: MapSemanticIntent | null
}

const DOCUMENT_TOOL_SURFACE_PATTERN =
  /(文档|文稿|原文|文章|段落|章节|docx?|markdown|\.md\b|widget|show-widget|图表|趋势图|卡片|信息卡|提示块|表格|对比卡|进度卡|日程卡|待办|习惯|计划板|计算器|保存|写入|追加|替换|编辑|改写|润色|排版|格式)/i

const DOCUMENT_CONTEXT_CONTINUATION_PATTERN =
  /(这篇|这份|这个|上面|前面|刚才|继续|再|确认|整理|分段|合并|子标题|小标题|标题|补上|附上|加上|改一下|改成|保存|写入|替换)/i

function hasWritableDocumentContext(envelope: RequestEnvelope): boolean {
  // Widget targets are hardcoded canWrite:true in the envelope, but a widget
  // update context is NOT a document environment — that state has its own
  // flag (hasWidgetTargetContext). The canWrite clause (e75e4050) is meant
  // for writable document resources (document_context / writable attachments).
  return envelope.environmentHints.hasDocumentContext
    || envelope.resources.some((resource) => (
      resource.kind === 'document_context'
      || resource.source === 'current_document'
      || (resource.kind !== 'widget_target' && resource.canWrite)
    ))
}

function normalizeRegisteredSkillToken(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '')
    .trim()
}

function findRegisteredSkillHistoryInput(previousInputs: string[], registeredSkillTokens?: string[] | null): string | null {
  const tokens = (registeredSkillTokens || [])
    .map((token) => normalizeRegisteredSkillToken(token))
    .filter((token) => token.length >= 6)
  if (tokens.length === 0) return null
  for (const previousInput of previousInputs) {
    const normalized = normalizeRegisteredSkillToken(previousInput)
    if (!normalized) continue
    if (tokens.some((token) => normalized.includes(token))) {
      return previousInput
    }
  }
  return null
}

export function resolveExecutionIntentContext(params: {
  requestEnvelope: RequestEnvelope
  previousInputs: string[]
  lastDocumentContextInput?: string | null
  intentClassification?: IntentClassification | null
  activeWidgetEditLease?: ActiveWidgetEditLease | null
  refreshWidgetEditLease?: () => ActiveWidgetEditLease | null
  registeredSkillTokens?: string[] | null
  mapSemanticIntent?: MapSemanticIntent | null
}): ExecutionIntentContext {
  const envelopeHasWidgetTarget = params.requestEnvelope.environmentHints.hasWidgetTargetContext
  const primaryInput = params.requestEnvelope.primaryInstruction || params.requestEnvelope.pureUserText
  const registeredSkillHistoryInput = findRegisteredSkillHistoryInput(
    params.previousInputs,
    params.registeredSkillTokens,
  )
  const contextualUserInput = isRetryOnlyPrompt(primaryInput) && registeredSkillHistoryInput
    ? registeredSkillHistoryInput
    : resolveToolPolicyInput(
      primaryInput,
      params.lastDocumentContextInput
        ? [params.lastDocumentContextInput, ...params.previousInputs]
        : params.previousInputs,
    )
  const userInstructionText = extractPrimaryUserInstruction(contextualUserInput)
  const explicitWidgetCreateIntent = hasExplicitDocumentWidgetCreateIntent(contextualUserInput)
  const leaseValid = params.activeWidgetEditLease
    && params.activeWidgetEditLease.expireAt > Date.now()
  const leaseStickyEligible = Boolean(leaseValid) && !explicitWidgetCreateIntent
  const hasWidgetTargetContext = envelopeHasWidgetTarget || leaseStickyEligible
  let leaseRefreshed = false
  if (leaseStickyEligible && typeof params.refreshWidgetEditLease === 'function') {
    try {
      const refreshed = params.refreshWidgetEditLease()
      leaseRefreshed = Boolean(refreshed)
    } catch {
      leaseRefreshed = false
    }
  }
  const inferredWidgetTaskKind = inferDocumentWidgetTaskKind(contextualUserInput)
  const documentWidgetTaskKind =
    hasWidgetTargetContext && !explicitWidgetCreateIntent
      ? 'update'
      : inferredWidgetTaskKind
  const effectiveEnvelope = contextualUserInput === (params.requestEnvelope.primaryInstruction || params.requestEnvelope.pureUserText)
    ? params.requestEnvelope
    : buildRequestEnvelope({ userText: contextualUserInput })
  const documentTaskPlan = buildDocumentTaskPlan({
    requestEnvelope: effectiveEnvelope,
    userInstructionText,
  })
  const shouldUseDocumentTaskPlan = Boolean(
    documentTaskPlan.blockedReason || (documentTaskPlan.requiresStructuredPlan && documentTaskPlan.jobs.length > 0),
  )

  const computedIntentClassification = classifyIntent(effectiveEnvelope, {
    registeredSkillTokens: params.registeredSkillTokens || undefined,
  })
  const intentClassification = computedIntentClassification.primaryDomain === 'skill'
    && params.intentClassification?.primaryDomain !== 'skill'
    ? computedIntentClassification
    : (params.intentClassification || computedIntentClassification)

  logAgentMetric('intent_context', {
    envelopeHasWidgetTarget,
    leaseValid: Boolean(leaseValid),
    leaseStickyEligible,
    hasWidgetTargetContext,
    explicitWidgetCreateIntent,
    inferredWidgetTaskKind,
    resolvedWidgetTaskKind: documentWidgetTaskKind,
    structuredIntent: documentTaskPlan.requiresStructuredPlan ? documentTaskPlan.jobs.length : 0,
    shouldUseDocumentTaskPlan,
    primaryInstruction: (params.requestEnvelope.primaryInstruction || '').slice(0, 120),
    contextualInputPreview: contextualUserInput.slice(0, 120),
    registeredSkillHistoryReused: Boolean(isRetryOnlyPrompt(primaryInput) && registeredSkillHistoryInput),
    leaseWidgetId: params.activeWidgetEditLease?.widgetId || null,
    leaseTabId: params.activeWidgetEditLease?.tabId || null,
    leaseAgeMs: params.activeWidgetEditLease
      ? Math.max(0, Date.now() - params.activeWidgetEditLease.acquiredAt)
      : null,
    leaseRefreshed,
    providedPrimaryDomain: params.intentClassification?.primaryDomain || null,
    resolvedPrimaryDomain: intentClassification.primaryDomain,
    mapSemanticIntent: params.mapSemanticIntent?.isMapIntent ? params.mapSemanticIntent.primaryTask : null,
    mapSemanticConfidence: params.mapSemanticIntent?.confidence ?? null,
    skillIntentUpgraded: computedIntentClassification.primaryDomain === 'skill'
      && params.intentClassification?.primaryDomain !== 'skill',
  })

  const hasDocumentEnvironment =
    hasWritableDocumentContext(params.requestEnvelope)
    || (params.requestEnvelope.rawUserText.includes('## 环境信息') && params.requestEnvelope.rawUserText.includes('当前模式: 文档模式'))

  return {
    requestEnvelope: effectiveEnvelope,
    intentClassification,
    contextualUserInput,
    userInstructionText,
    hasDocumentEnvironment,
    hasWidgetTargetContext,
    explicitWidgetCreateIntent,
    documentWidgetTaskKind,
    documentWidgetProfile: inferDocumentWidgetProfile(contextualUserInput),
    structuredDocumentIntent: classifyStructuredDocumentIntent(userInstructionText),
    documentTaskPlan,
    shouldUseDocumentTaskPlan,
    mapSemanticIntent: params.mapSemanticIntent ?? null,
  }
}

export interface IntentCapabilityGroupModeResolution {
  intentGroupModes: Partial<Record<CapabilityGroupId, boolean>>
  allowDocumentTools: boolean
  allowRSSTools: boolean
  allowCalendarTools: boolean
  allowFeishuTools: boolean
  allowPetTools: boolean
  allowSkillTools: boolean
  allowResearchTools: boolean
  allowMapTools: boolean
  forceDocumentTool: boolean
}

export function resolveIntentCapabilityGroupModes(params: {
  hasTools: boolean
  capabilityProfile?: CapabilityProfileId
  contextualUserInput: string
  userInstructionText: string
  intentClassification: IntentClassification
  hasDocumentEnvironment: boolean
  hasWidgetTargetContext: boolean
  explicitWidgetCreateIntent: boolean
  documentWidgetTaskKind: DocumentWidgetTaskKind
  preferredSkillToolNames?: string[] | null
  mapSemanticIntent?: MapSemanticIntent | null
}): IntentCapabilityGroupModeResolution {
  const hasLiveInfoBrowserIntent = params.intentClassification.objectSignals.some((signal) => /browser-live-info/i.test(signal))
  const positiveDomains = new Set<IntentClassification['primaryDomain'] | Exclude<IntentClassification['primaryDomain'], 'generic'>>([
    params.intentClassification.primaryDomain,
    ...params.intentClassification.mentionedDomains,
  ])
  const excludedDomains = new Set(params.intentClassification.excludedDomains)
  const hasDocumentKeyword = DOCUMENT_TOOL_SURFACE_PATTERN.test(params.userInstructionText)
  const hasDocumentIntent = positiveDomains.has('document') && !excludedDomains.has('document')
  const hasRSSIntent = positiveDomains.has('rss') && !excludedDomains.has('rss')
  const hasCalendarIntent = positiveDomains.has('calendar') && !excludedDomains.has('calendar')
  const hasFeishuIntent = positiveDomains.has('feishu') && !excludedDomains.has('feishu')
  const hasPetIntent = positiveDomains.has('pet') && !excludedDomains.has('pet')
  const hasMapIntent = isMapSemanticIntentActive(params.mapSemanticIntent)
  const mapSecondarySignals = new Set(params.mapSemanticIntent?.secondarySignals || [])
  const isPetDominantIntent = params.intentClassification.primaryDomain === 'pet' && hasPetIntent
  const hasExplicitDocumentSurface = DOCUMENT_TOOL_SURFACE_PATTERN.test(params.userInstructionText)
  const hasDocumentContextContinuation =
    params.hasDocumentEnvironment
    && DOCUMENT_CONTEXT_CONTINUATION_PATTERN.test(params.userInstructionText)
  const allowDocumentTools = params.hasTools && (
    (!isPetDominantIntent && hasDocumentKeyword) ||
    (params.hasDocumentEnvironment && (hasDocumentKeyword || hasExplicitDocumentSurface)) ||
    hasDocumentContextContinuation ||
    params.hasWidgetTargetContext ||
    Boolean(params.documentWidgetTaskKind) ||
    shouldForceDocumentToolCall(params.contextualUserInput) ||
    // NOTE: no standalone hasExplicitDocumentSurface clause here. Since
    // e75e4050 unified both regexes it became identical to hasDocumentKeyword,
    // and as an ungated clause it made the `!isPetDominantIntent` suppression
    // above dead code (pet-sticky-tool-contract). Pet-dominant turns must not
    // expose document tools on surface keywords alone.
    hasDocumentIntent ||
    (hasMapIntent && mapSecondarySignals.has('document_output'))
  )
  const allowRSSTools = params.hasTools && hasRSSIntent
  const allowCalendarTools = params.hasTools && hasCalendarIntent
  const allowFeishuTools = params.hasTools && (
    params.capabilityProfile === 'remote_channel' ||
    hasFeishuIntent
  )
  const allowPetTools = params.hasTools && hasPetIntent
  const allowSkillTools = params.hasTools
    && Array.isArray(params.preferredSkillToolNames)
    && params.preferredSkillToolNames.length > 0
  const hasResearchIntent = positiveDomains.has('research') && !excludedDomains.has('research')
  const allowResearchTools = params.hasTools && (
    hasResearchIntent || (hasMapIntent && mapSecondarySignals.has('research_lookup'))
  )
  const allowMapTools = params.hasTools && hasMapIntent
  const allowMapBrowserTools = hasMapIntent && mapSecondarySignals.has('browser_lookup')
  const forceDocumentTool = allowDocumentTools && (
    (params.hasWidgetTargetContext && !params.explicitWidgetCreateIntent) ||
    hasDocumentContextContinuation ||
    shouldForceDocumentToolCall(params.contextualUserInput)
  )

  return {
    intentGroupModes: {
      ...(hasLiveInfoBrowserIntent ? { browser_interaction: true } : {}),
      ...(allowMapBrowserTools ? { browser_interaction: true, browser_content_tasks: true } : {}),
      document: allowDocumentTools,
      rss: allowRSSTools,
      calendar: allowCalendarTools,
      channel_feishu: allowFeishuTools,
      pet: allowPetTools,
      skills: allowSkillTools,
      general_research: allowResearchTools,
      map_planning: allowMapTools,
    },
    allowDocumentTools,
    allowRSSTools,
    allowCalendarTools,
    allowFeishuTools,
    allowPetTools,
    allowSkillTools,
    allowResearchTools,
    allowMapTools,
    forceDocumentTool,
  }
}

export function buildExecutionToolState(params: {
  config?: AIModelConfig
  capabilityProfile?: CapabilityProfileId
  supportsToolCalls: boolean
  hasVideoInputs: boolean
  hasIncomingVideo: boolean
  keepToolsWithVideo: boolean
  preferredSkillToolNames?: string[] | null
  contextualUserInput: string
  userInstructionText: string
  intentClassification: IntentClassification
  hasDocumentEnvironment: boolean
  hasWidgetTargetContext: boolean
  explicitWidgetCreateIntent: boolean
  documentWidgetTaskKind: DocumentWidgetTaskKind
  documentWidgetProfile: DocumentWidgetProfile | null
  mapSemanticIntent?: MapSemanticIntent | null
  browserDecisionMode: BrowserTaskDecisionMode
  browserHostAvailable?: boolean
  feishuConnected?: boolean
  sessionId?: string
}): { visibilityPlan: ToolVisibilityPlan; toolPolicy: ToolPolicy; capabilityResolution: CapabilityResolution } {
  const baseVisibilityPlan = buildToolVisibilityPlan({
    supportsToolCalls: params.supportsToolCalls,
    hasVideoInputs: params.hasVideoInputs,
    hasIncomingVideo: params.hasIncomingVideo,
    keepToolsWithVideo: params.keepToolsWithVideo,
    allowBrowserTools:
      params.browserDecisionMode === 'browser_workflow' || params.browserDecisionMode === 'browser_upload_workflow',
    preferredSkillToolNames: params.preferredSkillToolNames,
  })
  const intentModes = resolveIntentCapabilityGroupModes({
    hasTools: baseVisibilityPlan.hasTools,
    capabilityProfile: params.capabilityProfile,
    contextualUserInput: params.contextualUserInput,
    userInstructionText: params.userInstructionText,
    intentClassification: params.intentClassification,
    hasDocumentEnvironment: params.hasDocumentEnvironment,
    hasWidgetTargetContext: params.hasWidgetTargetContext,
    explicitWidgetCreateIntent: params.explicitWidgetCreateIntent,
    documentWidgetTaskKind: params.documentWidgetTaskKind,
    preferredSkillToolNames: params.preferredSkillToolNames,
    mapSemanticIntent: params.mapSemanticIntent,
  })
  const { allowDocumentTools } = intentModes
  const capabilityResolution = resolveCapabilityResolution({
    config: params.config || getDefaultConfig(),
    profile: params.capabilityProfile || 'local_chat',
    browserDecisionMode: params.browserDecisionMode,
    runtimeAvailability: {
      browserHostAvailable: params.browserHostAvailable ?? true,
      feishuConnected: params.feishuConnected ?? true,
    },
    intentGroupModes: intentModes.intentGroupModes,
  })
  const allowBrowserTools = capabilityResolution.visibleCapabilityGroupIds.includes('browser_interaction')
    || capabilityResolution.visibleCapabilityGroupIds.includes('browser_content_tasks')

  const visibilityPlan: ToolVisibilityPlan = {
    ...baseVisibilityPlan,
    allowBrowserTools,
    visibleCapabilityGroupIds: capabilityResolution.visibleCapabilityGroupIds,
    hostOnlyCapabilityIds: capabilityResolution.hostOnlyCapabilityIds,
    suppressedCapabilityGroupIds: capabilityResolution.suppressedCapabilityGroupIds,
    capabilityReasons: capabilityResolution.reasons,
  }

  return {
    visibilityPlan,
    capabilityResolution,
    toolPolicy: {
      forceDocumentTool: intentModes.forceDocumentTool,
      allowDocumentTools,
      forceDesignTool: false,
      preferredDesignTool: null,
      primaryDesignInstruction: null,
      allowMultipleDesignArtifacts: false,
      preferSectionRewrite: baseVisibilityPlan.hasTools && shouldPreferSectionRewrite(params.userInstructionText),
      preferFormatOnly: baseVisibilityPlan.hasTools && shouldPreferFormatOnly(params.userInstructionText),
      documentWidgetTaskKind: params.documentWidgetTaskKind,
      documentWidgetProfile: params.documentWidgetProfile,
      documentWidgetSourceText: params.contextualUserInput,
      allowBrowserTools,
      preferredSkillToolNames: visibilityPlan.preferredSkillToolNames,
      visibleCapabilityGroupIds: capabilityResolution.visibleCapabilityGroupIds,
      hostOnlyCapabilityGroupIds: capabilityResolution.hostOnlyCapabilityIds,
      capabilityReasons: capabilityResolution.reasons,
      sessionId: params.sessionId,
    },
  }
}
