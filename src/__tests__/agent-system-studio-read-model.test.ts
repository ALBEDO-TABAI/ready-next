import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAgentSystemStudioSnapshot } from '../main/modules/agent-control/agents/specialist-studio-read-model'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

function fm(overrides: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '写作知识',
    description: '写作 agent 的长期知识',
    confidence: 'H',
    tag: 'knowledge',
    created: '2026-06-19',
    status: 'active',
    ...overrides,
  }
}

function agent(overrides: Partial<AgentRegistryRecord>): AgentRegistryRecord {
  return {
    id: 'writer',
    name: 'Writer',
    charter: '写作专项',
    personaRef: null,
    status: 'active',
    parentAgentId: 'butler',
    derivationReason: null,
    mergedIntoAgentId: null,
    createdAt: '2026-06-19T00:00:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'short_task',
    module: 'agent',
    taskTitle: '写一版大纲',
    taskSummary: '写作任务',
    status: 'blocked',
    interactionState: null,
    waitingFor: 'none',
    steps: [],
    currentStepId: null,
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: null,
    resumableActions: [],
    continuationRef: null,
    progress: null,
    recentArtifacts: [],
    criteria: null,
    checkins: [],
    proofRefs: [],
    learningRefs: [],
    ownerAgentId: 'writer',
    packetRole: null,
    contextRefs: [],
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:01:00.000Z',
    ...overrides,
  } as TaskProjectionRecord
}

function blueprint(): SpecialistAgentBlueprint {
  return {
    blueprintId: 'bp-editor',
    status: 'staged',
    inferredScope: { slug: 'editor', displayName: '编辑专项 Agent', domain: '编辑', routingTriggers: ['编辑'] },
    foundationDocs: { status: 'staged', charter: '编辑任务', rulesText: 'rules', knowledgeSeeds: [], toolSafetyNotes: 'none', foundationText: '# 编辑专项 Foundation' },
    provenance: { userRequestVerbatim: '我要一个编辑专项 agent', sourceSessionId: 's1', sourceRunId: null, sourceMessageId: null, createdAt: '2026-06-19T00:00:00.000Z' },
    confirmation: { tokenId: null, confirmedAt: null, usedAt: null },
    rolePersona: '以编辑助理的姿态检查文稿结构、措辞和交付边界。',
    taskExamples: { suitable: ['修改一段文稿并给出理由'], unsuitable: ['代表用户外发定稿'] },
    mainVsSpecialistSplit: '主 agent 负责理解目标和最终选择，编辑专项负责重复性的文稿检查。',
    toolBoundaries: {
      browser: { mode: 'deny', notes: '编辑专项默认不需要浏览网页。' },
      write: { mode: 'confirm', notes: '写入文件前必须确认路径和内容。' },
      externalSend: { mode: 'deny', notes: '不代表用户外发消息或文件。' },
      longMemory: { mode: 'confirm', notes: '长期记忆只记录用户确认过的写作偏好。' },
    },
    memoryProfilePolicy: '只使用用户确认过的写作偏好，不沉淀临时修改猜测。',
    lifecycleNotes: '当编辑范围变化、长期不用或职责重叠时，经用户确认后更新或退休。',
    specialistId: 'editor',
    displayName: '编辑专项 Agent',
    charter: '编辑任务',
    intendedDomain: '编辑',
    nonGoals: ['不外发'],
    recurringTasks: ['编辑文案'],
    requiredInputs: ['文稿'],
    expectedOutputs: ['修改建议'],
    routingTriggers: ['编辑'],
    routingActivateOnCreate: false,
    seedRulesText: 'rules',
    knowledgeSeeds: [],
    migrationCandidates: [],
    toolSafetyNotes: 'none',
    source: 'manual',
    userRequestVerbatim: '我要一个编辑专项 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [],
  }
}

test('Agent System Studio read model aggregates agents, content, routing, owner tasks, candidates, and traces', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-system-studio-'))
  try {
    mkdirSync(join(root, 'agents', 'writer'), { recursive: true })
    writeFileSync(join(root, 'agents', 'writer', 'RULES.md'), '# Writer\n\n- 只处理写作任务。\n', 'utf8')
    writeFileSync(join(root, 'agents', 'writer', 'FOUNDATION.md'), '# Writer Foundation\n\n写作专项基础文档。\n', 'utf8')
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'agents/writer/knowledge/style.md',
      frontmatter: fm(),
      body: '短句优先。',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/routing-writer.md',
      frontmatter: fm({ title: '路由：写作', description: '写作请求交给 writer', tag: 'self', triggers: ['写作'] }),
      body: 'x',
    }).ok)

    const snapshot = buildAgentSystemStudioSnapshot({
      agents: [
        agent({ id: 'butler', name: 'Butler', charter: '主 agent', parentAgentId: null }),
        agent({ id: 'writer' }),
      ],
      store,
      listOwnedTasks: (agentId) => agentId === 'writer' ? [task({})] : [],
      derivationCandidates: [{
        candidateRelPath: 'knowledge/agent-candidate-editor.md',
        title: '专项 agent 候选：编辑',
        description: '编辑领域重复出现',
        defaultSpecialistId: 'editor',
        defaultName: '编辑专项 Agent',
        defaultRoutingTriggers: ['编辑'],
      }],
      stagedBlueprints: [blueprint()],
      recentPrerouteTraces: [{
        id: 'trace-1',
        createdAt: '2026-06-19T00:02:00.000Z',
        firstMessagePreview: '写作大纲',
        mode: 'suggest',
        effect: 'suggest',
        decisionTier: 'precedent',
        targetAgentId: 'writer',
        reasons: ['suggest_only'],
      }],
      now: new Date('2026-06-19T00:03:00.000Z'),
    })

    const writer = snapshot.agents.find((item) => item.id === 'writer')
    assert.ok(writer)
    assert.equal(writer!.rules.exists, true)
    assert.match(writer!.rules.content || '', /只处理写作任务/)
    assert.equal(typeof writer!.rules.contentHash, 'string')
    assert.equal(writer!.foundation.exists, true)
    assert.match(writer!.foundation.content || '', /写作专项基础文档/)
    assert.equal(writer!.knowledgeCards[0].relPath, 'agents/writer/knowledge/style.md')
    assert.equal(writer!.knowledgeCards[0].body, '短句优先。')
    assert.equal(writer!.routingCards[0].targetAgentId, 'writer')
    assert.equal(writer!.ownedTasks[0].taskId, 'task-1')
    assert.equal(writer!.contentSummary.knowledgeCards, 1)
    assert.equal(writer!.contentEditProposals.length, 0)
    assert.equal(snapshot.derivationCandidates[0].defaultSpecialistId, 'editor')
    assert.equal(snapshot.stagedBlueprints[0].blueprintId, 'bp-editor')
    assert.deepEqual(snapshot.recentPrerouteTraces[0].reasons, ['suggest_only'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
