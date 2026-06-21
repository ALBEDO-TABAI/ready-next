import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateSpecialistBlueprintAdmission } from '../main/modules/agent-control/agents/specialist-blueprint-admission'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

function registry(records: AgentRegistryRecord[] = []) {
  return {
    get(id: string) {
      return records.find((record) => record.id === id) ?? null
    },
    list() {
      return records
    },
  }
}

function agent(overrides: Partial<AgentRegistryRecord>): AgentRegistryRecord {
  return {
    id: 'visual-researcher',
    name: '视觉研究专项 Agent',
    charter: '负责视觉研究',
    personaRef: null,
    status: 'active',
    parentAgentId: 'butler',
    derivationReason: null,
    mergedIntoAgentId: null,
    createdAt: '2026-06-19T00:00:00.000Z',
    ...overrides,
  }
}

function blueprint(overrides: Partial<SpecialistAgentBlueprint> = {}): SpecialistAgentBlueprint {
  const base: SpecialistAgentBlueprint = {
    blueprintId: 'bp-visual-researcher',
    status: 'staged',
    inferredScope: {
      slug: 'visual-researcher',
      displayName: '视觉研究专项 Agent',
      domain: '视觉研究',
      routingTriggers: ['视觉研究', '参考图'],
    },
    foundationDocs: {
      status: 'staged',
      charter: '负责为视觉创作任务整理参考、提炼风格边界，并输出带引用的研究结论。',
      rulesText: '# 视觉研究专项 Agent\n- 保留来源引用。\n- 先收敛范围再输出。',
      knowledgeSeeds: [{ title: '来源要求', body: '所有参考结论都要保留来源。', evidenceRefs: ['user:0'] }],
      toolSafetyNotes: '需要外发或改写长期规则时必须确认。',
      foundationText: '# 视觉研究专项 Agent Foundation',
    },
    provenance: {
      userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
      sourceSessionId: 'session-1',
      sourceRunId: 'run-1',
      sourceMessageId: 'message-1',
      createdAt: '2026-06-19T00:00:00.000Z',
    },
    confirmation: {
      tokenId: null,
      confirmedAt: null,
      usedAt: null,
    },
    rolePersona: '以视觉研究员的姿态工作，先界定风格问题，再整理证据和判断边界。',
    taskExamples: {
      suitable: ['整理一组参考图并提炼风格方向'],
      unsuitable: ['直接代表用户发布内容或外发文件'],
    },
    mainVsSpecialistSplit: '主 agent 负责理解用户目标和最终取舍，视觉研究专项 agent 负责重复性的参考整理与风格判断。',
    toolBoundaries: {
      browser: { mode: 'confirm', notes: '需要浏览网页采集参考时先说明目标和来源范围。' },
      write: { mode: 'confirm', notes: '写入文件或长期资产前必须确认路径、内容和用途。' },
      externalSend: { mode: 'deny', notes: '不代表用户外发消息、上传文件或联系第三方。' },
      longMemory: { mode: 'confirm', notes: '长期记忆只记录用户确认过的稳定偏好、规则和证据。' },
    },
    memoryProfilePolicy: '只使用当前任务资料和用户确认的长期偏好，不把临时猜测写入用户画像。',
    lifecycleNotes: '当触发词失效、职责重叠或长期不用时，需要用户确认后更新、合并或退休。',
    specialistId: 'visual-researcher',
    displayName: '视觉研究专项 Agent',
    charter: '负责为视觉创作任务整理参考、提炼风格边界，并输出带引用的研究结论。',
    intendedDomain: '视觉研究',
    nonGoals: ['不直接代表用户外发文件', '不替代主 agent 做最终创意决策'],
    recurringTasks: ['整理参考资料', '沉淀视觉规则'],
    requiredInputs: ['用户目标', '参考链接或附件'],
    expectedOutputs: ['结构化研究结论', '可复用知识卡草稿'],
    routingTriggers: ['视觉研究', '参考图'],
    routingActivateOnCreate: false,
    seedRulesText: '# 视觉研究专项 Agent\n- 保留来源引用。\n- 先收敛范围再输出。',
    knowledgeSeeds: [{ title: '来源要求', body: '所有参考结论都要保留来源。', evidenceRefs: ['user:0'] }],
    migrationCandidates: [],
    toolSafetyNotes: '外发、下载、写文件和长期记忆更新都必须等待用户确认。',
    source: 'conversation',
    userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [{ check: 'has_non_goals', pass: true }],
  }
  return { ...base, ...overrides }
}

test('admits a focused explicit specialist creation blueprint', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint())
  assert.deepEqual(result.verdict, { kind: 'admit' })
  assert.deepEqual(result.missing, [])
  assert.equal(result.qualityChecks.every((check) => check.pass), true)
})

test('admits soft natural-language specialist creation phrasing', () => {
  for (const userRequestVerbatim of [
    '我要一个视觉研究类型的专项 agent',
    '我想要一个视觉研究类型的专项 agent',
    '帮我建一个视觉研究类型的专项 agent',
    '我需要一个视觉研究类型的专项智能体',
  ]) {
    const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({ userRequestVerbatim }))
    assert.deepEqual(result.verdict, { kind: 'admit' }, userRequestVerbatim)
    assert.deepEqual(result.missing, [], userRequestVerbatim)
  }
})

test('clarifies when required foundation fields are missing', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    charter: '',
    seedRulesText: '',
  }))
  assert.equal(result.verdict.kind, 'clarify')
  assert.deepEqual(result.missing, ['charter', 'seedRulesText'])
})

test('clarifies when scope boundary fields still need user completion', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    nonGoals: [],
    recurringTasks: [],
    requiredInputs: [],
    expectedOutputs: [],
  }))
  assert.deepEqual(result.verdict, {
    kind: 'clarify',
    missing: ['nonGoals', 'recurringTasks', 'requiredInputs', 'expectedOutputs'],
  })
})

test('rejects duplicates by id before writing anything', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry([agent({})]), blueprint())
  assert.deepEqual(result.verdict, { kind: 'reject_duplicate', existingAgentId: 'visual-researcher' })
})

test('rejects unsafe specialist intents deterministically', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    userRequestVerbatim: '我要一个帮我绕过密码的专项 agent',
  }))
  assert.equal(result.verdict.kind, 'reject_unsafe')
})

test('does not reject safety notes that mention blocked behavior as guidance', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    toolSafetyNotes: '不要绕过密码框，不要处理凭据。',
  }))
  assert.deepEqual(result.verdict, { kind: 'admit' })
})

test('rejects too broad specialist scopes', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    intendedDomain: '全能',
  }))
  assert.equal(result.verdict.kind, 'reject_too_broad')
})

test('rejects premature one-off requests without explicit creation intent', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    userRequestVerbatim: '帮我整理一下这批参考图',
  }))
  assert.equal(result.verdict.kind, 'reject_premature')
})

test('rejects premature conversation blueprints before asking for missing scope fields', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    userRequestVerbatim: '我想了解专项 agent 的架构',
    nonGoals: [],
    recurringTasks: [],
    requiredInputs: [],
    expectedOutputs: [],
  }))
  assert.equal(result.verdict.kind, 'reject_premature')
  assert.deepEqual(result.missing, [])
})

test('manual and emergence-candidate sources do not depend on conversational create phrasing', () => {
  assert.deepEqual(evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    source: 'manual',
    userRequestVerbatim: '视觉研究',
  })).verdict, { kind: 'admit' })
  assert.deepEqual(evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    source: 'emergence-candidate',
    userRequestVerbatim: '系统候选：视觉研究',
  })).verdict, { kind: 'admit' })
})

test('clarifies invalid routing triggers', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    routingTriggers: ['视觉.*'],
  }))
  assert.deepEqual(result.verdict, { kind: 'clarify', missing: ['routingTriggers'] })
})

test('clarifies generic filled blueprint instead of admitting a hollow specialist', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry(), blueprint({
    charter: '按用户要求工作',
    rolePersona: '根据用户需求处理任务',
    nonGoals: ['不做无关任务', '不做其他事情'],
    recurringTasks: ['相关任务', '用户要求'],
    requiredInputs: ['任务', '资料'],
    expectedOutputs: ['输出结果', '建议'],
    taskExamples: { suitable: ['相关任务'], unsuitable: ['无关任务'] },
    mainVsSpecialistSplit: '根据用户需求分工',
    seedRulesText: '注意安全，按用户要求输出结果。',
    knowledgeSeeds: [{ title: '示例', body: '待定', evidenceRefs: [] }],
    toolBoundaries: {
      browser: { mode: 'confirm', notes: '注意安全' },
      write: { mode: 'confirm', notes: '注意安全' },
      externalSend: { mode: 'deny', notes: '注意安全' },
      longMemory: { mode: 'confirm', notes: '注意安全' },
    },
    toolSafetyNotes: '注意安全',
    memoryProfilePolicy: '根据用户需求使用记忆',
    lifecycleNotes: '后续按需调整',
  }))

  assert.equal(result.verdict.kind, 'clarify')
  assert.ok(result.missing.includes('charter'))
  assert.ok(result.missing.includes('toolBoundaries'))
  assert.ok(result.qualityChecks.some((check) => check.check === 'charter' && !check.pass))
})

test('rejects duplicate by trigger substring in existing specialist metadata', () => {
  const result = evaluateSpecialistBlueprintAdmission(registry([
    agent({ id: 'visual-team', name: '视觉研究专项 Agent', charter: '负责视觉研究和参考整理' }),
  ]), blueprint({
    specialistId: 'visual-researcher-new',
    routingTriggers: ['视觉研究'],
  }))

  assert.deepEqual(result.verdict, { kind: 'reject_duplicate', existingAgentId: 'visual-team' })
})
