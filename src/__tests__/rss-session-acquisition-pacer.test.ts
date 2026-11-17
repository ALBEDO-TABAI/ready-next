import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SESSION_MANUAL_ALL_FRESH_MS,
  SESSION_PACING,
  SESSION_USER_AWAY_AFTER_MS,
  SessionAcquisitionPacer,
  decideSessionLoad,
  sessionIntervalJitter,
  sessionRefreshIntervalMs,
  type SessionLoadOutcome,
  type SessionLoadRequest,
  type SessionPlatformStanding,
  type SessionPlatformState,
  type SessionRunRequest,
} from '../main/modules/rss-engine/session-acquisition-pacer'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = Date.UTC(2026, 10, 17, 12, 0, 0)

function freshState(overrides: Partial<SessionPlatformState> = {}): SessionPlatformState {
  return { recentLoadsAt: [], lastChallenge: null, lastSuccessAt: null, ...overrides }
}

function request(overrides: Partial<SessionLoadRequest> = {}): SessionLoadRequest {
  return {
    trigger: 'auto',
    platform: 'xiaohongshu',
    sourceId: 'source-1',
    sourceCount: 1,
    lastAttemptAt: null,
    userHasPageOpen: false,
    ...overrides,
  }
}

function decide(overrides: Partial<SessionLoadRequest> & { now?: number; userIdleMs?: number; state?: SessionPlatformState } = {}) {
  const { now = T0, userIdleMs = 0, state = freshState(), ...rest } = overrides
  return decideSessionLoad({ ...request(rest), now, userIdleMs, state })
}

describe('when a session source may open its page', () => {
  it('opens a source that has never been read', () => {
    assert.deepEqual(decide(), { load: true })
  })

  it('waits out the platform interval on an automatic refresh, with a fixed jitter per attempt', () => {
    const lastAttemptAt = T0 - 3 * HOUR
    const jitter = sessionIntervalJitter('source-1', lastAttemptAt)
    assert.ok(jitter >= 0.85 && jitter <= 1.15)
    assert.equal(jitter, sessionIntervalJitter('source-1', lastAttemptAt), 'the same attempt always gets the same jitter')

    const dueAt = lastAttemptAt + SESSION_PACING.xiaohongshu.baseIntervalMs * jitter
    const early = decide({ lastAttemptAt, now: dueAt - 1 })
    assert.deepEqual(early, { load: false, reason: 'not_due', retryAt: dueAt })
    assert.deepEqual(decide({ lastAttemptAt, now: dueAt }), { load: true })
  })

  it('stretches the interval as the person follows more sources on one platform', () => {
    assert.equal(sessionRefreshIntervalMs('xiaohongshu', 1), 4 * HOUR)
    assert.equal(sessionRefreshIntervalMs('xiaohongshu', 40), 40 * 15 * MINUTE)
    assert.equal(sessionRefreshIntervalMs('bilibili', 3), 2 * HOUR)
    assert.equal(sessionRefreshIntervalMs('bilibili', 60), 60 * 6 * MINUTE)
  })

  it('does not refresh on its own while nobody is at the computer', () => {
    assert.deepEqual(
      decide({ userIdleMs: SESSION_USER_AWAY_AFTER_MS }),
      { load: false, reason: 'user_away', retryAt: null },
    )
    assert.deepEqual(decide({ userIdleMs: Number.POSITIVE_INFINITY }).load, false)
    assert.deepEqual(decide({ userIdleMs: SESSION_USER_AWAY_AFTER_MS - 1 }), { load: true })
    assert.deepEqual(
      decide({ trigger: 'manual-all', userIdleMs: Number.POSITIVE_INFINITY }),
      { load: true },
      'a refresh the person asked for does not wait for the person',
    )
  })

  it('caps how many pages one platform opens inside its window', () => {
    const rule = SESSION_PACING.xiaohongshu
    const recentLoadsAt = [T0 - 40 * MINUTE, T0 - 20 * MINUTE, T0 - 5 * MINUTE]
    assert.equal(recentLoadsAt.length, rule.burst)
    const decision = decide({ state: freshState({ recentLoadsAt }) })
    assert.deepEqual(decision, {
      load: false,
      reason: 'load_budget',
      retryAt: recentLoadsAt[0] + rule.loadGapMs * rule.burst,
    })
    assert.deepEqual(
      decide({ state: freshState({ recentLoadsAt }), now: recentLoadsAt[0] + rule.loadGapMs * rule.burst }),
      { load: true },
      'the oldest load leaving the window frees one slot',
    )
    assert.deepEqual(
      decide({ trigger: 'manual-source', state: freshState({ recentLoadsAt }) }),
      { load: true },
      'refreshing one source by hand is never held back by the budget',
    )
  })

  it('"refresh everything" does not reopen a page that was just opened', () => {
    assert.deepEqual(
      decide({ trigger: 'manual-all', lastAttemptAt: T0 - MINUTE }),
      { load: false, reason: 'just_refreshed', retryAt: T0 - MINUTE + SESSION_MANUAL_ALL_FRESH_MS },
    )
    assert.deepEqual(decide({ trigger: 'manual-all', lastAttemptAt: T0 - SESSION_MANUAL_ALL_FRESH_MS }), { load: true })
    assert.deepEqual(decide({ trigger: 'manual-source', lastAttemptAt: T0 - MINUTE }), { load: true })
  })
})

describe('after a sign-in page or a verification page', () => {
  const signIn = (at: number) => freshState({ lastChallenge: { kind: 'auth', at } })
  const verification = (at: number) => freshState({ lastChallenge: { kind: 'anti_bot', at } })

  it('keeps automatic refresh off for the pause, then tries again', () => {
    const rule = SESSION_PACING.xiaohongshu
    assert.deepEqual(
      decide({ state: signIn(T0 - HOUR) }),
      { load: false, reason: 'platform_paused', retryAt: T0 - HOUR + rule.authPauseMs },
    )
    assert.deepEqual(decide({ state: signIn(T0 - rule.authPauseMs) }), { load: true })
    assert.deepEqual(
      decide({ state: verification(T0 - HOUR) }),
      { load: false, reason: 'platform_paused', retryAt: T0 - HOUR + rule.challengePauseMs },
    )
    assert.deepEqual(decide({ state: verification(T0 - rule.challengePauseMs) }), { load: true })
  })

  it('a later success lifts the pause', () => {
    const state = freshState({ lastChallenge: { kind: 'waf', at: T0 - HOUR }, lastSuccessAt: T0 - 30 * MINUTE })
    assert.deepEqual(decide({ state }), { load: true })
  })

  it('lets the person find out whether signing in worked', () => {
    assert.deepEqual(decide({ trigger: 'manual-source', state: signIn(T0 - MINUTE) }), { load: true })
    assert.equal(
      decide({ trigger: 'manual-all', state: signIn(T0 - MINUTE) }).load,
      false,
      'a sign-in page met a minute ago belongs to the same round: the sources behind it stay closed',
    )
    assert.deepEqual(decide({ trigger: 'manual-all', state: signIn(T0 - SESSION_MANUAL_ALL_FRESH_MS) }), { load: true })
  })

  it('after a verification page only a person with the page open may try again', () => {
    assert.equal(decide({ trigger: 'manual-source', state: verification(T0 - MINUTE) }).load, false)
    assert.equal(decide({ trigger: 'manual-all', state: verification(T0 - HOUR) }).load, false)
    assert.deepEqual(
      decide({ trigger: 'manual-source', state: verification(T0 - MINUTE), userHasPageOpen: true }),
      { load: true },
    )
    assert.equal(
      decide({ trigger: 'auto', state: verification(T0 - MINUTE), userHasPageOpen: true }).load,
      false,
      'an open tab does not restart automatic refresh',
    )
  })
})

function createPacer(options: { idleMs?: () => number; persisted?: Partial<SessionPlatformState> } = {}) {
  let now = T0
  const sleeps: number[] = []
  const saved: Array<[string, SessionPlatformStanding]> = []
  const pacer = new SessionAcquisitionPacer({
    now: () => now,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); now += ms },
    readUserIdleMs: options.idleMs ?? (() => 0),
    readPersistedState: () => ({
      lastChallenge: options.persisted?.lastChallenge ?? null,
      lastSuccessAt: options.persisted?.lastSuccessAt ?? null,
    }),
    persistState: (platform, standing) => { saved.push([platform, standing]) },
  })
  return {
    pacer,
    sleeps,
    saved,
    advance: (ms: number) => { now += ms },
    now: () => now,
  }
}

/** A queued request reads its facts when it reaches the front; here they are fixed unless a test says otherwise. */
function queued(overrides: Partial<SessionLoadRequest> & { readLastAttemptAt?: () => number | null } = {}): SessionRunRequest {
  const { lastAttemptAt = null, userHasPageOpen = false, readLastAttemptAt, ignorePause: _ignorePause, ...rest } = overrides
  return {
    trigger: 'auto',
    platform: 'xiaohongshu',
    sourceId: 'source-1',
    sourceCount: 1,
    ...rest,
    readLastAttemptAt: readLastAttemptAt ?? (() => lastAttemptAt),
    readUserHasPageOpen: () => userHasPageOpen,
  }
}

function load(outcome: SessionLoadOutcome, onStart?: () => void, takes = 0, clock?: { advance(ms: number): void }) {
  return async () => {
    onStart?.()
    if (takes > 0) clock?.advance(takes)
    return { value: outcome, outcome }
  }
}

describe('the session queue', () => {
  it('opens one page at a time across platforms and leaves a pause between pages of one platform', async () => {
    const clock = createPacer()
    const order: string[] = []
    let open = 0
    let maxOpen = 0
    const track = (label: string) => async () => {
      open += 1
      maxOpen = Math.max(maxOpen, open)
      order.push(label)
      await Promise.resolve()
      clock.advance(2_000)
      open -= 1
      return { value: label, outcome: 'ok' as const }
    }

    const results = await Promise.all([
      clock.pacer.run(queued({ platform: 'bilibili', sourceId: 'b1' }), track('b1')),
      clock.pacer.run(queued({ platform: 'xiaohongshu', sourceId: 'x1' }), track('x1')),
      clock.pacer.run(queued({ platform: 'bilibili', sourceId: 'b2' }), track('b2')),
    ])

    assert.deepEqual(order, ['b1', 'x1', 'b2'])
    assert.equal(maxOpen, 1)
    assert.ok(results.every((result) => result.ran))
    const [min, max] = SESSION_PACING.bilibili.spacingMs
    // b2 follows b1 on the same platform: the middle of the spacing range, less the 2 s x1 already took.
    assert.deepEqual(clock.sleeps, [min + 0.5 * (max - min) - 2_000])
  })

  it('keeps a shorter pause between pages when the person asked for the refresh and is waiting', async () => {
    const clock = createPacer()
    await clock.pacer.run(queued({ platform: 'bilibili', sourceId: 'b1', trigger: 'manual-all' }), load('ok'))
    await clock.pacer.run(queued({ platform: 'bilibili', sourceId: 'b2', trigger: 'manual-all' }), load('ok'))
    const [min, max] = SESSION_PACING.bilibili.manualSpacingMs
    assert.deepEqual(clock.sleeps, [min + 0.5 * (max - min)])
    assert.ok(max <= SESSION_PACING.bilibili.spacingMs[0], 'never longer than the shortest automatic pause')
  })

  it('does not open a source again that was opened while the request waited in the queue', async () => {
    const clock = createPacer()
    let opened = 0
    // Both were queued before either ran, as when a refresh by hand overlaps an automatic round.
    const byHand = clock.pacer.run(queued({ sourceId: 'x1', trigger: 'manual-source' }), load('ok', () => { opened += 1 }))
    const automatic = clock.pacer.run(queued({ sourceId: 'x1', trigger: 'auto' }), load('ok', () => { opened += 1 }))
    assert.equal((await byHand).ran, true)
    assert.deepEqual((await automatic).ran, false)
    assert.equal(opened, 1)
  })

  it('reads the last recorded attempt when the request reaches the front, not when it was queued', async () => {
    const clock = createPacer()
    let recorded: number | null = null
    const first = clock.pacer.run(queued({ sourceId: 'x-a' }), async () => {
      recorded = clock.now() // another path records an attempt for x-b while x-a's page is open
      return { value: 'a', outcome: 'ok' as const }
    })
    const second = clock.pacer.run(queued({ sourceId: 'x-b', readLastAttemptAt: () => recorded }), load('ok'))
    await first
    assert.deepEqual((await second).ran, false)
  })

  it('saves a platform standing whenever it changes, and nothing for a page that merely showed nothing', async () => {
    const clock = createPacer()
    await clock.pacer.run(queued({ sourceId: 'x1' }), load('other'))
    assert.deepEqual(clock.saved, [])
    await clock.pacer.run(queued({ sourceId: 'x2' }), load('ok'))
    await clock.pacer.run(queued({ sourceId: 'x3', trigger: 'manual-source' }), load('anti_bot'))
    assert.deepEqual(clock.saved.map(([platform, standing]) => [platform, standing.lastChallenge?.kind ?? null, standing.lastSuccessAt !== null]), [
      ['xiaohongshu', null, true],
      ['xiaohongshu', 'anti_bot', true],
    ])
  })

  it('a route that does not open the page keeps the pace but ignores a sign-in pause', async () => {
    const clock = createPacer({ persisted: { lastChallenge: { kind: 'auth', at: T0 - HOUR } } })
    const anonymous = load('other')
    const paused = await clock.pacer.run(queued({ platform: 'bilibili', sourceId: 'b1' }), anonymous)
    assert.equal(paused.ran, false)

    const allowed = await clock.pacer.run(queued({ platform: 'bilibili', sourceId: 'b1' }), anonymous, { ignorePause: true })
    assert.equal(allowed.ran, true)

    const again = await clock.pacer.run(queued({ platform: 'bilibili', sourceId: 'b1' }), anonymous, { ignorePause: true })
    assert.deepEqual(again.ran, false, 'not again before the source is due')
    assert.equal(again.ran === false && again.reason, 'not_due')

    const away = createPacer({ persisted: { lastChallenge: { kind: 'auth', at: T0 - HOUR } }, idleMs: () => HOUR })
    const whileAway = await away.pacer.run(queued({ platform: 'bilibili', sourceId: 'b1' }), anonymous, { ignorePause: true })
    assert.equal(whileAway.ran === false && whileAway.reason, 'user_away')
    assert.deepEqual(clock.pacer.snapshot('bilibili').lastChallenge, { kind: 'auth', at: T0 - HOUR }, 'the pause itself is untouched')
  })

  it('runs other work in the same single file', async () => {
    const clock = createPacer()
    const order: string[] = []
    const page = clock.pacer.run(queued({ sourceId: 'x1' }), async () => {
      order.push('page:start')
      await Promise.resolve()
      order.push('page:end')
      return { value: 1, outcome: 'ok' as const }
    })
    const other = clock.pacer.serialize(async () => { order.push('other'); return 2 })
    assert.deepEqual(await Promise.all([page, other]), [{ ran: true, value: 1 }, 2])
    assert.deepEqual(order, ['page:start', 'page:end', 'other'])
  })

  it('stops the sources behind a sign-in page in the same round without opening their pages', async () => {
    const clock = createPacer()
    let opened = 0
    const first = clock.pacer.run(queued({ sourceId: 'x1' }), load('auth', () => { opened += 1 }))
    const second = clock.pacer.run(queued({ sourceId: 'x2' }), load('ok', () => { opened += 1 }))
    const third = clock.pacer.run(queued({ sourceId: 'x3', trigger: 'manual-all' }), load('ok', () => { opened += 1 }))

    assert.equal((await first).ran, true)
    assert.deepEqual(await second, {
      ran: false,
      reason: 'platform_paused',
      retryAt: T0 + SESSION_PACING.xiaohongshu.authPauseMs,
    })
    assert.equal((await third).ran, false)
    assert.equal(opened, 1)
  })

  it('counts every opened page against the budget, whatever it showed', async () => {
    const clock = createPacer()
    const rule = SESSION_PACING.xiaohongshu
    const outcomes: boolean[] = []
    for (let index = 0; index < rule.burst + 1; index += 1) {
      const result = await clock.pacer.run(queued({ sourceId: `x${index}` }), load('other'))
      outcomes.push(result.ran)
    }
    assert.deepEqual(outcomes, [...Array(rule.burst).fill(true), false])
    assert.equal(clock.pacer.snapshot('xiaohongshu').recentLoadsAt.length, rule.burst)
  })

  it('remembers a pause across a restart from what was recorded', async () => {
    const clock = createPacer({ persisted: { lastChallenge: { kind: 'waf', at: T0 - HOUR } } })
    let opened = 0
    const result = await clock.pacer.run(queued(), load('ok', () => { opened += 1 }))
    assert.equal(result.ran, false)
    assert.equal(opened, 0)
  })

  it('keeps serving after a page load throws', async () => {
    const clock = createPacer()
    await assert.rejects(
      clock.pacer.run(queued({ sourceId: 'x1' }), async () => { throw new Error('window crashed') }),
      /window crashed/,
    )
    const next = await clock.pacer.run(queued({ sourceId: 'x2' }), load('ok'))
    assert.equal(next.ran, true)
  })
})
