import assert from 'node:assert/strict'
import test from 'node:test'

import { ReadyAgentOrchestrator } from '../main/modules/agent-control/runtime-core/orchestrator'

test('renderer liveness report observes a matching active run without cancelling it', () => {
  const orchestrator = new ReadyAgentOrchestrator()
  const stops: string[] = []
  ;(orchestrator as any).sdkEngine.stopGeneration = () => { stops.push('stopped') }
  ;(orchestrator as any).activeRunIds.set('butler::scope-A', 'req-A')

  assert.deepEqual(
    orchestrator.inspectActiveRunIfMatches('butler', 'scope-A', 'req-A'),
    { state: 'active', runId: 'req-A' },
  )
  assert.deepEqual(
    orchestrator.inspectActiveRunIfMatches('butler', 'scope-A', 'req-old'),
    { state: 'stale', runId: null, activeRunId: 'req-A' },
  )
  assert.deepEqual(stops, [], 'a liveness probe must never stop the provider run')
})

test('renderer infrastructure timeout only stops the active matching request id', () => {
  const orchestrator = new ReadyAgentOrchestrator()
  // 合同随实现同步（Phase C C3，2026-07-05）：引擎停线随退役删除，
  // 停发面收敛为 sdkEngine 单引擎。
  const stops: Array<{ engine: string; key: string; initiator: string }> = []
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
