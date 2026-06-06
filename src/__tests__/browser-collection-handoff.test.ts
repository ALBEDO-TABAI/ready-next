import { describe, it } from 'node:test'
import assert from 'node:assert'

import { buildCollectionHandoffPlanFromTask } from '../main/modules/browser-engine/collection-handoff'
import type { BrowserCapabilityTaskHandle } from '../main/modules/browser-engine/capability-types'

function visibleTask(overrides: Partial<BrowserCapabilityTaskHandle> = {}): BrowserCapabilityTaskHandle {
  return {
    taskId: 'browser-task-source-1',
    kind: 'visible_collect',
    status: 'completed',
    progress: { total: 2, completed: 2, failed: 0, currentLabel: null },
    result: {
      targetUrl: 'https://www.xiaohongshu.com/user/profile/abc',
      outputRootDir: '~/Downloads/aoi',
      noteCandidates: [
        {
          url: 'https://www.xiaohongshu.com/explore/1?xsec=one',
          title: 'same title',
          sourceId: 'one',
          order: 1,
          kind: 'content',
        },
        {
          url: 'https://www.xiaohongshu.com/explore/2?xsec=two',
          title: 'same title',
          sourceId: 'two',
          order: 2,
          kind: 'video',
        },
      ],
    },
    ...overrides,
  }
}

describe('browser collection handoff', () => {
  it('builds a card-loop plan from a completed high-control visible collection', () => {
    const handoff = buildCollectionHandoffPlanFromTask(visibleTask())

    assert.ok(handoff)
    assert.equal(handoff.strategy, 'card_loop')
    assert.equal(handoff.notes.length, 2)
    assert.equal(handoff.plan.targetProfileUrl, 'https://www.xiaohongshu.com/user/profile/abc')
    assert.equal(handoff.plan.strategy, 'card_loop')
    assert.equal(handoff.plan.expectedCount, 2)
    assert.equal(handoff.plan.sourceTaskId, 'browser-task-source-1')
    assert.match(String(handoff.plan.outputRootDir), /Downloads\/aoi$/)
    const notes = handoff.plan.notes as Array<Record<string, unknown>>
    assert.equal(notes[0]?.duplicateTitle, true)
    assert.equal(notes[1]?.kind, 'video')
  })

  it('returns null when the source task is not a completed visible collection', () => {
    assert.equal(buildCollectionHandoffPlanFromTask(visibleTask({ status: 'running' })), null)
    assert.equal(buildCollectionHandoffPlanFromTask(visibleTask({ kind: 'note_collect' })), null)
  })
})
