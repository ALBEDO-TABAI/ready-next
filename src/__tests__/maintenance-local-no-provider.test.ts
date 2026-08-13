import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  createCrystallizeEffectors,
  runCrystallizeRound,
} from '../main/modules/agent-control/maintenance/crystallize-gate'
import { runBeliefDecayRound } from '../main/modules/agent-control/memory/belief-decay'

test('deterministic maintenance performs zero provider calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-local-maintenance-'))
  const originalFetch = globalThis.fetch
  let providerCalls = 0
  globalThis.fetch = (async () => {
    providerCalls += 1
    throw new Error('maintenance_must_not_call_provider')
  }) as typeof fetch

  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const crystallize = await runCrystallizeRound({
      signals: {
        lastRunAt: null,
        newCheckInsWithLearning: 0,
        newConversationTurns: 0,
        cardWritesSinceLast: 0,
        memoryFileMtimeChanged: false,
        forced: true,
      },
      now: new Date('2026-08-12T00:00:00.000Z'),
      store,
      effectors: createCrystallizeEffectors(store),
    })
    const decay = runBeliefDecayRound([], {
      setConfidence: () => undefined,
      markDecayed: () => undefined,
      deleteCard: () => undefined,
    }, new Date('2026-08-12T00:00:00.000Z'))

    assert.equal(crystallize.decision, 'run')
    assert.deepEqual(decay, { promoted: 0, demoted: 0, marked: 0, deleted: 0, kept: 0 })
    assert.equal(providerCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})
