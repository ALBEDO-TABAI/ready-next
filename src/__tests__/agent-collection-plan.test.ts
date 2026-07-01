import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseCollectionPlan,
  createCollectionLoopState,
  planNextNote,
  recordNoteResult,
  classifyCollectionFailureReason,
  inferCollectionFailureRetryable,
  collectionFailureEscalation,
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
    const done = plan.notes.reduce(
      (state, note) => recordNoteResult(state, note, { success: true }),
      createCollectionLoopState(0),
    )
    assert.equal(planNextNote(pDur as CollectionPlan, done, 2000).stop, 'completed')
  })
})

describe('E1/E2: collection failure reason → policy (single source of truth)', () => {
  it('E1: transient load/DOM/download failures are now RETRYABLE (were permanently lost)', () => {
    for (const reason of [
      'detail_not_opened', 'no_images', 'detail_mismatch', 'card_not_found',
      'download_failed', 'download:net::ERR', 'open_card:boom', 'collect:boom',
      'verify_detail:boom', 'return_list:boom',
    ]) {
      assert.equal(inferCollectionFailureRetryable(reason), true, `${reason} must be retryable`)
      assert.equal(collectionFailureEscalation(reason), 'none', `${reason} must not escalate`)
    }
  })

  it('E2: partial_images is per-note partial (retryable, no human escalation)', () => {
    for (const reason of ['partial_images:3/5', 'partial_images:2/unknown']) {
      assert.deepEqual(classifyCollectionFailureReason(reason), { retryable: true, escalate: 'none' })
    }
  })

  it('access wall stays human-escalating + non-retryable', () => {
    assert.deepEqual(classifyCollectionFailureReason('needs_verification'), { retryable: false, escalate: 'human' })
  })

  it('terminal/permanent failures stay non-retryable, no escalation', () => {
    for (const reason of ['permission', 'forbidden', 'deleted', 'unavailable', 'skipped_video', 'video_download:boom', 'blocked_permanent', 'terminal_skip']) {
      assert.deepEqual(classifyCollectionFailureReason(reason), { retryable: false, escalate: 'none' }, reason)
    }
  })

  it('retained transient reasons (timeout/navigate/network/lease_lost) stay retryable', () => {
    for (const reason of ['timeout', 'navigate:nav_failed', 'network', 'lease_lost', 'rate', 'throttle']) {
      assert.equal(inferCollectionFailureRetryable(reason), true, reason)
    }
  })

  it('unknown reason defaults to retryable (never silently permanently-drop a recoverable note)', () => {
    assert.deepEqual(classifyCollectionFailureReason('some_brand_new_reason'), { retryable: true, escalate: 'none' })
  })
})
