import type { AIModelConfig } from '../../../shared/ai-providers'
import { shouldRetryWithTextToolBridge, shouldUseTextToolBridgeForRun } from '../agent-control/provider-runtime-resolver'

export type ExecutionFallbackKind = 'none' | 'text_bridge' | 'video_frames' | 'wire_api_retry' | 'kimi_coding_retry'

export interface ExecutionFallbackInfo {
  kind: Exclude<ExecutionFallbackKind, 'none'>
  attempts: number
}

export interface ExecutionFallbackState {
  happened: boolean
  kind: ExecutionFallbackKind
  attempts: number
}

export interface ExecutionFallbackPlan {
  kind: ExecutionFallbackKind
  shouldRetry: boolean
}

export function resolveFallbackPlan(params:
  | {
    mode: 'openai_prefer_text_bridge' | 'openai_missing_native_tools'
    config: AIModelConfig
    preferTextToolBridge: boolean
    text?: string
  }
  | {
    mode: 'video_frames'
    hasVideoInputs: boolean
    error: unknown
  }
  | {
    mode: 'openai_wire_api' | 'kimi_coding'
    error: unknown
  }
): ExecutionFallbackPlan {
  switch (params.mode) {
    case 'openai_prefer_text_bridge':
      return {
        kind: 'text_bridge',
        shouldRetry: shouldUseTextToolBridgeForRun({
          config: params.config,
          preferTextToolBridge: params.preferTextToolBridge,
        }),
      }
    case 'openai_missing_native_tools':
      return {
        kind: 'text_bridge',
        shouldRetry: shouldRetryWithTextToolBridge({
          text: params.text || '',
          config: params.config,
          preferTextToolBridge: params.preferTextToolBridge,
        }),
      }
    case 'video_frames':
      return {
        kind: 'video_frames',
        shouldRetry: params.hasVideoInputs && shouldRetryWithVideoFrames(params.error),
      }
    case 'openai_wire_api':
      return {
        kind: 'wire_api_retry',
        shouldRetry: shouldRetryWithWireApi(params.error),
      }
    case 'kimi_coding':
      return {
        kind: 'kimi_coding_retry',
        shouldRetry: shouldRetryWithKimiCoding(params.error),
      }
  }
}

export function annotateFallbackResult<T extends object>(
  result: T,
  fallback: ExecutionFallbackInfo | null | undefined,
): T & { fallback?: ExecutionFallbackInfo } {
  if (!fallback) {
    return result as T & { fallback?: ExecutionFallbackInfo }
  }
  if ('fallback' in result && (result as { fallback?: ExecutionFallbackInfo }).fallback) {
    return result as T & { fallback?: ExecutionFallbackInfo }
  }
  return {
    ...result,
    fallback,
  }
}

export function buildExecutionFallbackState(
  fallback: { kind: string; attempts: number; happened?: boolean } | null | undefined,
): ExecutionFallbackState {
  if (!fallback) {
    return {
      happened: false,
      kind: 'none',
      attempts: 0,
    }
  }

  const kind = String(fallback.kind || 'none').trim() as ExecutionFallbackKind
  const attempts = Math.max(0, Number(fallback.attempts || 0))
  const happened = typeof (fallback as ExecutionFallbackState).happened === 'boolean'
    ? (fallback as ExecutionFallbackState).happened
    : kind !== 'none'

  if (!happened || kind === 'none') {
    return {
      happened: false,
      kind: 'none',
      attempts: 0,
    }
  }

  return {
    happened: true,
    kind,
    attempts,
  }
}

function shouldRetryWithVideoFrames(error: unknown): boolean {
  const message = stringifyError(error)
  return /HTTP 400/i.test(message)
}

function shouldRetryWithWireApi(error: unknown): boolean {
  const message = stringifyError(error)
  return /(HTTP 400|HTTP 404|HTTP 405|HTTP 415|HTTP 422|HTTP 501)/i.test(message)
}

function shouldRetryWithKimiCoding(error: unknown): boolean {
  const message = stringifyError(error)
  return /(HTTP 408|HTTP 409|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504)/i.test(message)
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
