import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { gateActOnTarget } from '../main/modules/browser-engine/agent-browser-act'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'

describe('gateActOnTarget', () => {
  it('rejects a target built against a stale page-map generation', () => {
    const res = gateActOnTarget(
      { targetId: '3:0:10', action: 'click' },
      { currentGeneration: 4, matchCount: 1 },
    )
    assert.ok(isAgentBrowserError(res))
    if (!isAgentBrowserError(res)) return
    assert.equal(res.errorCode, 'stale_page_map')
    assert.equal(res.detail?.currentGeneration, 4)
  })

  it('rejects an ambiguous target and returns the candidates instead of blind-clicking', () => {
    const res = gateActOnTarget(
      { targetId: '4:0:10', action: 'click' },
      { currentGeneration: 4, matchCount: 2, candidates: [{ a: 1 }, { b: 2 }] },
    )
    assert.ok(isAgentBrowserError(res))
    if (!isAgentBrowserError(res)) return
    assert.equal(res.errorCode, 'ambiguous_target')
    assert.equal(res.detail?.matchCount, 2)
    assert.deepEqual(res.detail?.candidates, [{ a: 1 }, { b: 2 }])
  })

  it('rejects a target from an ambiguity group unless the caller disambiguates it', () => {
    const res = gateActOnTarget(
      { targetId: '4:0:10', action: 'click' },
      {
        currentGeneration: 4,
        matchCount: 1,
        ambiguityGroup: { role: 'button', name: 'Search', targetIds: ['4:0:10', '4:0:11'] },
      },
    )
    assert.ok(isAgentBrowserError(res))
    if (!isAgentBrowserError(res)) return
    assert.equal(res.errorCode, 'ambiguous_target')
    assert.deepEqual(res.detail?.ambiguityGroup, { role: 'button', name: 'Search', targetIds: ['4:0:10', '4:0:11'] })

    const allowed = gateActOnTarget(
      { targetId: '4:0:10', action: 'click', disambiguation: 'the first Search button is inside the header form' },
      {
        currentGeneration: 4,
        matchCount: 1,
        ambiguityGroup: { role: 'button', name: 'Search', targetIds: ['4:0:10', '4:0:11'] },
      },
    )
    assert.ok(!isAgentBrowserError(allowed))
  })

  it('rejects a target that resolves to nothing', () => {
    const res = gateActOnTarget(
      { targetId: '4:0:10', action: 'click' },
      { currentGeneration: 4, matchCount: 0 },
    )
    assert.ok(isAgentBrowserError(res))
    if (!isAgentBrowserError(res)) return
    assert.equal(res.errorCode, 'target_not_found')
  })

  it('requires a value for choose / fill', () => {
    const res = gateActOnTarget(
      { targetId: '4:0:10', action: 'fill' },
      { currentGeneration: 4, matchCount: 1 },
    )
    assert.ok(isAgentBrowserError(res))
    if (!isAgentBrowserError(res)) return
    assert.equal(res.errorCode, 'target_not_found')
  })

  it('passes a unique, current target and returns the parsed ref', () => {
    const res = gateActOnTarget(
      { targetId: '4:2:99', action: 'click' },
      { currentGeneration: 4, matchCount: 1 },
    )
    assert.ok(!isAgentBrowserError(res))
    if (isAgentBrowserError(res)) return
    assert.deepEqual(res, { generation: 4, frameId: '2', node: '99' })
  })
})
