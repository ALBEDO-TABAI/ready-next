import assert from 'node:assert/strict'
import test from 'node:test'

import { SpecialistBlueprintConfirmationStore } from '../main/modules/agent-control/agents/specialist-blueprint-confirmation'

test('specialist blueprint confirmation token is bound to blueprint, session, and run', () => {
  const store = new SpecialistBlueprintConfirmationStore()
  const token = store.issue({
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
    runId: 'run-1',
    now: new Date('2026-06-19T00:00:00.000Z'),
  })

  assert.throws(() => store.consume({
    tokenId: token.id,
    blueprintId: 'bp-2',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
    runId: 'run-1',
  }), /blueprint mismatch/)
  assert.throws(() => store.consume({
    tokenId: token.id,
    blueprintId: 'bp-1',
    sessionId: 'session-2',
    blueprintHash: 'hash-a',
    runId: 'run-1',
  }), /session mismatch/)
  assert.throws(() => store.consume({
    tokenId: token.id,
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
    runId: 'run-2',
  }), /run mismatch/)
  assert.throws(() => store.consume({
    tokenId: token.id,
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-b',
    runId: 'run-1',
  }), /content mismatch/)

  const used = store.consume({
    tokenId: token.id,
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
    runId: 'run-1',
    now: new Date('2026-06-19T00:01:00.000Z'),
  })
  assert.equal(used.usedAt, '2026-06-19T00:01:00.000Z')
  assert.throws(() => store.consume({
    tokenId: token.id,
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
    runId: 'run-1',
  }), /already used/)
})

test('specialist blueprint confirmation validate does not consume token', () => {
  const store = new SpecialistBlueprintConfirmationStore()
  const token = store.issue({
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
    now: new Date('2026-06-19T00:00:00.000Z'),
  })

  const validated = store.validate({
    tokenId: token.id,
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
  })
  assert.equal(validated.usedAt, null)

  const used = store.consume({
    tokenId: token.id,
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
    now: new Date('2026-06-19T00:01:00.000Z'),
  })
  assert.equal(used.usedAt, '2026-06-19T00:01:00.000Z')
})

test('specialist blueprint confirmation token requires explicit session context', () => {
  const store = new SpecialistBlueprintConfirmationStore()
  assert.throws(() => store.issue({ blueprintId: '', sessionId: 'session-1', blueprintHash: 'hash-a' }), /blueprintId/)
  assert.throws(() => store.issue({ blueprintId: 'bp-1', sessionId: '', blueprintHash: 'hash-a' }), /sessionId/)
  assert.throws(() => store.issue({ blueprintId: 'bp-1', sessionId: 'session-1', blueprintHash: '' }), /blueprintHash/)
})

test('specialist blueprint confirmation DB mode fails writes loudly when DB is unavailable', () => {
  const store = new SpecialistBlueprintConfirmationStore({ getRawDb: () => null })
  assert.throws(() => store.issue({
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
  }), /database not available/)
  assert.throws(() => store.validate({
    tokenId: 'token-1',
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
  }), /token not found/)
  assert.throws(() => store.consume({
    tokenId: 'token-1',
    blueprintId: 'bp-1',
    sessionId: 'session-1',
    blueprintHash: 'hash-a',
  }), /database not available/)
})
