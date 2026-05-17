/**
 * Stage S W8.2 — LLM error retry helper.
 *
 * Source: deer-flow agents/middlewares/llm_error_handling_middleware.py
 * Wraps an LLM call with retry + exponential backoff for the canonical
 * transient HTTP statuses (408/409/425/429/5xx) and "server busy"
 * message patterns. Non-retryable errors bubble out immediately.
 */

import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'
import { ToolDomainError } from '../tools/tool-errors'

export const RETRY_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504] as const
export type RetryStatusCode = typeof RETRY_STATUS_CODES[number]

export const RETRY_BUSY_PATTERNS: RegExp[] = [
  /server.*busy/i,
  /try.*again.*later/i,
  /rate.?limit/i,
  /overloaded/i,
]

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface ProviderErrorClassification {
  errorKind: 'provider_thinking_echo_required'
  metricName: string
  recoverable: false
  message: string
}

export function isRetryableStatus(status: number | null | undefined): boolean {
  if (status == null) return false
  return (RETRY_STATUS_CODES as readonly number[]).includes(status)
}

export function isRetryableMessage(message: string | null | undefined): boolean {
  if (!message) return false
  return RETRY_BUSY_PATTERNS.some((p) => p.test(message))
}

export function isRetryableError(error: unknown): boolean {
  if (!error) return false
  const e = error as { status?: number; message?: string }
  if (isRetryableStatus(e.status)) return true
  if (isRetryableMessage(e.message)) return true
  return false
}

function readStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const rawStatus = (error as { status?: unknown }).status
  if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) return rawStatus
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return null
  const match = message.match(/\bHTTP\s+(\d{3})\b/i)
  return match ? Number(match[1]) : null
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '')
}

export function classifyProviderError(error: unknown): ProviderErrorClassification | null {
  const status = readStatus(error)
  if (status !== 400) return null
  const message = readMessage(error)
  if (!/(thinking|reasoning_content|extended thinking|thought_signature)/i.test(message)) {
    return null
  }
  return {
    errorKind: 'provider_thinking_echo_required',
    metricName: TOOL_ERROR_METRICS.providerThinkingEchoRequired400,
    recoverable: false,
    message: '当前供应商要求多轮回传 thinking 内容，但本地请求未能满足。请关闭思考模式或切换到已验证的供应商。',
  }
}

export async function withRetryBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 500
  const maxDelayMs = opts.maxDelayMs ?? 8000
  let lastError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const providerClassification = classifyProviderError(err)
      if (providerClassification) {
        logAgentMetric(providerClassification.metricName, {
          status: readStatus(err),
          errorMessage: readMessage(err).slice(0, 300),
        })
        throw new ToolDomainError('provider_request_failed', providerClassification.message, {
          providerErrorKind: providerClassification.errorKind,
          recoverable: false,
        })
      }
      if (!isRetryableError(err)) throw err
      if (attempt === maxAttempts - 1) throw err
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastError
}
