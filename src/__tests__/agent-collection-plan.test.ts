import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseCollectionPlan,
  createCollectionLoopState,
  planNextNote,
  recordNoteResult,
  type CollectionPlan,
} from '../main/modules/browser-engine/agent-collection-plan'

const validRaw = {
  targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/abc',
  notes: [
    { url: 'https://www.xiaohongshu.com/note/1', title: '笔记一' },
    { url: 'https://www.xiaohongshu.com/note/2', title: '笔记二' },
  ],
  outputRootDir: '/tmp/aoi',
  stopConditions: { maxNotes: 50 },
}

describe('CollectionPlan schema', () => {
  it('parses a valid plan', () => {
    const res = parseCollectionPlan(validRaw)
    assert.equal(res.ok, true)
  })
  it('rejects an empty notes list with issues', () => {
    const res = parseCollectionPlan({ ...validRaw, notes: [] })
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.ok(res.issues.some((i) => i.includes('notes')))
  })
  it('rejects a missing outputRootDir', () => {
    const { outputRootDir, ...rest } = validRaw
    void outputRootDir
    const res = parseCollectionPlan(rest)
    assert.equal(res.ok, false)
  })
})

describe('per-note loop', () => {
  const plan = (parseCollectionPlan(validRaw) as { ok: true; plan: CollectionPlan }).plan

  it('walks notes in order then completes', () => {
    let state = createCollectionLoopState(0)
    let step = planNextNote(plan, state, 0)
    assert.equal(step.note?.url, 'https://www.xiaohongshu.com/note/1')
    state = recordNoteResult(state, step.note!, { success: true })
    step = planNextNote(plan, state, 1)
    assert.equal(step.note?.url, 'https://www.xiaohongshu.com/note/2')
    state = recordNoteResult(state, step.note!, { success: true })
    step = planNextNote(plan, state, 2)
    assert.equal(step.stop, 'completed')
    assert.equal(state.collected.length, 2)
  })

  it('counts failures and records reasons; resets consecutive on success', () => {
    let state = createCollectionLoopState(0)
    state = recordNoteResult(state, plan.notes[0], { success: false, reason: 'http_404' })
    assert.equal(state.consecutiveFailures, 1)
    assert.equal(state.failed[0].reason, 'http_404')
    state = recordNoteResult(state, plan.notes[1], { success: true })
    assert.equal(state.consecutiveFailures, 0)
    assert.equal(state.collected.length, 1)
  })

  it('stops on too_many_failures', () => {
    const p = { ...plan, stopConditions: { maxConsecutiveFailures: 2 } }
    let state = createCollectionLoopState(0)
    state = recordNoteResult(state, plan.notes[0], { success: false, reason: 'x' })
    state = recordNoteResult(state, plan.notes[1], { success: false, reason: 'x' })
    const step = planNextNote(p as CollectionPlan, state, 1)
    assert.equal(step.stop, 'too_many_failures')
  })

  it('stops on max_notes and max_duration', () => {
    const pMax = { ...plan, stopConditions: { maxNotes: 1 } }
    let state = createCollectionLoopState(0)
    state = recordNoteResult(state, plan.notes[0], { success: true })
    assert.equal(planNextNote(pMax as CollectionPlan, state, 1).stop, 'max_notes')

    const pDur = { ...plan, stopConditions: { maxDurationMs: 1000 } }
    const fresh = createCollectionLoopState(0)
    assert.equal(planNextNote(pDur as CollectionPlan, fresh, 2000).stop, 'max_duration')
  })
})
