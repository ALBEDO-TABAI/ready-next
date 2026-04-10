import type { BrowserTaskDecisionMode } from '../../../shared/browser-agent-task'
import type { ToolVisibilityPlan } from './run-contracts'
import { buildToolVisibilityPlan } from './execution-tool-policy'
import type { ToolPolicy } from './execution-tool-config'
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
  supportsToolCalls: boolean
  hasVideoInputs: boolean
  hasIncomingVideo: boolean
  keepToolsWithVideo: boolean
  preferredSkillToolNames?: string[] | null
  contextualUserInput: string
  userInstructionText: string
  hasWidgetTargetContext: boolean
  explicitWidgetCreateIntent: boolean
  documentWidgetTaskKind: DocumentWidgetTaskKind
  documentWidgetProfile: DocumentWidgetProfile | null
  browserDecisionMode: BrowserTaskDecisionMode
}): { visibilityPlan: ToolVisibilityPlan; toolPolicy: ToolPolicy } {
  const visibilityPlan = buildToolVisibilityPlan({
    supportsToolCalls: params.supportsToolCalls,
    hasVideoInputs: params.hasVideoInputs,
    hasIncomingVideo: params.hasIncomingVideo,
    keepToolsWithVideo: params.keepToolsWithVideo,
    allowBrowserTools:
      params.browserDecisionMode === 'browser_workflow' || params.browserDecisionMode === 'browser_upload_workflow',
    preferredSkillToolNames: params.preferredSkillToolNames,
  })

  return {
    visibilityPlan,
    toolPolicy: {
      forceDocumentTool: visibilityPlan.hasTools && (
        (params.hasWidgetTargetContext && !params.explicitWidgetCreateIntent) ||
        shouldForceDocumentToolCall(params.contextualUserInput)
      ),
      forceDesignTool: false,
      preferredDesignTool: null,
      primaryDesignInstruction: null,
      allowMultipleDesignArtifacts: false,
      preferSectionRewrite: visibilityPlan.hasTools && shouldPreferSectionRewrite(params.userInstructionText),
      preferFormatOnly: visibilityPlan.hasTools && shouldPreferFormatOnly(params.userInstructionText),
      documentWidgetTaskKind: params.documentWidgetTaskKind,
      documentWidgetProfile: params.documentWidgetProfile,
      documentWidgetSourceText: params.contextualUserInput,
      allowBrowserTools: visibilityPlan.allowBrowserTools,
      preferredSkillToolNames: visibilityPlan.preferredSkillToolNames,
    },
  }
}
