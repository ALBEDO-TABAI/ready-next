import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type { AIModelConfig } from '../../../shared/ai-providers'
import { getDefaultConfig } from '../../../shared/ai-providers'
import type { CapabilityProfileId } from '../../../shared/ai-capability-groups'
import type { ToolVisibilityPlan } from './run-contracts'
import { buildToolVisibilityPlan } from './execution-tool-policy'
import type { ToolPolicy } from './execution-tool-config'
import { resolveCapabilityResolution, type CapabilityResolution } from './capability-resolver'
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
  contextualUserInput: string
  userInstructionText: string
  hasDocumentEnvironment: boolean
  hasWidgetTargetContext: boolean
  explicitWidgetCreateIntent: boolean
  documentWidgetTaskKind: DocumentWidgetTaskKind
  documentWidgetProfile: DocumentWidgetProfile | null
}

export function resolveExecutionIntentContext(params: {
  userText: string
  pureUserInput: string
  previousInputs: string[]
  lastDocumentContextInput?: string | null
}): ExecutionIntentContext {
  const hasWidgetTargetContext = params.userText.includes('### Widget 更新上下文')
  const contextualUserInput = resolveToolPolicyInput(
    params.pureUserInput,
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

  return {
    contextualUserInput,
    userInstructionText,
    hasDocumentEnvironment: params.userText.includes('## 环境信息') && params.userText.includes('当前模式: 文档模式'),
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
  const hasDocumentKeyword =
    /(文档|文稿|原文|文章|段落|章节|docx?|markdown|\.md\b|widget|show-widget|图表|趋势图|卡片|信息卡|提示块|表格|对比卡|进度卡|日程卡|待办|习惯|计划板|计算器|保存|写入|追加|替换|编辑|改写|润色|排版|格式)/i
      .test(params.userInstructionText)
  const hasRSSKeyword =
    /(^|[^a-z])(rss|feed|rsshub)([^a-z]|$)|订阅源|订阅|源站|抓取文章|抓取订阅|信息源/i
      .test(params.userInstructionText)
  const hasCalendarKeyword =
    /日历|日程|会议|提醒|排期|行程|calendar|event|时间冲突|安排到.*(今天|明天|本周|日历)/i
      .test(params.userInstructionText)
  const hasFeishuKeyword =
    /飞书|feishu|lark|多维表格|飞书文档|飞书群|飞书消息|群聊|知识库/i
      .test(params.userInstructionText)
  const allowDocumentTools = baseVisibilityPlan.hasTools && (
    params.hasDocumentEnvironment ||
    params.hasWidgetTargetContext ||
    Boolean(params.documentWidgetTaskKind) ||
    shouldForceDocumentToolCall(params.contextualUserInput) ||
    hasDocumentKeyword
  )
  const allowRSSTools = baseVisibilityPlan.hasTools && hasRSSKeyword
  const allowCalendarTools = baseVisibilityPlan.hasTools && hasCalendarKeyword
  const allowFeishuTools = baseVisibilityPlan.hasTools && (
    params.capabilityProfile === 'remote_channel' ||
    hasFeishuKeyword
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
