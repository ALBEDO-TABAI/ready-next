import { classifyExecutionError } from '../../claude-bridge/error-classifier'
import {
  buildProviderHttpError,
  isRetryableProviderHttpStatus,
  parseRetryAfterHeader,
} from '../../claude-bridge/provider-terminal-error'
import { buildRecoveryPlan } from '../../claude-bridge/recovery-router'
import { logAgentMetric } from '../metrics'
import { waitForAbortableRetryDelay } from './agent-sdk-execution-utils'
import type { AgentSdkRuntimeDeps } from './agent-sdk-types'

const RETRY_EXHAUSTED_PROPERTY = '__readyProviderRequestRetryExhausted' as const
type FetchWithTimeout = NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>

function markRetryExhausted(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error
  Object.defineProperty(error, RETRY_EXHAUSTED_PROPERTY, {
    value: true,
    enumerable: false,
    configurable: true,
  })
  return error
}

export function isProviderRequestRetryExhausted(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { [RETRY_EXHAUSTED_PROPERTY]?: unknown })[RETRY_EXHAUSTED_PROPERTY] === true
  )
}

function retryDelayMs(input: {
  attempt: number
  baseDelayMs: number
  backoff: 'fixed' | 'exponential_jitter' | undefined
  retryAfterSeconds?: number
}): number {
  if (input.retryAfterSeconds) {
    return Math.min(input.retryAfterSeconds * 1_000, 30_000)
  }
  if (input.backoff !== 'exponential_jitter') return input.baseDelayMs
  return Math.min(
    input.baseDelayMs * 2 ** (input.attempt - 1) + Math.floor(Math.random() * 100),
    30_000,
  )
}

export async function fetchProviderRequestWithRetry(input: {
  fetchWithTimeout: FetchWithTimeout
  url: string
  init: RequestInit
  signal: AbortSignal
  label: string
  path: 'chat' | 'responses' | 'anthropic'
  provider: string | null
}): Promise<Response> {
  let retryAttempts = 0

  while (true) {
    let response: Response
    try {
      response = await input.fetchWithTimeout(
        input.url,
        input.init,
        input.signal,
        input.label,
      )
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason || error
      const classified = classifyExecutionError(error, { source: 'model_request' })
      const recovery = buildRecoveryPlan(classified)
      if (
        !recovery.shouldRetry
        || recovery.shouldCompressContext
        || retryAttempts >= recovery.maxAttempts
      ) {
        throw markRetryExhausted(error)
      }
      retryAttempts += 1
      const delayMs = retryDelayMs({
        attempt: retryAttempts,
        baseDelayMs: recovery.retryDelayMs || 500,
        backoff: recovery.backoff,
      })
      logAgentMetric('provider_request_retry', {
        path: input.path,
        provider: input.provider,
        reason: classified.kind,
        attempt: retryAttempts,
        maxAttempts: recovery.maxAttempts,
        delayMs,
      })
      await waitForAbortableRetryDelay(delayMs, input.signal)
      continue
    }

    if (!isRetryableProviderHttpStatus(response.status)) return response

    const rawError = await response.text().catch(() => '')
    const retryAfterSeconds = parseRetryAfterHeader(response.headers.get('retry-after'))
    const error = buildProviderHttpError({
      httpStatus: response.status,
      errorBody: rawError,
      retryAfterSeconds,
    })
    const classified = classifyExecutionError(error, { source: 'model_request' })
    const recovery = buildRecoveryPlan(classified)
    if (
      !recovery.shouldRetry
      || recovery.shouldCompressContext
      || retryAttempts >= recovery.maxAttempts
    ) {
      throw markRetryExhausted(error)
    }

    retryAttempts += 1
    const delayMs = retryDelayMs({
      attempt: retryAttempts,
      baseDelayMs: recovery.retryDelayMs || 500,
      backoff: recovery.backoff,
      retryAfterSeconds,
    })
    logAgentMetric('provider_request_retry', {
      path: input.path,
      provider: input.provider,
      httpStatus: response.status,
      attempt: retryAttempts,
      maxAttempts: recovery.maxAttempts,
      delayMs,
    })
    await waitForAbortableRetryDelay(delayMs, input.signal)
  }
}
