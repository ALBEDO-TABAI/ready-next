import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  confirmSpecialistContentEdit,
  rejectSpecialistContentEdit,
  SpecialistContentEditProposalStore,
  stageSpecialistContentEdit,
} from '../main/modules/agent-control/agents/specialist-content-edit-proposals'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

function fm(overrides: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '写作知识',
    description: '写作 agent 的长期知识',
    confidence: 'H',
    tag: 'knowledge',
    created: '2026-06-20',
    status: 'active',
    ...overrides,
  }
}

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

function deps(root: string, agents: AgentRegistryRecord[]) {
  const store = new BeliefCardStore({ memoryRoot: root })
  const proposalStore = new SpecialistContentEditProposalStore()
  return {
    store,
    proposalStore,
    registry: { get: (id: string) => agents.find((entry) => entry.id === id) ?? null },
  }
}

test('specialist content edit proposal stages and confirms RULES edits with CAS', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-content-edit-'))
  try {
    mkdirSync(join(root, 'agents', 'writer'), { recursive: true })
    writeFileSync(join(root, 'agents', 'writer', 'RULES.md'), '# Writer\n\n- 只处理写作任务。\n', 'utf8')
    const context = deps(root, [agent()])

    const proposal = stageSpecialistContentEdit(context, {
      agentId: 'writer',
      targetKind: 'rules',
      proposedContent: '# Writer\n\n- 只处理写作任务。\n- 每次输出前先列边界。\n',
      sessionId: 'studio',
    })
    assert.equal(proposal.status, 'staged')
    assert.equal(context.proposalStore.listForAgent('writer').length, 1)

    const applied = confirmSpecialistContentEdit(context, proposal.proposalId)
    assert.equal(applied.status, 'applied')
    assert.match(readFileSync(join(root, 'agents', 'writer', 'RULES.md'), 'utf8'), /每次输出前先列边界/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('specialist content edit proposal marks conflict instead of overwriting changed content', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-content-edit-'))
  try {
    mkdirSync(join(root, 'agents', 'writer'), { recursive: true })
    writeFileSync(join(root, 'agents', 'writer', 'RULES.md'), '# Writer\n\n- 只处理写作任务。\n', 'utf8')
    const context = deps(root, [agent()])
    const proposal = stageSpecialistContentEdit(context, {
      agentId: 'writer',
      targetKind: 'rules',
      proposedContent: '# Writer\n\n- 新提案。\n',
    })
    writeFileSync(join(root, 'agents', 'writer', 'RULES.md'), '# Writer\n\n- 外部改动。\n', 'utf8')

    const conflict = confirmSpecialistContentEdit(context, proposal.proposalId)
    assert.equal(conflict.status, 'conflict')
    assert.match(readFileSync(join(root, 'agents', 'writer', 'RULES.md'), 'utf8'), /外部改动/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('specialist content edit proposal edits knowledge card body through BeliefCardStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-content-edit-'))
  try {
    const context = deps(root, [agent()])
    assert.ok(context.store.writeCard({
      relPath: 'agents/writer/knowledge/style.md',
      frontmatter: fm(),
      body: '短句优先。',
    }).ok)
    const proposal = stageSpecialistContentEdit(context, {
      agentId: 'writer',
      targetKind: 'knowledge_card',
      targetRelPath: 'agents/writer/knowledge/style.md',
      proposedContent: '短句优先，先列边界。',
    })
    const applied = confirmSpecialistContentEdit(context, proposal.proposalId)
    assert.equal(applied.status, 'applied')
    assert.equal(context.store.readCard('agents/writer/knowledge/style.md', { includeStaged: true })?.body, '短句优先，先列边界。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('task evolution content proposal can create a new agent knowledge card only after confirmation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-content-edit-'))
  try {
    const context = deps(root, [agent()])
    const proposal = context.proposalStore.upsert({
      proposalId: 'sce_task_writer_1',
      agentId: 'writer',
      targetKind: 'knowledge_card',
      targetRelPath: 'agents/writer/knowledge/task-evolution-task-1.md',
      baseHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      baseContent: '',
      proposedContent: '以后同类任务先列边界。',
      status: 'staged',
      provenance: {
        source: 'task_evolution',
        sessionId: 'scope-1',
        note: 'done',
        taskId: 'task-1',
        runId: 'run-1',
        scopeId: 'scope-1',
        taskTitle: '写一版大纲',
        taskSummary: '用户确认了边界先行。',
      },
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
      appliedAt: null,
    })

    assert.equal(context.store.readCard(proposal.targetRelPath), null)
    const applied = confirmSpecialistContentEdit({
      ...context,
      now: new Date('2026-06-20T00:01:00.000Z'),
    }, proposal.proposalId)
    assert.equal(applied.status, 'applied')
    const card = context.store.readCard(proposal.targetRelPath)
    assert.equal(card?.frontmatter.status, 'active')
    assert.equal(card?.frontmatter.source, 'task:task-1')
    assert.equal(card?.body, '以后同类任务先列边界。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('manual content proposal still cannot create a missing knowledge card', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-content-edit-'))
  try {
    const context = deps(root, [agent()])
    assert.throws(() => stageSpecialistContentEdit(context, {
      agentId: 'writer',
      targetKind: 'knowledge_card',
      targetRelPath: 'agents/writer/knowledge/new-card.md',
      proposedContent: 'x',
    }), /knowledge card not found/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('specialist content edit proposal rejects main, retired, and rejected staged proposal resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-content-edit-'))
  try {
    const context = deps(root, [
      agent({ id: 'butler', name: '管家', parentAgentId: null }),
      agent({ id: 'retired-writer', status: 'retired' }),
      agent(),
    ])
    assert.throws(() => stageSpecialistContentEdit(context, {
      agentId: 'butler',
      targetKind: 'rules',
      proposedContent: 'x',
    }), /main agent is read-only/)
    assert.throws(() => stageSpecialistContentEdit(context, {
      agentId: 'retired-writer',
      targetKind: 'rules',
      proposedContent: 'x',
    }), /only active specialist/)

    const proposal = stageSpecialistContentEdit(context, {
      agentId: 'writer',
      targetKind: 'foundation',
      proposedContent: '# Foundation\n',
    })
    const rejected = rejectSpecialistContentEdit(context, proposal.proposalId)
    assert.equal(rejected.status, 'rejected')
    assert.throws(() => confirmSpecialistContentEdit(context, proposal.proposalId), /only staged proposals/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
