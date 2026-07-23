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
        // 2026-07-23: novacode 502 窗口可持续数分钟；3 次 ~3.7s 远不够。
        // 6 次指数抖动（上限 30s）总等待约 63s，覆盖短暂故障窗口。
        maxAttempts: result.kind === 'timeout_model' ? 1 : 6,
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
