export interface OriginInteractionSignal {
  status?: number | null
  retryAfter?: string | number | null
  challenge?: boolean
  loginWall?: boolean
  challengeCleared?: boolean
  actionSucceeded?: boolean
}

export interface OriginInteractionState {
  origin: string
  cooldownUntil: number
  challengeBlocked: boolean
  consecutiveFailures: number
  lastSignalAt: number
}

export type OriginInteractionResult =
  | { ok: true }
  | { ok: false; errorCode: 'origin_challenge_blocked' | 'origin_budget_aborted'; retryAt?: number }

function normalizedOrigin(value: string | null | undefined): string {
  const raw = String(value || '').trim()
  if (!raw) return 'browser://unknown'
  try { return new URL(raw).origin } catch { return raw }
}

export function scopedOriginInteractionKey(input: {
  profile?: string | null
  scopeId?: string | null
  origin: string
}): string {
  return `profile=${String(input.profile || 'default')};scope=${String(input.scopeId || 'unscoped')};origin=${normalizedOrigin(input.origin)}`
}

function retryAfterMs(value: string | number | null | undefined, now: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value * 1000)
  const text = String(value || '').trim()
  if (!text) return 0
  const seconds = Number(text)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const absolute = Date.parse(text)
  return Number.isFinite(absolute) ? Math.max(0, absolute - now) : 0
}

function waitUntil(deadline: number, now: () => number, signal?: AbortSignal): Promise<boolean> {
  const delay = Math.max(0, deadline - now())
  if (delay <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(true)
    }, delay)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      resolve(false)
    }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Serializes writes per origin and reacts to server/page feedback. It never
 * sleeps because of a domain name: cooldowns only come from Retry-After,
 * repeated failures, or an observed challenge.
 */
export class OriginInteractionBudget {
  private readonly states = new Map<string, OriginInteractionState>()
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  getState(urlOrOrigin: string): OriginInteractionState {
    const origin = normalizedOrigin(urlOrOrigin)
    const existing = this.states.get(origin)
    if (existing) return { ...existing }
    return { origin, cooldownUntil: 0, challengeBlocked: false, consecutiveFailures: 0, lastSignalAt: 0 }
  }

  record(urlOrOrigin: string, signal: OriginInteractionSignal): OriginInteractionState {
    const origin = normalizedOrigin(urlOrOrigin)
    const now = this.now()
    const current = this.getState(origin)
    const rateLimited = signal.status === 429
    const authoritativeRejection = typeof signal.status === 'number'
      && (signal.status === 403 || signal.status >= 500)
    const failed = rateLimited
      || authoritativeRejection
      || signal.challenge === true
      || signal.loginWall === true
    const retryMs = retryAfterMs(signal.retryAfter, now)
    const failures = failed ? current.consecutiveFailures + 1 : 0
    const adaptiveCooldown = rateLimited
      ? Math.max(retryMs, Math.min(120_000, 1_000 * (2 ** Math.min(6, failures))))
      : failed && failures >= 2
        ? Math.min(15_000, 500 * (2 ** Math.min(5, failures - 2)))
        : 0
    const activeCurrentCooldown = current.cooldownUntil > now ? current.cooldownUntil : 0
    const next: OriginInteractionState = {
      origin,
      cooldownUntil: adaptiveCooldown > 0
        ? Math.max(activeCurrentCooldown, now + adaptiveCooldown)
        : activeCurrentCooldown,
      challengeBlocked: signal.challengeCleared === true
        ? false
        : current.challengeBlocked || signal.challenge === true || signal.loginWall === true,
      consecutiveFailures: failures,
      lastSignalAt: now,
    }
    this.states.set(origin, next)
    return { ...next }
  }

  clearChallenge(urlOrOrigin: string): void {
    const origin = normalizedOrigin(urlOrOrigin)
    const current = this.getState(origin)
    this.states.set(origin, {
      ...current,
      challengeBlocked: false,
      consecutiveFailures: 0,
      cooldownUntil: Math.min(current.cooldownUntil, this.now()),
      lastSignalAt: this.now(),
    })
  }

  resetForTests(): void {
    this.states.clear()
    this.tails.clear()
  }

  async runWrite<T>(
    urlOrOrigin: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ gate: OriginInteractionResult; value?: T }> {
    const origin = normalizedOrigin(urlOrOrigin)
    const previous = this.tails.get(origin) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(origin, tail)
    await previous
    try {
      if (signal?.aborted) return { gate: { ok: false, errorCode: 'origin_budget_aborted' } }
      const state = this.getState(origin)
      if (state.challengeBlocked) {
        return { gate: { ok: false, errorCode: 'origin_challenge_blocked', retryAt: state.cooldownUntil || undefined } }
      }
      if (!(await waitUntil(state.cooldownUntil, this.now, signal))) {
        return { gate: { ok: false, errorCode: 'origin_budget_aborted' } }
      }
      return { gate: { ok: true }, value: await action() }
    } finally {
      release()
      if (this.tails.get(origin) === tail) this.tails.delete(origin)
    }
  }
}

export const browserOriginInteractionBudget = new OriginInteractionBudget()
