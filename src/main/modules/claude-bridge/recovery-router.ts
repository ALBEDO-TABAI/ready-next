import type { ErrorClassifierResult } from './error-classifier'

export interface RecoveryPlan {
  shouldRetry: boolean
  retryDelayMs?: number
  shouldCompressContext: boolean
  shouldSurfaceDirectly: boolean
}

export function buildRecoveryPlan(result: ErrorClassifierResult): RecoveryPlan {
  switch (result.kind) {
    case 'rate_limit':
      return {
        shouldRetry: true,
        retryDelayMs: result.suggestedDelayMs || 350,
        shouldCompressContext: false,
        shouldSurfaceDirectly: false,
      }
    case 'context_overflow':
      return {
        shouldRetry: true,
        shouldCompressContext: true,
        shouldSurfaceDirectly: false,
      }
    case 'timeout_model':
    case 'transient':
      return {
        shouldRetry: true,
        retryDelayMs: result.suggestedDelayMs || 500,
        shouldCompressContext: false,
        shouldSurfaceDirectly: false,
      }
    case 'timeout_tool':
    case 'auth':
    case 'host_unavailable':
      return {
        shouldRetry: false,
        shouldCompressContext: false,
        shouldSurfaceDirectly: true,
      }
    default:
      return {
        shouldRetry: false,
        shouldCompressContext: false,
        shouldSurfaceDirectly: false,
      }
  }
}
