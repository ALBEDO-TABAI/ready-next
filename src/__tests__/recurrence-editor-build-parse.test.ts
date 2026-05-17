/**
 * Behavior tests for the two pure helpers in `RecurrenceEditor.tsx` —
 * `buildRruleString` and `parseRruleStringToState`.
 *
 * These run in plain Node (no jsdom / no react) — the helpers are
 * deliberately separated from the React component so the round-trip
 * contract can be exercised without a renderer. This matches the
 * pattern used by `ReminderEditor.canonicalizeReminderList` and
 * `normalizeOffsetMinutes` in their L2-B test suite.
 *
 * The 6+ round-trip tests cover the structured frequencies
 * (DAILY / WEEKLY / MONTHLY / YEARLY) × end conditions (never / count
 * / until). The CUSTOM path is verified separately because it should
 * preserve the user's input verbatim.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRruleString,
  parseRruleStringToState,
  type RecurrenceState,
} from '../renderer/components/calendar/RecurrenceEditor'

// --- build → string tests ------------------------------------------------

test('buildRruleString returns null for freq=NONE', () => {
  const state: RecurrenceState = {
    freq: 'NONE',
    interval: 1,
    end: { kind: 'never' },
    customRule: '',
  }
  assert.equal(buildRruleString(state), null)
})

test('buildRruleString emits FREQ=DAILY with INTERVAL omitted when interval=1', () => {
  const state: RecurrenceState = {
    freq: 'DAILY',
    interval: 1,
    end: { kind: 'never' },
    customRule: '',
  }
  assert.equal(buildRruleString(state), 'FREQ=DAILY')
})

test('buildRruleString emits INTERVAL when > 1', () => {
  const state: RecurrenceState = {
    freq: 'WEEKLY',
    interval: 2,
    end: { kind: 'count', count: 10 },
    customRule: '',
  }
  assert.equal(buildRruleString(state), 'FREQ=WEEKLY;INTERVAL=2;COUNT=10')
})

test('buildRruleString emits UNTIL clause in RFC 5545 UTC basic format', () => {
  const state: RecurrenceState = {
    freq: 'MONTHLY',
    interval: 1,
    end: { kind: 'until', untilDate: '2026-12-31' },
    customRule: '',
  }
  assert.equal(buildRruleString(state), 'FREQ=MONTHLY;UNTIL=20261231T235959Z')
})

test('buildRruleString returns the verbatim custom rule', () => {
  const state: RecurrenceState = {
    freq: 'CUSTOM',
    interval: 1,
    end: { kind: 'never' },
    customRule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=15',
  }
  assert.equal(buildRruleString(state), 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=15')
})

test('buildRruleString returns null when custom rule is empty whitespace', () => {
  const state: RecurrenceState = {
    freq: 'CUSTOM',
    interval: 1,
    end: { kind: 'never' },
    customRule: '   \n  ',
  }
  assert.equal(buildRruleString(state), null)
})

// --- string → state tests ------------------------------------------------

test('parseRruleStringToState returns freq=NONE for null / empty input', () => {
  assert.deepEqual(parseRruleStringToState(null), {
    freq: 'NONE',
    interval: 1,
    end: { kind: 'never' },
    customRule: '',
  })
  assert.deepEqual(parseRruleStringToState(''), {
    freq: 'NONE',
    interval: 1,
    end: { kind: 'never' },
    customRule: '',
  })
})

test('parseRruleStringToState handles bare FREQ=DAILY with COUNT', () => {
  assert.deepEqual(parseRruleStringToState('FREQ=DAILY;COUNT=5'), {
    freq: 'DAILY',
    interval: 1,
    end: { kind: 'count', count: 5 },
    customRule: '',
  })
})

test('parseRruleStringToState strips RRULE: prefix', () => {
  assert.deepEqual(parseRruleStringToState('RRULE:FREQ=WEEKLY;INTERVAL=2'), {
    freq: 'WEEKLY',
    interval: 2,
    end: { kind: 'never' },
    customRule: '',
  })
})

test('parseRruleStringToState strips DTSTART line', () => {
  assert.deepEqual(parseRruleStringToState('DTSTART:20260517T090000Z\nRRULE:FREQ=DAILY;COUNT=7'), {
    freq: 'DAILY',
    interval: 1,
    end: { kind: 'count', count: 7 },
    customRule: '',
  })
})

test('parseRruleStringToState decodes UNTIL clause back to ISO date', () => {
  assert.deepEqual(parseRruleStringToState('FREQ=MONTHLY;UNTIL=20261231T235959Z'), {
    freq: 'MONTHLY',
    interval: 1,
    end: { kind: 'until', untilDate: '2026-12-31' },
    customRule: '',
  })
})

test('parseRruleStringToState flips to CUSTOM when unknown keys present (BYDAY)', () => {
  const out = parseRruleStringToState('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10')
  assert.equal(out.freq, 'CUSTOM')
  assert.equal(out.customRule, 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10')
  assert.deepEqual(out.end, { kind: 'never' })
})

test('parseRruleStringToState flips to CUSTOM for unsupported FREQ (HOURLY)', () => {
  const out = parseRruleStringToState('FREQ=HOURLY;COUNT=3')
  assert.equal(out.freq, 'CUSTOM')
  assert.equal(out.customRule, 'FREQ=HOURLY;COUNT=3')
})

// --- round-trip tests ---------------------------------------------------
// These verify state → string → state is the identity on structured
// rules. The 6 cases cover the 4 frequencies × {count, until, never}.

test('round-trip: DAILY + COUNT=10', () => {
  const seed: RecurrenceState = {
    freq: 'DAILY',
    interval: 1,
    end: { kind: 'count', count: 10 },
    customRule: '',
  }
  const out = parseRruleStringToState(buildRruleString(seed))
  assert.deepEqual(out, seed)
})

test('round-trip: WEEKLY + INTERVAL=2 + COUNT=15', () => {
  const seed: RecurrenceState = {
    freq: 'WEEKLY',
    interval: 2,
    end: { kind: 'count', count: 15 },
    customRule: '',
  }
  const out = parseRruleStringToState(buildRruleString(seed))
  assert.deepEqual(out, seed)
})

test('round-trip: MONTHLY + UNTIL=2026-12-31', () => {
  const seed: RecurrenceState = {
    freq: 'MONTHLY',
    interval: 1,
    end: { kind: 'until', untilDate: '2026-12-31' },
    customRule: '',
  }
  const out = parseRruleStringToState(buildRruleString(seed))
  assert.deepEqual(out, seed)
})

test('round-trip: YEARLY + never end', () => {
  const seed: RecurrenceState = {
    freq: 'YEARLY',
    interval: 1,
    end: { kind: 'never' },
    customRule: '',
  }
  const out = parseRruleStringToState(buildRruleString(seed))
  assert.deepEqual(out, seed)
})

test('round-trip: DAILY + INTERVAL=3 + never end', () => {
  const seed: RecurrenceState = {
    freq: 'DAILY',
    interval: 3,
    end: { kind: 'never' },
    customRule: '',
  }
  const out = parseRruleStringToState(buildRruleString(seed))
  assert.deepEqual(out, seed)
})

test('round-trip: WEEKLY + UNTIL=2027-01-15', () => {
  const seed: RecurrenceState = {
    freq: 'WEEKLY',
    interval: 1,
    end: { kind: 'until', untilDate: '2027-01-15' },
    customRule: '',
  }
  const out = parseRruleStringToState(buildRruleString(seed))
  assert.deepEqual(out, seed)
})

test('round-trip: CUSTOM rule preserves verbatim through parse', () => {
  // CUSTOM round-trip is "verbatim preservation" — we don't strictly
  // require the parse to land back on freq=CUSTOM (the parse rules
  // look at structural fields) but the rule body must round-trip via
  // buildRruleString once it's classified as CUSTOM.
  const seed: RecurrenceState = {
    freq: 'CUSTOM',
    interval: 1,
    end: { kind: 'never' },
    customRule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  }
  const emitted = buildRruleString(seed)
  assert.equal(emitted, 'FREQ=WEEKLY;BYDAY=MO,WE,FR')
  const parsed = parseRruleStringToState(emitted)
  // Parsing this back lands on CUSTOM because BYDAY is unknown.
  assert.equal(parsed.freq, 'CUSTOM')
  assert.equal(parsed.customRule, 'FREQ=WEEKLY;BYDAY=MO,WE,FR')
})

test('parseRruleStringToState clamps invalid INTERVAL to 1', () => {
  const out = parseRruleStringToState('FREQ=DAILY;INTERVAL=-3;COUNT=5')
  assert.equal(out.interval, 1)
  assert.equal(out.freq, 'DAILY')
  assert.deepEqual(out.end, { kind: 'count', count: 5 })
})

test('parseRruleStringToState ignores COUNT and UNTIL when both absent', () => {
  const out = parseRruleStringToState('FREQ=WEEKLY')
  assert.equal(out.freq, 'WEEKLY')
  assert.deepEqual(out.end, { kind: 'never' })
})
