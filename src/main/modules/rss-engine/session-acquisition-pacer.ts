/**
 * When a subscription that needs the person's own login may open its page.
 *
 * The aim is that the platform sees what it would see if the person opened these pages themselves: one page at a
 * time, a pause between pages, a few times a day, only while someone is at the computer, and never again right
 * after a sign-in page or a verification page. Everything here is plain arithmetic over an injected clock.
 */
import { createHash } from 'crypto'

export type SessionPlatform = 'bilibili' | 'xiaohongshu' | 'weibo' | 'douyin'

/** `auto`: the scheduler. `manual-all`: the person asked to refresh everything. `manual-source`: one source. */
export type SessionRefreshTrigger = 'auto' | 'manual-all' | 'manual-source'

export type SessionChallengeKind = 'auth' | 'anti_bot' | 'waf'

export type SessionLoadOutcome = 'ok' | SessionChallengeKind | 'other'

export type SessionSkipReason =
  | 'not_due'
  | 'just_refreshed'
  | 'user_away'
  | 'platform_paused'
  | 'load_budget'

export interface SessionPacingRule {
  /** Shortest time between two automatic refreshes of one source. */
  baseIntervalMs: number
  /** Average time the platform is left alone between two page loads; stretches the interval as sources grow. */
  loadGapMs: number
  /** Page loads allowed inside `loadGapMs * burst`. */
  burst: number
  /** Pause between two consecutive page loads on the platform, picked at random inside this range. */
  spacingMs: readonly [number, number]
  /** How long automatic refresh stays off after a sign-in page. */
  authPauseMs: number
  /** How long automatic refresh stays off after a verification or risk page. */
  challengePauseMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const SESSION_PACING: Readonly<Record<SessionPlatform, SessionPacingRule>> = {
  bilibili: { baseIntervalMs: 2 * HOUR, loadGapMs: 6 * MINUTE, burst: 4, spacingMs: [8_000, 25_000], authPauseMs: 12 * HOUR, challengePauseMs: 6 * HOUR },
  weibo: { baseIntervalMs: 2 * HOUR, loadGapMs: 6 * MINUTE, burst: 4, spacingMs: [8_000, 25_000], authPauseMs: 12 * HOUR, challengePauseMs: 6 * HOUR },
  douyin: { baseIntervalMs: 3 * HOUR, loadGapMs: 10 * MINUTE, burst: 3, spacingMs: [10_000, 30_000], authPauseMs: 12 * HOUR, challengePauseMs: 6 * HOUR },
  xiaohongshu: { baseIntervalMs: 4 * HOUR, loadGapMs: 15 * MINUTE, burst: 3, spacingMs: [15_000, 45_000], authPauseMs: 12 * HOUR, challengePauseMs: 6 * HOUR },
}

/** Automatic session loads wait for the person once the computer has been idle this long (or is locked). */
export const SESSION_USER_AWAY_AFTER_MS = 10 * MINUTE

/** "Refresh everything" does not reopen a page that was opened this recently. */
export const SESSION_MANUAL_ALL_FRESH_MS = 10 * MINUTE

export function isSessionPlatform(platform: string): platform is SessionPlatform {
  return Object.prototype.hasOwnProperty.call(SESSION_PACING, platform)
}

export interface SessionPlatformState {
  recentLoadsAt: number[]
  lastChallenge: { kind: SessionChallengeKind; at: number } | null
  lastSuccessAt: number | null
}

export interface SessionLoadRequest {
  trigger: SessionRefreshTrigger
  platform: SessionPlatform
  sourceId: string
  /** How many enabled sources the person has on this platform. */
  sourceCount: number
  /** The last time this source's page was opened, whatever the result. */
  lastAttemptAt: number | null
  /** The person has this very page open in a tab right now. */
  userHasPageOpen: boolean
}

export type SessionLoadDecision =
  | { load: true }
  | { load: false; reason: SessionSkipReason; retryAt: number | null }

/** A fixed share between 0.85 and 1.15 per source and attempt, so refreshes do not line up on the clock. */
export function sessionIntervalJitter(sourceId: string, lastAttemptAt: number): number {
  const digest = createHash('sha256').update(`${sourceId}:${lastAttemptAt}`).digest()
  return 0.85 + (digest.readUInt16BE(0) / 0xffff) * 0.3
}

export function sessionRefreshIntervalMs(platform: SessionPlatform, sourceCount: number): number {
  const rule = SESSION_PACING[platform]
  return Math.max(rule.baseIntervalMs, Math.max(1, sourceCount) * rule.loadGapMs)
}

export function sessionPausedUntil(platform: SessionPlatform, state: SessionPlatformState): number | null {
  const challenge = state.lastChallenge
  if (!challenge) return null
  if (state.lastSuccessAt !== null && state.lastSuccessAt >= challenge.at) return null
  const rule = SESSION_PACING[platform]
  return challenge.at + (challenge.kind === 'auth' ? rule.authPauseMs : rule.challengePauseMs)
}

export function decideSessionLoad(input: SessionLoadRequest & {
  now: number
  userIdleMs: number
  state: SessionPlatformState
}): SessionLoadDecision {
  const rule = SESSION_PACING[input.platform]
  const pausedUntil = sessionPausedUntil(input.platform, input.state)
  const paused = pausedUntil !== null && input.now < pausedUntil
  const challengeKind = input.state.lastChallenge?.kind

  if (paused) {
    // A sign-in page may have been dealt with since, so a refresh the person asked for may find out: one source
    // at any time, "refresh everything" once the last sign-in page is no longer part of the same round.
    // After a verification page only a person who has the page open in front of them may try again.
    const challengeAt = input.state.lastChallenge?.at ?? input.now
    const personMayRetry = input.trigger === 'manual-source'
      ? challengeKind === 'auth' || input.userHasPageOpen
      : input.trigger === 'manual-all'
        ? input.userHasPageOpen
          || (challengeKind === 'auth' && input.now - challengeAt >= SESSION_MANUAL_ALL_FRESH_MS)
        : false
    if (!personMayRetry) return { load: false, reason: 'platform_paused', retryAt: pausedUntil }
  }

  if (input.trigger === 'manual-source') return { load: true }

  if (input.trigger === 'auto') {
    if (input.userIdleMs >= SESSION_USER_AWAY_AFTER_MS) return { load: false, reason: 'user_away', retryAt: null }
    if (input.lastAttemptAt !== null) {
      const interval = sessionRefreshIntervalMs(input.platform, input.sourceCount)
        * sessionIntervalJitter(input.sourceId, input.lastAttemptAt)
      const dueAt = input.lastAttemptAt + interval
      if (input.now < dueAt) return { load: false, reason: 'not_due', retryAt: dueAt }
    }
  } else if (input.lastAttemptAt !== null && input.now - input.lastAttemptAt < SESSION_MANUAL_ALL_FRESH_MS) {
    return { load: false, reason: 'just_refreshed', retryAt: input.lastAttemptAt + SESSION_MANUAL_ALL_FRESH_MS }
  }

  const windowMs = rule.loadGapMs * rule.burst
  const recent = input.state.recentLoadsAt.filter((at) => input.now - at < windowMs)
  if (recent.length >= rule.burst) {
    return { load: false, reason: 'load_budget', retryAt: Math.min(...recent) + windowMs }
  }
  return { load: true }
}

export interface SessionAcquisitionPacerDeps {
  now(): number
  /** A number in [0, 1). */
  random(): number
  sleep(ms: number): Promise<void>
  /** How long since the person last touched the computer; a locked screen counts as away. */
  readUserIdleMs(): number
  /** What the last recorded attempts say about the platform, used once after a restart. */
  readPersistedState?(platform: SessionPlatform): Pick<SessionPlatformState, 'lastChallenge' | 'lastSuccessAt'> | null
}

export type SessionRunResult<T> =
  | { ran: true; value: T }
  | { ran: false; reason: SessionSkipReason; retryAt: number | null }

/**
 * One queue for the whole app: at most one session page is open at any moment. A request is decided when it
 * reaches the front, so a sign-in or verification page met earlier in the same round stops the ones behind it.
 */
export class SessionAcquisitionPacer {
  private readonly states = new Map<SessionPlatform, SessionPlatformState>()
  private readonly lastLoadFinishedAt = new Map<SessionPlatform, number>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: SessionAcquisitionPacerDeps) {}

  run<T>(
    request: SessionLoadRequest,
    load: () => Promise<{ value: T; outcome: SessionLoadOutcome }>,
  ): Promise<SessionRunResult<T>> {
    const task = this.tail.then(async (): Promise<SessionRunResult<T>> => {
      const state = this.stateOf(request.platform)
      const decision = decideSessionLoad({
        ...request,
        now: this.deps.now(),
        userIdleMs: this.deps.readUserIdleMs(),
        state,
      })
      if (!decision.load) return { ran: false, reason: decision.reason, retryAt: decision.retryAt }

      const rule = SESSION_PACING[request.platform]
      const previous = this.lastLoadFinishedAt.get(request.platform)
      if (previous !== undefined) {
        const spacing = rule.spacingMs[0] + this.deps.random() * (rule.spacingMs[1] - rule.spacingMs[0])
        const wait = previous + spacing - this.deps.now()
        if (wait > 0) await this.deps.sleep(wait)
      }

      const startedAt = this.deps.now()
      const windowMs = rule.loadGapMs * rule.burst
      state.recentLoadsAt = [...state.recentLoadsAt.filter((at) => startedAt - at < windowMs), startedAt]
      try {
        const { value, outcome } = await load()
        const finishedAt = this.deps.now()
        if (outcome === 'ok') state.lastSuccessAt = finishedAt
        else if (outcome !== 'other') state.lastChallenge = { kind: outcome, at: finishedAt }
        return { ran: true, value }
      } finally {
        this.lastLoadFinishedAt.set(request.platform, this.deps.now())
      }
    })
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  snapshot(platform: SessionPlatform): SessionPlatformState {
    const state = this.stateOf(platform)
    return { ...state, recentLoadsAt: [...state.recentLoadsAt] }
  }

  private stateOf(platform: SessionPlatform): SessionPlatformState {
    let state = this.states.get(platform)
    if (!state) {
      const persisted = this.deps.readPersistedState?.(platform) ?? null
      state = {
        recentLoadsAt: [],
        lastChallenge: persisted?.lastChallenge ?? null,
        lastSuccessAt: persisted?.lastSuccessAt ?? null,
      }
      this.states.set(platform, state)
    }
    return state
  }
}
