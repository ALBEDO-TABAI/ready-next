import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  stageSpecialistTaskEvolutionProposal,
} from '../main/modules/agent-control/agents/specialist-task-evolution-proposals'
import { SpecialistContentEditProposalStore } from '../main/modules/agent-control/agents/specialist-content-edit-proposals'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { CheckInRecord } from '../main/modules/agent-control/quality/task-adjudicator'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

function agent(overrides: Partial<AgentRegistryRecord> = {}): AgentRegistryRecord {
  return {
    id: 'writer',
    name: 'Writer',
    charter: '写作专项',
    personaRef: null,
    status: 'active',
    parentAgentId: 'butler',
    derivationReason: null,
    mergedIntoAgentId: null,
    createdAt: '2026-06-20T00:00:00.000Z',
    ...overrides,
  }
}

function projection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskOrigin: 'user_root',
    taskType: 'short_task',
    module: 'agent',
    taskTitle: '写一版大纲',
    taskSummary: '用户确认了边界先行。',
    status: 'running',
    interactionState: 'running',
    steps: [],
    proofRefs: [{ kind: 'tool_result', ref: 'tool-ok' }],
    checkins: [],
    learningRefs: [{ title: '边界先行', summary: '同类任务先列清楚边界。' }],
    ownerAgentId: 'writer',
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:01:00.000Z',
    ...overrides,
  } as TaskProjectionRecord
}

function checkIn(overrides: Partial<CheckInRecord> = {}): CheckInRecord {
  return {
    kind: 'enforce',
    ts: '2026-06-20T00:01:00.000Z',
    verdict: 'accept',
    satisfiedCount: 1,
    totalCount: 1,
    proofCount: 1,
    blockers: [],
    ...overrides,
  }
}

function deps(root: string, agents: AgentRegistryRecord[]) {
  return {
    store: new BeliefCardStore({ memoryRoot: root }),
    proposalStore: new SpecialistContentEditProposalStore(),
    registry: { get: (id: string) => agents.find((item) => item.id === id) ?? null },
    getRunExecutionBinding: (runId: string) => binding('writer', runId),
  }
}

function binding(agentId: string, runId = 'run-1') {
  return {
    schemaVersion: 1 as const,
    runId,
    ownerAgentIdAtStart: agentId,
    runOrigin: 'initial' as const,
    kind: 'registered_agent' as const,
    requestedAgentId: agentId,
    effectiveAgentId: agentId,
    executionMaterialHash: `hash-${agentId}`,
    ownerAssignmentSource: 'conversation_active' as const,
    executionSelectionSource: 'task_owner' as const,
    resolutionKind: 'direct' as const,
  }
}

test('task evolution stages one owner specialist knowledge proposal from accepted task learning refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-task-evolution-'))
  try {
    const context = deps(root, [agent()])
    const result = stageSpecialistTaskEvolutionProposal({
      ...context,
      now: new Date('2026-06-20T00:02:00.000Z'),
    }, {
      projection: projection(),
      checkIn: checkIn(),
      terminalStatus: 'done',
      terminalReason: 'done',
    })
    assert.equal(result.status, 'staged')
    assert.equal(result.proposal.agentId, 'writer')
    assert.equal(result.proposal.targetKind, 'knowledge_card')
    assert.match(result.proposal.targetRelPath, /^agents\/writer\/knowledge\/task-evolution-task-1\.md$/)
    assert.equal(result.proposal.provenance.source, 'task_evolution')
    assert.equal(result.proposal.provenance.taskId, 'task-1')
    assert.match(result.proposal.proposedContent, /同类任务先列清楚边界/)
    assert.equal(context.store.readCard(result.proposal.targetRelPath), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('task evolution skips unsafe cases and deduplicates by task', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-task-evolution-'))
  try {
    const context = deps(root, [
      agent({ id: 'butler', name: 'Butler', parentAgentId: null }),
      agent({ id: 'retired-writer', status: 'retired' }),
      agent(),
    ])
    const base = {
      ...context,
      now: new Date('2026-06-20T00:02:00.000Z'),
    }
    const accepted = checkIn()
    assert.equal(stageSpecialistTaskEvolutionProposal({ ...base, getRunExecutionBinding: () => null }, {
      projection: projection({ ownerAgentId: null }),
      checkIn: accepted,
      terminalStatus: 'done',
    }).reason, 'missing_run_execution_binding')
    assert.equal(stageSpecialistTaskEvolutionProposal({ ...base, getRunExecutionBinding: () => binding('butler') }, {
      projection: projection({ ownerAgentId: 'butler' }),
      checkIn: accepted,
      terminalStatus: 'done',
    }).reason, 'execution_agent_not_active_specialist')
    assert.equal(stageSpecialistTaskEvolutionProposal({ ...base, getRunExecutionBinding: () => binding('retired-writer') }, {
      projection: projection({ ownerAgentId: 'retired-writer' }),
      checkIn: accepted,
      terminalStatus: 'done',
    }).reason, 'execution_agent_not_active_specialist')
    assert.equal(stageSpecialistTaskEvolutionProposal(base, {
      projection: projection({ learningRefs: [] }),
      checkIn: accepted,
      terminalStatus: 'done',
    }).reason, 'missing_learning_refs')
    assert.equal(stageSpecialistTaskEvolutionProposal(base, {
      projection: projection(),
      checkIn: checkIn({ verdict: 'reject', blockers: ['x'], satisfiedCount: 0 }),
      terminalStatus: 'done',
    }).reason, 'checkin_not_accept')
    assert.equal(stageSpecialistTaskEvolutionProposal(base, {
      projection: projection(),
      checkIn: accepted,
      terminalStatus: 'error',
    }).reason, 'terminal_status_not_success')
    assert.equal(stageSpecialistTaskEvolutionProposal(base, {
      projection: projection(), checkIn: accepted, terminalStatus: 'done', terminalReason: 'adjudication_degraded',
    }).reason, 'terminal_adjudication_degraded')
    assert.equal(stageSpecialistTaskEvolutionProposal({
      ...base,
      getRunExecutionBinding: () => ({
        schemaVersion: 1, runId: 'run-1', ownerAgentIdAtStart: 'writer', runOrigin: 'workflow_participant',
        kind: 'ephemeral', ephemeralRole: 'researcher', executionMaterialHash: 'ephemeral-hash',
        ownerAssignmentSource: 'parent_task', executionSelectionSource: 'ephemeral_role', resolutionKind: 'direct',
      }),
    }, { projection: projection(), checkIn: accepted, terminalStatus: 'done' }).reason, 'execution_not_registered_agent')
    assert.throws(() => stageSpecialistTaskEvolutionProposal({
      ...base,
      getRunExecutionBinding: () => ({ ...binding('writer'), executionMaterialHash: '' }),
    }, { projection: projection(), checkIn: accepted, terminalStatus: 'done' }), /incomplete execution binding/)

    const first = stageSpecialistTaskEvolutionProposal(base, {
      projection: projection(),
      checkIn: accepted,
      terminalStatus: 'done',
    })
    assert.equal(first.status, 'staged')
    const duplicate = stageSpecialistTaskEvolutionProposal(base, {
      projection: projection(),
      checkIn: accepted,
      terminalStatus: 'done',
    })
    assert.equal(duplicate.status, 'skipped')
    assert.equal(duplicate.reason, 'already_exists')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
