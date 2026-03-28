import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { replaceExactTextInDocument } from '../renderer/modules/agent/documentActions'

describe('replaceExactTextInDocument', () => {
  it('replaces the single exact match', () => {
    const result = replaceExactTextInDocument(
      'alpha\nbeta\ngamma\n',
      'beta',
      'BETA',
    )

    assert.equal(result.found, true)
    assert.equal(result.content, 'alpha\nBETA\ngamma\n')
    assert.equal(result.occurrenceUsed, 1)
  })

  it('requires occurrence when the target appears multiple times', () => {
    const result = replaceExactTextInDocument(
      'foo\nbar\nfoo\n',
      'foo',
      'baz',
    )

    assert.equal(result.found, false)
    assert.match(result.error || '', /occurrence/)
    assert.equal(result.totalMatches, 2)
  })

  it('replaces only the requested occurrence', () => {
    const result = replaceExactTextInDocument(
      'foo\nbar\nfoo\n',
      'foo',
      'baz',
      2,
    )

    assert.equal(result.found, true)
    assert.equal(result.content, 'foo\nbar\nbaz\n')
    assert.equal(result.occurrenceUsed, 2)
  })
})
