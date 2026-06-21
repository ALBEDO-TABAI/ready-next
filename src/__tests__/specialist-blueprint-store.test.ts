import assert from 'node:assert/strict'
import test from 'node:test'

import { SpecialistBlueprintStore } from '../main/modules/agent-control/agents/specialist-blueprint-store'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

function blueprint(overrides: Partial<SpecialistAgentBlueprint> = {}): SpecialistAgentBlueprint {
  return {
    blueprintId: 'bp-visual',
    status: 'staged',
    inferredScope: { slug: 'visual', displayName: '视觉专项', domain: '视觉', routingTriggers: ['视觉'] },
    foundationDocs: { status: 'staged', charter: '视觉', rulesText: 'rules', knowledgeSeeds: [], toolSafetyNotes: 'none', foundationText: '# 视觉专项 Foundation' },
    provenance: { userRequestVerbatim: '我要一个视觉专项 agent', sourceSessionId: 's1', sourceRunId: null, sourceMessageId: null, createdAt: '2026-06-19T00:00:00.000Z' },
    confirmation: { tokenId: null, confirmedAt: null, usedAt: null },
    rolePersona: '以视觉研究员的姿态整理参考、判断风格边界和保留证据。',
    taskExamples: { suitable: ['整理视觉参考并提炼方向'], unsuitable: ['代表用户发布视觉内容'] },
    mainVsSpecialistSplit: '主 agent 负责理解目标和最终决策，视觉专项负责重复性参考整理。',
    toolBoundaries: {
      browser: { mode: 'confirm', notes: '浏览网页前先确认来源范围。' },
      write: { mode: 'confirm', notes: '写入文件前必须确认路径和内容。' },
      externalSend: { mode: 'deny', notes: '不代表用户外发消息或文件。' },
      longMemory: { mode: 'confirm', notes: '长期记忆只记录用户确认过的稳定偏好。' },
    },
    memoryProfilePolicy: '只使用当前任务和确认过的长期偏好，不保存临时猜测。',
    lifecycleNotes: '当触发词失效、职责重叠或长期不用时，经确认后更新或退休。',
    specialistId: 'visual',
    displayName: '视觉专项',
    charter: '视觉',
    intendedDomain: '视觉',
    nonGoals: ['不外发'],
    recurringTasks: ['整理'],
    requiredInputs: ['目标'],
    expectedOutputs: ['结论'],
    routingTriggers: ['视觉'],
    routingActivateOnCreate: false,
    seedRulesText: 'rules',
    knowledgeSeeds: [],
    migrationCandidates: [],
    toolSafetyNotes: 'none',
    source: 'conversation',
    userRequestVerbatim: '我要一个视觉专项 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [],
    ...overrides,
  }
}

test('SpecialistBlueprintStore stores cloned blueprints and filters by status', () => {
  const store = new SpecialistBlueprintStore()
  const original = blueprint()
  const saved = store.upsert(original)
  saved.displayName = 'mutated'
  original.displayName = 'also-mutated'

  assert.equal(store.get('bp-visual')?.displayName, '视觉专项')
  store.patch('bp-visual', { status: 'rejected' })
  assert.deepEqual(store.list(['staged']), [])
  assert.equal(store.list(['rejected'])[0].status, 'rejected')
})

test('SpecialistBlueprintStore rejects empty ids and missing patch targets', () => {
  const store = new SpecialistBlueprintStore()
  assert.throws(() => store.upsert(blueprint({ blueprintId: '' })), /blueprintId/)
  assert.throws(() => store.patch('missing', { status: 'expired' }), /not found/)
})

test('SpecialistBlueprintStore DB mode fails writes loudly when DB is unavailable', () => {
  const store = new SpecialistBlueprintStore({ getRawDb: () => null })
  assert.deepEqual(store.list(['staged']), [])
  assert.equal(store.get('bp-visual'), null)
  assert.throws(() => store.upsert(blueprint()), /database not available/)
  assert.throws(() => store.patch('bp-visual', { status: 'confirmed' }), /database not available/)
})
