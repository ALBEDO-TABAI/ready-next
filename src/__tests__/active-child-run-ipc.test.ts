import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelChildRunForIpc,
  listActiveChildRunsForIpc,
} from '../main/modules/claude-bridge/active-child-run-ipc'

test('listActiveChildRunsForIpc returns active child run summaries with projection fields', () => {
  const rows = [{
    childRunId: 'vcr_1',
    status: 'running',
    startedAt: '2026-05-02T00:00:00.000Z',
  }]
  const runtime = {
    listActiveChildRuns: () => rows,
  }

  const response = listActiveChildRunsForIpc(runtime)

  assert.deepEqual(response, {
    success: true,
    data: [{
      childRunId: 'vcr_1',
      status: 'running',
      startedAt: '2026-05-02T00:00:00.000Z',
      progress: {
        stage: null,
        completed: null,
        total: null,
        coverage: null,
        fingerprint: null,
        updatedAt: null,
        lastError: null,
      },
      blockedReason: null,
      liveness: 'background',
      closeStatus: null,
    }],
  })
})

test('cancelChildRunForIpc validates childRunId and records ui_button source', async () => {
  const seen: Array<{ childRunId: string; source: string }> = []
  const closeEvent = { status: 'cancelled', terminalReason: 'cancelled_user' }
  const runtime = {
    cancelChildRun: async (childRunId: string, options: { source: 'ui_button' }) => {
      seen.push({ childRunId, source: options.source })
      return closeEvent
    },
  }

  const missing = await cancelChildRunForIpc(runtime, { childRunId: '   ' })
  const cancelled = await cancelChildRunForIpc(runtime, { childRunId: '  vcr_123  ' })

  assert.deepEqual(missing, { success: false, error: 'childRunId is required' })
  assert.deepEqual(cancelled, { success: true, data: closeEvent })
  assert.deepEqual(seen, [{ childRunId: 'vcr_123', source: 'ui_button' }])
})
