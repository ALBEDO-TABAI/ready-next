import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  deriveScopeRunStatePatch,
  isActiveScopePhase,
  mergeArtifacts,
  phaseToToolTraceStatus,
} from '../renderer/modules/agent/scopeRunState'

describe('scope run state helpers', () => {
  it('deduplicates artifacts by path and keeps unique entries', () => {
    const merged = mergeArtifacts(
      [
        {
          id: 'a1',
          module: 'document',
          kind: 'document-save',
          label: 'draft.md',
          path: '/tmp/draft.md',
          createdAt: '2026-03-07T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'a2',
          module: 'document',
          kind: 'document-save',
          label: 'draft copy',
          path: '/tmp/draft.md',
          createdAt: '2026-03-07T00:00:01.000Z',
        },
        {
          id: 'a3',
          module: 'rss',
          kind: 'rss-report',
          label: 'report.md',
          path: '/tmp/report.md',
          createdAt: '2026-03-07T00:00:02.000Z',
        },
      ],
    )

    assert.strictEqual(merged.length, 2)
    assert.deepStrictEqual(
      merged.map((item) => item.path),
      ['/tmp/draft.md', '/tmp/report.md'],
    )
  })

  it('turns human_required payloads into takeover state with checkpoint metadata', () => {
    const originalDateNow = Date.now
    Date.now = () => 1_700_000_000_000

    try {
      const patch = deriveScopeRunStatePatch(
        {
          phase: 'tool_running',
          timestamp: '2026-03-07T00:00:00.000Z',
          toolEvent: {
            kind: 'result',
            timestamp: '2026-03-07T00:00:00.000Z',
            text: JSON.stringify({
              phase: 'human_required',
              module: 'browser',
              intent: 'browser_ask_user_takeover',
              call_to_action: '请检查登录状态',
              details: '页面出现验证码',
              timeout_sec: 30,
              controllerId: 'controller-1',
              ownerTabId: 'tab-9',
            }),
          },
        },
        {
          scopeId: 'scope-1',
          agent: 'butler',
          requestId: 'run-1',
          phase: 'tool_running',
          toolTrace: [],
          startedAt: '2026-03-07T00:00:00.000Z',
          updatedAt: '2026-03-07T00:00:00.000Z',
          artifactRefs: [],
          checkpointExpiresAt: null,
          responseBuffer: '',
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
        },
      )

      assert.strictEqual(patch.phase, 'takeover')
      assert.strictEqual(patch.module, 'browser')
      assert.strictEqual(patch.intent, 'browser_ask_user_takeover')
      assert.strictEqual(patch.blockedReason, '请检查登录状态 · 页面出现验证码')
      assert.strictEqual(patch.controllerId, 'controller-1')
      assert.strictEqual(patch.ownerTabId, 'tab-9')
      assert.strictEqual(patch.checkpointExpiresAt, 1_700_000_030_000)
    } finally {
      Date.now = originalDateNow
    }
  })

  it('marks active phases consistently for alias sync', () => {
    assert.strictEqual(isActiveScopePhase('tool_running'), true)
    assert.strictEqual(isActiveScopePhase('responding'), true)
    assert.strictEqual(isActiveScopePhase('done'), false)
    assert.strictEqual(phaseToToolTraceStatus('checkpoint'), 'running')
    assert.strictEqual(phaseToToolTraceStatus('cancelled'), 'cancelled')
  })
})
