/**
 * L2-B-Reminder-UI behavior tests.
 *
 * Targets the pure helpers exported by `ReminderEditor.tsx` —
 * `normalizeOffsetMinutes` + `canonicalizeReminderList` — that
 * encapsulate the offset-clamp + empty-list-to-null contract every
 * caller depends on.
 *
 * Rationale per §6.17 (testing conventions): these helpers are the
 * boundary between user input (any number, possibly NaN) and the IPC
 * zod schema (strict integer, bounded magnitude). If they silently
 * regress, the IPC layer would either reject valid edits or accept
 * unsafe ones; both surfaces are user-visible. We test the behavior
 * (clamp / round / canonicalize) directly, not by source-grep.
 *
 * No React Testing Library: project is on node:test, no jsdom / RTL
 * harness in the repo. Component-level interactivity is covered by the
 * downstream calendar e2e once the renderer side stabilizes; the
 * editor's user-visible behavior reduces to these pure helpers plus
 * the IPC contract, so we test those two anchors.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalizeReminderList,
  normalizeOffsetMinutes,
} from '../renderer/components/calendar/ReminderEditor'

test('normalizeOffsetMinutes rounds non-integer offsets to integers', () => {
  assert.equal(normalizeOffsetMinutes(-15.4), -15)
  assert.equal(normalizeOffsetMinutes(-15.6), -16)
  assert.equal(normalizeOffsetMinutes(7.49), 7)
  assert.equal(normalizeOffsetMinutes(7.5), 8)
  assert.equal(normalizeOffsetMinutes(0), 0)
})

test('normalizeOffsetMinutes clamps to ±30 days (43200 minutes)', () => {
  assert.equal(normalizeOffsetMinutes(99999), 43200)
  assert.equal(normalizeOffsetMinutes(-99999), -43200)
  assert.equal(normalizeOffsetMinutes(43200), 43200)
  assert.equal(normalizeOffsetMinutes(-43200), -43200)
})

test('normalizeOffsetMinutes treats NaN / Infinity as 0', () => {
  assert.equal(normalizeOffsetMinutes(Number.NaN), 0)
  assert.equal(normalizeOffsetMinutes(Number.POSITIVE_INFINITY), 0)
  assert.equal(normalizeOffsetMinutes(Number.NEGATIVE_INFINITY), 0)
})

test('canonicalizeReminderList returns null for empty list (IPC clear contract)', () => {
  assert.equal(canonicalizeReminderList([]), null)
})

test('canonicalizeReminderList passes through non-empty list with normalized offsets', () => {
  const result = canonicalizeReminderList([
    { offsetMinutes: -15.5, method: 'notification' },
    { offsetMinutes: 0.4, method: 'sound' },
  ])
  assert.deepEqual(result, [
    { offsetMinutes: -15, method: 'notification' },
    { offsetMinutes: 0, method: 'sound' },
  ])
})

test('canonicalizeReminderList clamps each row independently', () => {
  const result = canonicalizeReminderList([
    { offsetMinutes: 99999, method: 'notification' },
    { offsetMinutes: -1440, method: 'notification' },
  ])
  assert.deepEqual(result, [
    { offsetMinutes: 43200, method: 'notification' },
    { offsetMinutes: -1440, method: 'notification' },
  ])
})

test('canonicalizeReminderList preserves Reminder.method exactly (no coercion)', () => {
  // Method is a closed union; we should never silently rewrite it
  // since the IPC schema enforces the same union and a bad method
  // value should round-trip back to the editor as an error, not be
  // silently coerced to 'notification'.
  const result = canonicalizeReminderList([
    { offsetMinutes: -10, method: 'sound' },
  ])
  assert.equal(result?.[0]?.method, 'sound')
})
