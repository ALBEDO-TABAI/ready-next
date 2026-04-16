import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type { AIModelConfig } from '../../../shared/ai-providers'
import { getDefaultConfig } from '../../../shared/ai-providers'
import type { CapabilityProfileId } from '../../../shared/ai-capability-groups'
import type { ToolVisibilityPlan } from './run-contracts'
import { buildToolVisibilityPlan } from './execution-tool-policy'
import type { ToolPolicy } from './execution-tool-config'
import { resolveCapabilityResolution, type CapabilityResolution } from './capability-resolver'
import type { IntentClassification } from './intent-classifier'
import { classifyIntent } from './intent-classifier'
import type { RequestEnvelope } from './request-envelope'
import { buildRequestEnvelope } from './request-envelope'
import {
  extractPrimaryUserInstruction,
  hasExplicitDocumentWidgetCreateIntent,
  inferDocumentWidgetTaskKind,
  shouldForceDocumentToolCall,
  shouldPreferFormatOnly,
  shouldPreferSectionRewrite,
  type DocumentWidgetTaskKind,
} from '../claude-bridge/tool-policy-heuristics'
import { resolveToolPolicyInput } from '../claude-bridge/tool-policy-context'
import { inferDocumentWidgetProfile, type DocumentWidgetProfile } from '../claude-bridge/widget-guidance'

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
}

export function resolveExecutionIntentContext(params: {
  requestEnvelope: RequestEnvelope
  previousInputs: string[]
  lastDocumentContextInput?: string | null
  intentClassification?: IntentClassification | null
}): ExecutionIntentContext {
  const hasWidgetTargetContext = params.requestEnvelope.environmentHints.hasWidgetTargetContext
  const contextualUserInput = resolveToolPolicyInput(
    params.requestEnvelope.primaryInstruction || params.requestEnvelope.pureUserText,
    params.lastDocumentContextInput
      ? [params.lastDocumentContextInput, ...params.previousInputs]
      : params.previousInputs,
  )
  const userInstructionText = extractPrimaryUserInstruction(contextualUserInput)
  const explicitWidgetCreateIntent = hasExplicitDocumentWidgetCreateIntent(contextualUserInput)
  const documentWidgetTaskKind =
    hasWidgetTargetContext && !explicitWidgetCreateIntent
      ? 'update'
      : inferDocumentWidgetTaskKind(contextualUserInput)
  const effectiveEnvelope = contextualUserInput === (params.requestEnvelope.primaryInstruction || params.requestEnvelope.pureUserText)
    ? params.requestEnvelope
    : buildRequestEnvelope({ userText: contextualUserInput })

  return {
    requestEnvelope: effectiveEnvelope,
    intentClassification: params.intentClassification || classifyIntent(effectiveEnvelope),
    contextualUserInput,
    userInstructionText,
    hasDocumentEnvironment: params.requestEnvelope.rawUserText.includes('## 环境信息') && params.requestEnvelope.rawUserText.includes('当前模式: 文档模式'),
    hasWidgetTargetContext,
    explicitWidgetCreateIntent,
    documentWidgetTaskKind,
    documentWidgetProfile: inferDocumentWidgetProfile(contextualUserInput),
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
  browserDecisionMode: BrowserTaskDecisionMode
  browserHostAvailable?: boolean
  feishuConnected?: boolean
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
  const positiveDomains = new Set<IntentClassification['primaryDomain'] | Exclude<IntentClassification['primaryDomain'], 'generic'>>([
    params.intentClassification.primaryDomain,
    ...params.intentClassification.mentionedDomains,
  ])
  const excludedDomains = new Set(params.intentClassification.excludedDomains)
  const hasDocumentKeyword =
    /(文档|文稿|原文|文章|段落|章节|docx?|markdown|\.md\b|widget|show-widget|图表|趋势图|卡片|信息卡|提示块|表格|对比卡|进度卡|日程卡|待办|习惯|计划板|计算器|保存|写入|追加|替换|编辑|改写|润色|排版|格式)/i
      .test(params.userInstructionText)
  const hasDocumentIntent = positiveDomains.has('document') && !excludedDomains.has('document')
  const hasRSSIntent = positiveDomains.has('rss') && !excludedDomains.has('rss')
  const hasCalendarIntent = positiveDomains.has('calendar') && !excludedDomains.has('calendar')
  const hasFeishuIntent = positiveDomains.has('feishu') && !excludedDomains.has('feishu')
  const allowDocumentTools = baseVisibilityPlan.hasTools && (
    (params.hasDocumentEnvironment && hasDocumentKeyword) ||
    params.hasWidgetTargetContext ||
    Boolean(params.documentWidgetTaskKind) ||
    shouldForceDocumentToolCall(params.contextualUserInput) ||
    hasDocumentKeyword ||
    hasDocumentIntent
  )
  const allowRSSTools = baseVisibilityPlan.hasTools && hasRSSIntent
  const allowCalendarTools = baseVisibilityPlan.hasTools && hasCalendarIntent
  const allowFeishuTools = baseVisibilityPlan.hasTools && (
    params.capabilityProfile === 'remote_channel' ||
    hasFeishuIntent
  )
  const capabilityResolution = resolveCapabilityResolution({
    config: params.config || getDefaultConfig(),
    profile: params.capabilityProfile || 'local_chat',
    browserDecisionMode: params.browserDecisionMode,
    runtimeAvailability: {
      browserHostAvailable: params.browserHostAvailable ?? true,
      feishuConnected: params.feishuConnected ?? true,
    },
    intentGroupModes: {
      document: allowDocumentTools,
      rss: allowRSSTools,
      calendar: allowCalendarTools,
      channel_feishu: allowFeishuTools,
    },
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
      forceDocumentTool: allowDocumentTools && (
        (params.hasWidgetTargetContext && !params.explicitWidgetCreateIntent) ||
        shouldForceDocumentToolCall(params.contextualUserInput)
      ),
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
    },
  }
}
