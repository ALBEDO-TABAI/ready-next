import assert from 'node:assert/strict'
import test from 'node:test'

import { ReadyAgentOrchestrator } from '../main/modules/agent-control/runtime-core/orchestrator'

test('renderer infrastructure timeout only stops the active matching request id', () => {
  const orchestrator = new ReadyAgentOrchestrator()
  const stops: Array<{ engine: string; key: string; initiator: string }> = []
  ;(orchestrator as any).domainAdapterEngine.stopGeneration = (key: string, initiator: string) => {
    stops.push({ engine: 'domain', key, initiator })
  }
  ;(orchestrator as any).sdkEngine.stopGeneration = (key: string, initiator: string) => {
    stops.push({ engine: 'sdk', key, initiator })
  }

  ;(orchestrator as any).activeRunIds.set('butler::scope-A', 'req-A')

  const stale = orchestrator.interruptActiveRunIfMatches(
    'butler',
    'scope-A',
    'req-B',
    'process_exit',
  )
  assert.equal(stale.state, 'stale')
  assert.equal(stale.activeRunId, 'req-A')
  assert.equal(stops.length, 0, 'stale timeout report must not stop the newer active run')
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), 'req-A')

  const cancelled = orchestrator.interruptActiveRunIfMatches(
    'butler',
    'scope-A',
    'req-A',
    'process_exit',
  )
  assert.equal(cancelled.state, 'cancel_requested')
  assert.equal(cancelled.runId, 'req-A')
  assert.deepEqual(stops, [
    { engine: 'domain', key: 'butler::scope-A', initiator: 'process_exit' },
    { engine: 'sdk', key: 'butler::scope-A', initiator: 'process_exit' },
  ])
  assert.equal((orchestrator as any).activeRunIds.get('butler::scope-A'), undefined)

  const notFound = orchestrator.interruptActiveRunIfMatches(
    'butler',
    'scope-A',
    'req-A',
    'process_exit',
  )
  assert.equal(notFound.state, 'not_found')
  assert.equal(notFound.runId, null)
})
