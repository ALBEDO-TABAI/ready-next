import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyLeaseSnapshotToSupervisionState,
  type AgentBrowserSupervisionState,
} from '../renderer/modules/browser/useAgentBrowserSupervision'

const baseState: AgentBrowserSupervisionState = {
  controlState: 'active',
  agentTabId: 'tab-agent',
  tasks: [],
  surfaces: null,
  activeWriteSurface: null,
}

test('lease push snapshot updates supervision ownership without replacing tasks or control state', () => {
  const next = applyLeaseSnapshotToSupervisionState(baseState, {
    surfaces: {
      'user-view': {
        surface: 'user-view',
        state: 'takeover',
        heldBy: null,
        runId: null,
        tabId: null,
        leaseId: null,
      },
      'agent-view': {
        surface: 'agent-view',
        state: 'idle',
        heldBy: null,
        runId: null,
        tabId: null,
        leaseId: null,
      },
    },
    activeWriteSurface: null,
  })

  assert.equal(next.controlState, 'active')
  assert.equal(next.agentTabId, 'tab-agent')
  assert.equal(next.surfaces?.['user-view'].state, 'takeover')
  assert.equal(next.activeWriteSurface, null)
})

test('lease push snapshot can clear activeWriteSurface explicitly', () => {
  const next = applyLeaseSnapshotToSupervisionState({
    ...baseState,
    activeWriteSurface: 'user-view',
  }, {
    activeWriteSurface: null,
  })

  assert.equal(next.activeWriteSurface, null)
})
