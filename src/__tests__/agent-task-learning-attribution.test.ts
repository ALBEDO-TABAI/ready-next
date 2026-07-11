import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stageSpecialistTaskEvolutionProposal } from '../main/modules/agent-control/agents/specialist-task-evolution-proposals'
import { SpecialistContentEditProposalStore } from '../main/modules/agent-control/agents/specialist-content-edit-proposals'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

test('accepted registered workflow contribution stages learning for the contributor only', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-contribution-learning-'))
  try {
    const binding = {
      schemaVersion: 1 as const, runId: 'child-run', ownerAgentIdAtStart: 'butler', runOrigin: 'workflow_participant' as const,
      kind: 'registered_agent' as const, requestedAgentId: 'analyst', effectiveAgentId: 'analyst',
      executionMaterialHash: 'analyst-hash', ownerAssignmentSource: 'parent_task' as const,
      executionSelectionSource: 'task_owner' as const, resolutionKind: 'direct' as const,
    }
    const projection = {
      taskId: 'child-task', scopeId: 'scope', runId: 'child-run', taskOrigin: 'workflow_child', taskType: 'research',
      module: 'agent', taskTitle: '事实核验', taskSummary: '贡献已被父任务采用', status: 'completed',
      interactionState: 'running', steps: [], ownerAgentId: 'analyst', executionBinding: binding,
      proofRefs: [{ kind: 'artifact', ref: 'proof-1' }], learningRefs: [{ kind: 'artifact', ref: 'proof-1' }],
      createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:01:00.000Z',
    } as TaskProjectionRecord
    const result = stageSpecialistTaskEvolutionProposal({
      store: new BeliefCardStore({ memoryRoot: root }),
      proposalStore: new SpecialistContentEditProposalStore(),
      registry: { get: (id: string) => id === 'analyst' ? {
        id: 'analyst', name: 'Analyst', charter: '研究', personaRef: null, status: 'active', parentAgentId: 'butler',
        derivationReason: null, mergedIntoAgentId: null, createdAt: '2026-07-11T00:00:00.000Z',
      } : null },
      getRunExecutionBinding: () => binding,
    }, {
      projection,
      checkIn: { kind: 'enforce', ts: '2026-07-11T00:01:00.000Z', verdict: 'accept', satisfiedCount: 1, totalCount: 1, proofCount: 1, blockers: [] },
      terminalStatus: 'completed',
      allowWorkflowContribution: true,
    })
    assert.equal(result.status, 'staged')
    assert.equal(result.proposal.agentId, 'analyst')
    assert.match(result.proposal.targetRelPath, /^agents\/analyst\/knowledge\//)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
