import type { SkillChildCloseEvent } from './skill-child-run-types'

export const CHILD_RUN_CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000
export const CHILD_RUN_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5
export const CHILD_RUN_CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000

export type ChildRunCircuitBreakerCheck =
  | { allowed: true }
  | {
      allowed: false
      reason: 'cooldown'
      cooldownUntil: number
      remainingMs: number
    }

export interface ChildRunCircuitBreakerOptions {
  windowMs?: number
  failureThreshold?: number
  cooldownMs?: number
  enabled?: boolean
  now?: () => number
}

interface BreakerBucket {
  failures: number[]
  cooldownUntil: number
}

export class ChildRunCircuitBreaker {
  private readonly windowMs: number
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly enabled: boolean
  private readonly now: () => number
  private readonly buckets = new Map<string, BreakerBucket>()

  constructor(options: ChildRunCircuitBreakerOptions = {}) {
    this.windowMs = normalizePositive(options.windowMs, CHILD_RUN_CIRCUIT_BREAKER_WINDOW_MS)
    this.failureThreshold = Math.max(
      1,
      Math.floor(normalizePositive(
        options.failureThreshold,
        CHILD_RUN_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      )),
    )
    this.cooldownMs = normalizePositive(options.cooldownMs, CHILD_RUN_CIRCUIT_BREAKER_COOLDOWN_MS)
    this.enabled = options.enabled ?? true
    this.now = options.now ?? Date.now
  }

  check(key: string): ChildRunCircuitBreakerCheck {
    if (!this.enabled) return { allowed: true }
    const bucket = this.buckets.get(key)
    if (!bucket) return { allowed: true }

    const now = this.now()
    if (bucket.cooldownUntil > now) {
      return {
        allowed: false,
        reason: 'cooldown',
        cooldownUntil: bucket.cooldownUntil,
        remainingMs: bucket.cooldownUntil - now,
      }
    }
    if (bucket.cooldownUntil > 0) {
      this.buckets.delete(key)
    }
    return { allowed: true }
  }

  recordFailure(key: string): { opened: boolean; cooldownUntil: number | null } {
    if (!this.enabled) return { opened: false, cooldownUntil: null }
    const now = this.now()
    const cutoff = now - this.windowMs
    const bucket = this.buckets.get(key) ?? { failures: [], cooldownUntil: 0 }
    bucket.failures = bucket.failures.filter((at) => at >= cutoff)
    bucket.failures.push(now)

    if (bucket.failures.length >= this.failureThreshold) {
      bucket.cooldownUntil = now + this.cooldownMs
      bucket.failures = []
      this.buckets.set(key, bucket)
      return { opened: true, cooldownUntil: bucket.cooldownUntil }
    }

    this.buckets.set(key, bucket)
    return { opened: false, cooldownUntil: null }
  }
}

export function shouldCountChildRunCircuitBreakerFailure(close: SkillChildCloseEvent): boolean {
  return close.status === 'failed'
}

export function isChildRunCircuitBreakerEnabled(value: string | undefined): boolean {
  if (value === undefined) return true
  const normalized = value.trim().toLowerCase()
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off'
}

function normalizePositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return value
}
