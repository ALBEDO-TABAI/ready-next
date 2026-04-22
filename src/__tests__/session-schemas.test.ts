/**
 * Shape tests for the session recall domain Zod schemas (Phase 2.5 PR 5).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionSearchSchema } from '../main/modules/tools/schemas/session-schemas'

test('SessionSearchSchema accepts empty object (all fields optional)', () => {
  assert.equal(SessionSearchSchema.safeParse({}).success, true)
})

test('SessionSearchSchema accepts all fields populated with valid types', () => {
  const ok = SessionSearchSchema.safeParse({
    query: 'foo',
    channelKey: 'local:app',
    sourceKind: 'local',
    hasAttachments: true,
    limit: 10,
  })
  assert.equal(ok.success, true)
})

test('SessionSearchSchema rejects unknown sourceKind enum values', () => {
  assert.equal(SessionSearchSchema.safeParse({ sourceKind: 'unknown' }).success, false)
  assert.equal(SessionSearchSchema.safeParse({ sourceKind: 'channel' }).success, true)
})

test('SessionSearchSchema enforces hasAttachments as boolean and limit as number', () => {
  assert.equal(SessionSearchSchema.safeParse({ hasAttachments: 'yes' }).success, false)
  assert.equal(SessionSearchSchema.safeParse({ limit: 'ten' }).success, false)
  assert.equal(SessionSearchSchema.safeParse({ hasAttachments: false, limit: 3 }).success, true)
})
