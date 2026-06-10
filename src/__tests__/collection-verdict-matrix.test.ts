import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveCollectionVerdict } from '../main/modules/browser-engine/collection-verdict'

describe('collection verdict matrix', () => {
  it('Q1 marks empty collection as needing attention via failed status fallback', () => {
    const verdict = resolveCollectionVerdict({
      collected: 0,
      expected: 10,
      stopReason: 'completed',
      failures: 0,
      cursorValid: false,
    })

    assert.equal(verdict.status, 'failed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.empty_collection')
    assert.equal(verdict.verdict, 'needs_attention')
  })

  it('Q2 keeps a valid cursor for recoverable partial collection', () => {
    const verdict = resolveCollectionVerdict({
      collected: 5,
      expected: 10,
      stopReason: 'max_duration',
      failures: 0,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'paused')
    assert.equal(verdict.keepCursor, true)
    assert.equal(verdict.labelKey, 'verdict.recoverable_paused')
    assert.equal(verdict.verdict, 'recoverable_paused')
  })

  it('Q3 fails unrecoverable partial collection without a valid cursor', () => {
    const verdict = resolveCollectionVerdict({
      collected: 5,
      expected: 10,
      stopReason: 'completed',
      failures: 5,
      cursorValid: false,
    })

    assert.equal(verdict.status, 'failed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.unrecoverable_partial')
    assert.equal(verdict.verdict, 'completed_partial')
  })

  it('Q4 completes when collected reaches expected count', () => {
    const verdict = resolveCollectionVerdict({
      collected: 10,
      expected: 10,
      stopReason: 'completed',
      failures: 0,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'completed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.completed')
    assert.equal(verdict.verdict, 'completed')
  })

  it('Q5 completes natural collection when expected count is unknown', () => {
    const verdict = resolveCollectionVerdict({
      collected: 5,
      expected: undefined,
      stopReason: 'no_new_content',
      failures: 0,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'completed')
    assert.equal(verdict.keepCursor, false)
    assert.equal(verdict.labelKey, 'verdict.completed')
    assert.equal(verdict.verdict, 'completed')
  })

  it('Q6 replays 06-06 partial collection as recoverable with cursor kept', () => {
    const verdict = resolveCollectionVerdict({
      collected: 62,
      expected: 69,
      stopReason: 'completed',
      failures: 7,
      cursorValid: true,
    })

    assert.equal(verdict.status, 'paused')
    assert.equal(verdict.keepCursor, true)
    assert.equal(verdict.labelKey, 'verdict.recoverable_paused')
    assert.equal(verdict.verdict, 'recoverable_paused')
  })
})
