/**
 * Behavior tests for `reminder-codec.ts`.
 *
 * Verifies the JSON encode/decode + zod validation boundary used by the DB
 * layer. These are pure (no electron / sqlite) — they only check robustness
 * of the codec against malformed rows and untrusted IPC input.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  encodeReminders,
  decodeReminders,
  parseRemindersInput,
} from '../main/modules/calendar-engine/reminder-codec'

test('encodeReminders returns null for null/undefined/empty array', () => {
  assert.equal(encodeReminders(null), null)
  assert.equal(encodeReminders(undefined), null)
  assert.equal(encodeReminders([]), null)
})

test('encodeReminders round-trips a valid reminder array', () => {
  const value = [
    { offsetMinutes: -15, method: 'notification' as const },
    { offsetMinutes: -5, method: 'sound' as const },
  ]
  const encoded = encodeReminders(value)
  assert.equal(typeof encoded, 'string')
  const decoded = decodeReminders(encoded)
  assert.deepEqual(decoded, value)
})

test('decodeReminders returns null for null / undefined / empty string', () => {
  assert.equal(decodeReminders(null), null)
  assert.equal(decodeReminders(undefined), null)
  assert.equal(decodeReminders(''), null)
})

test('decodeReminders returns null for malformed JSON and logs', () => {
  const warns: string[] = []
  const logger = {
    warn: (message: string, detail?: Record<string, unknown>) => {
      warns.push(`${message}::${JSON.stringify(detail ?? {})}`)
    },
  }
  const out = decodeReminders('not json', { logger, eventId: 'evt-x' })
  assert.equal(out, null)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /JSON\.parse failed/)
})

test('decodeReminders returns null when JSON is not an array', () => {
  const warns: string[] = []
  const logger = {
    warn: (message: string) => { warns.push(message) },
  }
  const out = decodeReminders('{"oops": true}', { logger })
  assert.equal(out, null)
  assert.match(warns[0], /shape mismatch/)
})

test('decodeReminders returns null when array entries fail zod shape', () => {
  const warns: string[] = []
  const logger = {
    warn: (message: string) => { warns.push(message) },
  }
  // method='email' is not in the enum.
  const out = decodeReminders(
    '[{"offsetMinutes": -15, "method": "email"}]',
    { logger },
  )
  assert.equal(out, null)
  assert.match(warns[0], /shape mismatch/)
})

test('decodeReminders returns null when offsetMinutes is non-integer', () => {
  const out = decodeReminders('[{"offsetMinutes": -15.5, "method": "notification"}]')
  // Schema uses .int() — fractional should fail.
  assert.equal(out, null)
})

test('decodeReminders returns null for an empty JSON array (treated as "no reminders")', () => {
  const out = decodeReminders('[]')
  assert.equal(out, null)
})

test('parseRemindersInput accepts a valid array', () => {
  const value = [{ offsetMinutes: -10, method: 'notification' as const }]
  const out = parseRemindersInput(value)
  assert.deepEqual(out, value)
})

test('parseRemindersInput throws ZodError on shape mismatch', () => {
  assert.throws(
    () => parseRemindersInput([{ offsetMinutes: 'NaN', method: 'notification' }]),
    /offsetMinutes/i,
  )
  assert.throws(
    () => parseRemindersInput([{ offsetMinutes: -1, method: 'email' }]),
    /method/i,
  )
})

test('parseRemindersInput accepts an empty array (caller decides what null means)', () => {
  const out = parseRemindersInput([])
  assert.deepEqual(out, [])
})
