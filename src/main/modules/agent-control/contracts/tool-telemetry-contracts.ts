import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'

export interface RecoveryRecord {
  kind:
    | 'rate_limit'
    | 'context_overflow'
    | 'timeout_model'
    | 'timeout_tool'
    | 'auth'
    | 'transient'
    | 'host_unavailable'
  source: 'model_request' | 'tool_execution' | 'runtime'
  message: string
  attempt: number
  recovered: boolean
  timestamp: string
}

export interface ToolSnapshot {
  stage: 'host_prepared' | 'host_effective' | 'tool_loop_request' | 'provider_request' | 'provider_response'
  source: 'host' | 'provider'
  iteration: number
  provider: string
  baseUrl: string
  model: string
  wireApi?: 'responses' | 'chat/completions' | null
  browserDecisionMode?: string | null
  browserHostAvailable?: boolean | null
  hasTools: boolean
  allowBrowserTools: boolean
  visibleCapabilityGroupIds: CapabilityGroupId[]
  suppressedCapabilityGroupIds: CapabilityGroupId[]
  allowedToolNames: string[]
  requestedTransport: 'native' | 'text' | 'none'
  effectiveTransport: 'native' | 'text' | 'none'
  supportsNativeTools: boolean
  preferTextToolBridge: boolean
  fallbackReason?: string | null
  toolCallsCount?: number | null
  mismatch?: boolean
}
