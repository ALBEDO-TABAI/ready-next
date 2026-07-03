/**
 * P2-6 (2026-07-03) — belief-card mirror rows are written into L2
 * (belief-card-mirror.ts: layer='l2', category='belief') and their access_count
 * stays 0 until usage-counting lands. The generic low-access L2 sweep
 * (archiveOldL2Memories) must NOT archive them, or a valid belief card silently
 * drops out of the active mirror at l2ExpiryDays. Belief cards decay through
 * belief-decay.ts, not the memory archival sweep.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryLifecycleManager } from '../main/modules/agent-control/memory/memory-lifecycle'
import type { MemoryRepository } from '../main/modules/repositories/memory-repository'

const NINETY_ONE_DAYS_AGO = Math.floor(Date.now() / 1000) - 91 * 86400

function makeFakeRepo(archived: string[]) {
  // Two old, low-access L2 entries: one belief mirror, one ordinary summary.
  const l2Entries = [
    { id: 'belief-1', category: 'belief', accessCount: 0, lastAccessedAt: NINETY_ONE_DAYS_AGO, createdAt: NINETY_ONE_DAYS_AGO },
    { id: 'summary-1', category: 'summary', accessCount: 0, lastAccessedAt: NINETY_ONE_DAYS_AGO, createdAt: NINETY_ONE_DAYS_AGO },
  ]
  return {
    queryMemories: async (filters: { layer?: string }) => (filters.layer === 'l2' ? l2Entries : []),
    archiveMemory: async (id: string) => { archived.push(id) },
    pruneArchivedMemories: async () => 0,
    listTriggers: async () => [],
    updateTrigger: async () => undefined,
  } as unknown as MemoryRepository
}

test('archiveOldL2Memories skips belief-category mirror rows but archives ordinary L2', async () => {
  const archived: string[] = []
  const manager = new MemoryLifecycleManager(makeFakeRepo(archived))
  manager.start()
  try {
    const result = await manager.runMaintenance()
    // The belief mirror survives; the ordinary summary is archived.
    assert.deepEqual(archived, ['summary-1'])
    assert.equal(archived.includes('belief-1'), false)
    assert.equal(result.archivedL2Count, 1)
  } finally {
    manager.stop()
  }
})
