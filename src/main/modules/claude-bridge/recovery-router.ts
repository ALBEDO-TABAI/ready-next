import type { ErrorClassifierResult } from './error-classifier'

export interface RecoveryPlan {
  shouldRetry: boolean
  retryDelayMs?: number
  backoff?: 'fixed' | 'exponential_jitter'
  maxAttempts: number
  shouldCompressContext: boolean
  shouldSurfaceDirectly: boolean
}

export function buildRecoveryPlan(result: ErrorClassifierResult): RecoveryPlan {
  switch (result.kind) {
    case 'rate_limit':
      return {
        shouldRetry: true,
        retryDelayMs: result.suggestedDelayMs || 350,
        backoff: 'exponential_jitter',
        maxAttempts: 3,
        shouldCompressContext: false,
        shouldSurfaceDirectly: false,
      }
    case 'context_overflow':
      return {
        shouldRetry: true,
        maxAttempts: 1,
        shouldCompressContext: true,
        shouldSurfaceDirectly: false,
      }
    case 'timeout_model':
    case 'transient':
      return {
        shouldRetry: true,
        retryDelayMs: result.suggestedDelayMs || 500,
        backoff: result.kind === 'transient' ? 'exponential_jitter' : 'fixed',
        maxAttempts: result.kind === 'timeout_model' ? 1 : 3,
        shouldCompressContext: false,
        shouldSurfaceDirectly: false,
      }
    case 'timeout_tool':
    case 'auth':
    case 'host_unavailable':
      return {
        shouldRetry: false,
        maxAttempts: 0,
        shouldCompressContext: false,
        shouldSurfaceDirectly: true,
      }
    default:
      return {
        shouldRetry: false,
        maxAttempts: 0,
        shouldCompressContext: false,
        shouldSurfaceDirectly: false,
      }
  }
}
