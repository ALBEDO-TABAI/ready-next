import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAgentSystemStudioSnapshot } from '../main/modules/agent-control/agents/specialist-studio-read-model'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

const writer: AgentRegistryRecord = {
  id: 'writer', name: '写作历史资料', charter: '旧专项记录', personaRef: null, status: 'retired',
  parentAgentId: 'butler', derivationReason: null, mergedIntoAgentId: null,
  createdAt: '2026-06-19T00:00:00.000Z',
}

test('Studio read model contains only archived files, belief records, and file proposals', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-system-studio-archive-'))
  try {
    mkdirSync(join(root, 'agents', 'writer', 'knowledge'), { recursive: true })
    writeFileSync(join(root, 'agents', 'writer', 'RULES.md'), '# Writer\n旧规则。\n', 'utf8')
    writeFileSync(join(root, 'agents', 'writer', 'FOUNDATION.md'), '# Foundation\n旧基础资料。\n', 'utf8')
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.equal(store.writeCard({
      relPath: 'agents/writer/knowledge/style.md',
      frontmatter: {
        title: '旧写作资料', description: '短句优先', confidence: 'H', tag: 'knowledge',
        created: '2026-06-19', status: 'active',
      },
      body: '短句优先。',
    }).ok, true)
    const proposal = {
      proposalId: 'proposal-1', agentId: 'writer', targetKind: 'knowledge_card' as const,
      targetRelPath: 'agents/writer/knowledge/new.md', baseHash: 'base', baseContent: '',
      proposedContent: '新资料', status: 'staged' as const,
      provenance: { source: 'task_evolution' as const, sessionId: null, note: null },
      createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z', appliedAt: null,
    }
    const snapshot = buildAgentSystemStudioSnapshot({
      agents: [writer],
      store,
      listContentEditProposals: () => [proposal],
      now: new Date('2026-06-19T00:03:00.000Z'),
    })
    const archived = snapshot.agents[0]
    assert.equal(archived.rules.exists, true)
    assert.equal(archived.foundation.exists, true)
    assert.deepEqual(archived.knowledgeCards.map((card) => card.relPath), ['agents/writer/knowledge/style.md'])
    assert.equal(archived.contentSummary.stagedContentEdits, 1)
    assert.deepEqual(archived.contentEditProposals, [proposal])
    for (const key of ['routingCards', 'ownedTasks', 'readiness'] as const) {
      assert.equal(key in archived, false)
    }
    for (const key of ['derivationCandidates', 'stagedBlueprints', 'recentPrerouteTraces'] as const) {
      assert.equal(key in snapshot, false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
