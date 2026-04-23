import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DocumentInsightCache } from '../main/modules/agent-control/document-insight-cache'

describe('DocumentInsightCache', () => {
  it('returns a cached entry before ttl expires', () => {
    let now = 1_700_000_000_000
    const cache = new DocumentInsightCache({ now: () => now, ttlMs: 10_000, maxEntries: 4 })
    cache.set('doc-1', {
      insight: {
        question: 'q',
        documentPath: '/tmp/doc.md',
        documentTitle: 'doc.md',
        summary: 'summary',
        keyPoints: ['one'],
        evidence: [{ quote: 'one' }],
        recommendedWidget: 'info_card',
      },
      metrics: {
        chunkCount: 4,
        selectedChunkCount: 2,
      },
    })

    const hit = cache.get('doc-1')
    assert.equal(hit?.insight.summary, 'summary')
    assert.equal(hit?.metrics?.chunkCount, 4)

    now += 11_000
    assert.equal(cache.get('doc-1'), null)
  })

  it('keeps only the newest entries within the size limit', () => {
    let now = 1_700_000_000_000
    const cache = new DocumentInsightCache({ now: () => now, ttlMs: 60_000, maxEntries: 2 })

    cache.set('a', {
      insight: {
        question: 'a',
        documentPath: null,
        documentTitle: 'a',
        summary: 'a',
        keyPoints: ['a'],
        evidence: [{ quote: 'a' }],
        recommendedWidget: 'info_card',
      },
    })
    now += 1
    cache.set('b', {
      insight: {
        question: 'b',
        documentPath: null,
        documentTitle: 'b',
        summary: 'b',
        keyPoints: ['b'],
        evidence: [{ quote: 'b' }],
        recommendedWidget: 'info_card',
      },
    })
    now += 1
    cache.set('c', {
      insight: {
        question: 'c',
        documentPath: null,
        documentTitle: 'c',
        summary: 'c',
        keyPoints: ['c'],
        evidence: [{ quote: 'c' }],
        recommendedWidget: 'info_card',
      },
    })

    assert.equal(cache.get('a'), null)
    assert.equal(cache.get('b')?.insight.summary, 'b')
    assert.equal(cache.get('c')?.insight.summary, 'c')
  })
})
