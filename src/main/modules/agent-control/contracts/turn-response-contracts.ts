import type { AIModelConfig } from '../../../../shared/ai-providers'
import type { RecoveryRecord, ToolSnapshot } from './tool-telemetry-contracts'
import type { TaskInteractionState } from './run-contracts'

export interface TurnProviderContext {
  config: AIModelConfig
  baseUrl: string
  provider?: unknown
  isKimi: boolean
  isKimiCoding: boolean
  useAnthropicProtocol: boolean
  supportsToolCalls: boolean
  supportsVideoBlock: boolean
  hasRawVideoInIncoming: boolean
}

export interface TurnSimpleResponse {
  text: string
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
  } | null
}

export interface TurnToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface TurnToolExecutionResult {
  id: string
  name: string
  input: Record<string, unknown>
  result: {
    text: string
    shape?: string
    data?: unknown
    projectionPatch?: Record<string, unknown> | null
    interactionHint?: string | null
  }
}

export interface TurnToolBatchResult {
  results: TurnToolExecutionResult[]
  budgetLimited: boolean
  recoveryHistory: RecoveryRecord[]
}

export interface TurnToolCallParseError {
  route: 'chat_completions' | 'responses'
  toolName?: string
  callId?: string
  reason: 'corrupt'
}

export interface TurnModelResponse extends TurnSimpleResponse {
  toolCalls: TurnToolCall[]
  stopReason: string
  reasoningContent?: unknown
  providerResponseId?: string
  rawText?: string
  toolTransport?: 'native' | 'text'
  toolCallParseErrors?: TurnToolCallParseError[]
  toolSnapshots?: ToolSnapshot[]
  recoveryHistory?: RecoveryRecord[]
}

export interface TurnShortcutResult {
  finalText?: string | null
  error?: string
  interactionState?: TaskInteractionState
  status?: 'done' | 'error' | 'cancelled'
  success?: boolean
}
