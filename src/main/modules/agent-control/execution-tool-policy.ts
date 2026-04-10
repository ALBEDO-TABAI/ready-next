import type { ToolDispatchDecision, ToolVisibilityPlan } from './run-contracts'

export function buildToolVisibilityPlan(params: {
  supportsToolCalls: boolean
  hasVideoInputs: boolean
  hasIncomingVideo: boolean
  keepToolsWithVideo: boolean
  allowBrowserTools: boolean
  preferredSkillToolNames?: string[] | null
}): ToolVisibilityPlan {
  const hasTools = params.supportsToolCalls && (
    (!params.hasVideoInputs && !params.hasIncomingVideo) ||
    params.keepToolsWithVideo
  )
  return {
    hasTools,
    keepToolsWithVideo: params.keepToolsWithVideo,
    allowBrowserTools: hasTools && params.allowBrowserTools,
    preferredSkillToolNames: params.preferredSkillToolNames || null,
  }
}

export function buildToolDispatchDecision(params: {
  supportsToolCalls: boolean
  supportsNativeToolCalls: boolean
  toolCallTransport?: 'native' | 'text' | 'none' | null
  preferTextToolBridge: boolean
}): ToolDispatchDecision {
  if (!params.supportsToolCalls) {
    return {
      transport: 'none',
      supportsNativeTools: false,
      preferTextToolBridge: false,
    }
  }

  const preferTextToolBridge = params.preferTextToolBridge || params.toolCallTransport === 'text'
  return {
    transport: preferTextToolBridge ? 'text' : 'native',
    supportsNativeTools: Boolean(params.supportsNativeToolCalls),
    preferTextToolBridge,
  }
}
