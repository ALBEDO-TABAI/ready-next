import assert from 'node:assert/strict'
import test from 'node:test'

import { getRSSAnalysisPollState } from '../renderer/modules/rss/analysisPollState'

test('RSS analysis polling treats idle progress as a healthy background state', () => {
  const state = getRSSAnalysisPollState({ ok: true, hasActiveWork: false }, true)

  assert.equal(state.backgroundWarning, null)
  assert.equal(state.nextDelayMs, 9000)
})

test('RSS analysis polling keeps the fast interval only while analysis work is active', () => {
  const state = getRSSAnalysisPollState({ ok: true, hasActiveWork: true }, true)

  assert.equal(state.backgroundWarning, null)
  assert.equal(state.nextDelayMs, 1400)
})

test('RSS analysis polling warns when either background read fails', () => {
  assert.equal(
    getRSSAnalysisPollState({ ok: false, hasActiveWork: false }, true).backgroundWarning,
    'RSS 后台同步失败，部分状态可能过期。',
  )
  assert.equal(
    getRSSAnalysisPollState({ ok: true, hasActiveWork: false }, false).backgroundWarning,
    'RSS 后台同步失败，部分状态可能过期。',
  )
})
