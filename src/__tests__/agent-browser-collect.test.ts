import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  itemIdentity,
  VisibleCollectDeduper,
  evaluateStop,
  DEFAULT_VISIBLE_COLLECT_LIMITS,
} from '../main/modules/browser-engine/agent-browser-collect'

describe('visible-collect identity + dedup', () => {
  it('uses a normalized link as identity (strips hash + tracking params)', () => {
    const a = itemIdentity({ link: 'https://x.com/p/1?utm_source=feed#top' })
    const b = itemIdentity({ link: 'https://x.com/p/1' })
    assert.equal(a, b)
  })

  it('falls back to text+container hash when there is no link', () => {
    const a = itemIdentity({ text: 'hello world', containerPath: 'feed>0' })
    const b = itemIdentity({ text: 'hello   world', containerPath: 'feed>0' })
    const c = itemIdentity({ text: 'hello world', containerPath: 'feed>1' })
    assert.equal(a, b, 'whitespace-normalized text in same container is the same item')
    assert.notEqual(a, c, 'different container is a different item')
  })

  it('dedupes across rounds: an item seen in round 1 is not re-collected in round 5', () => {
    const d = new VisibleCollectDeduper()
    const r1 = d.addBatch([{ link: 'https://x.com/1' }, { link: 'https://x.com/2' }])
    assert.equal(r1.length, 2)
    const r2 = d.addBatch([{ link: 'https://x.com/2' }, { link: 'https://x.com/3' }])
    assert.equal(r2.length, 1)
    assert.equal(r2[0].link, 'https://x.com/3')
    assert.equal(d.size, 3)
  })
})

describe('visible-collect stop conditions (all hard budgets)', () => {
  const base = { collectedCount: 0, round: 0, consecutiveEmptyRounds: 0, elapsedMs: 0 }

  it('keeps going when no budget is hit', () => {
    assert.equal(evaluateStop({ ...base }), null)
  })

  it('stops on max_items', () => {
    assert.equal(evaluateStop({ ...base, collectedCount: DEFAULT_VISIBLE_COLLECT_LIMITS.maxItems }), 'max_items')
  })

  it('stops on max_rounds', () => {
    assert.equal(evaluateStop({ ...base, round: DEFAULT_VISIBLE_COLLECT_LIMITS.maxRounds }), 'max_rounds')
  })

  it('stops on max_duration', () => {
    assert.equal(evaluateStop({ ...base, elapsedMs: DEFAULT_VISIBLE_COLLECT_LIMITS.maxDurationMs }), 'max_duration')
  })

  it('stops on consecutive empty rounds', () => {
    assert.equal(
      evaluateStop({ ...base, consecutiveEmptyRounds: DEFAULT_VISIBLE_COLLECT_LIMITS.emptyRoundsToStop }),
      'no_new_content',
    )
  })

  it('stops on cancellation and lease loss with priority', () => {
    assert.equal(evaluateStop({ ...base, cancelled: true }), 'cancelled')
    assert.equal(evaluateStop({ ...base, leaseLost: true }), 'lease_lost')
  })
})
