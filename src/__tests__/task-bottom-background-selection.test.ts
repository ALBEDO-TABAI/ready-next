import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_BOTTOM_BACKGROUND_TASK_CARDS,
  selectBottomBackgroundTaskRuns,
} from '../renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot'

describe('bottom background task card selection', () => {
  it('caps visible bottom cards and reports the hidden count', () => {
    const result = selectBottomBackgroundTaskRuns(['a', 'b', 'c', 'd'])

    assert.equal(result.visibleRuns.length, MAX_BOTTOM_BACKGROUND_TASK_CARDS)
    assert.deepEqual(result.visibleRuns, ['a', 'b'])
    assert.equal(result.hiddenCount, 2)
  })

  it('does not report hidden cards when the list fits', () => {
    const result = selectBottomBackgroundTaskRuns(['a'])

    assert.deepEqual(result.visibleRuns, ['a'])
    assert.equal(result.hiddenCount, 0)
  })
})
