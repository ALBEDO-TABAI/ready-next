/**
 * EP2-T4-3 — graded retry policy for outbound tool HTTP calls.
 *
 * Classes:
 *  - no_retry:     auth (401/403) and argument-class 4xx — retrying repeats
 *                  the same mistake; surface immediately.
 *  - rate_limited: 429 — respect Retry-After (seconds form, capped), at most
 *                  two retries.
 *  - transient:    5xx and network failures — exponential backoff, at most
 *                  two retries.
 *
 * Domains migrate explicitly (first batch: general_research builtins).
 * Unmigrated domains keep raw fetch — the policy must never be a global
 * monkey-patch.
 */

export type RetryClass = 'no_retry' | 'rate_limited' | 'transient'

export const DEFAULT_MAX_RETRIES = 2
const DEFAULT_BASE_BACKOFF_MS = 500
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000

export function classifyHttpStatusForRetry(status: number): RetryClass {
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'transient'
  return 'no_retry'
}

export interface RetryPolicyOptions {
  maxRetries?: number
  /** Injectable for tests; defaults to real timer sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  baseBackoffMs?: number
  maxRetryAfterMs?: number
}

function backoffMs(attempt: number, base: number): number {
  return base * 2 ** attempt
}

function retryAfterMs(response: Response, cap: number): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, cap)
}

export async function fetchWithRetryPolicy(
  input: string | URL,
  init?: RequestInit,
  opts: RetryPolicyOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const base = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
  const retryAfterCap = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS

  let attempt = 0
  for (;;) {
    let response: Response
    try {
      response = await doFetch(input, init)
    } catch (error) {
      // Abort is the caller's decision — never retried. Other rejections are
      // network-class transient failures.
      if ((error as Error | null)?.name === 'AbortError' || init?.signal?.aborted) throw error
      if (attempt >= maxRetries) throw error
      await sleep(backoffMs(attempt, base))
      attempt += 1
      continue
    }
    const klass = classifyHttpStatusForRetry(response.status)
    if (klass === 'no_retry' || attempt >= maxRetries) return response
    if (klass === 'rate_limited') {
      await sleep(retryAfterMs(response, retryAfterCap) ?? backoffMs(attempt, base))
    } else {
      await sleep(backoffMs(attempt, base))
    }
    attempt += 1
  }
}
