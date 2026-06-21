import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SPECIALIST_FOUNDATION_PACK_SECTIONS,
  SPECIALIST_FOUNDATION_PACK_VERSION,
  assertSpecialistBlueprintQualityPasses,
  evaluateSpecialistBlueprintQuality,
  renderSpecialistFoundationMarkdown,
} from '../main/modules/agent-control/agents/specialist-blueprint-quality'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

function blueprint(overrides: Partial<SpecialistAgentBlueprint> = {}): SpecialistAgentBlueprint {
  const base: SpecialistAgentBlueprint = {
    blueprintId: 'bp-visual-researcher',
    status: 'staged',
    inferredScope: {
      slug: 'visual-researcher',
      displayName: '视觉研究专项 Agent',
      domain: '视觉研究',
      routingTriggers: ['视觉研究', '参考整理'],
    },
    foundationDocs: {
      status: 'staged',
      charter: '负责视觉参考研究与素材归纳。',
      rulesText: '# 视觉研究专项 Agent\n- 保留来源引用。\n- 先收敛范围再输出。',
      knowledgeSeeds: [{ title: '引用要求', body: '所有参考结论都要保留来源。', evidenceRefs: ['user:0'] }],
      toolSafetyNotes: '外发、下载、写文件和长期记忆更新都必须等待用户确认。',
      foundationText: '# 视觉研究专项 Agent Foundation',
    },
    provenance: {
      userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
      sourceSessionId: 'session-1',
      sourceRunId: null,
      sourceMessageId: 'message-1',
      createdAt: '2026-06-20T00:00:00.000Z',
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
    intendedDomain: '视觉参考研究',
    nonGoals: ['不直接外发文件', '不替代主 agent 做最终决策'],
    recurringTasks: ['整理视觉参考', '比较风格方向'],
    requiredInputs: ['目标主题', '参考来源或约束'],
    expectedOutputs: ['参考清单', '风格边界建议'],
    routingTriggers: ['视觉研究', '参考整理'],
    routingActivateOnCreate: false,
    seedRulesText: '# 视觉研究专项 Agent\n- 保留来源引用。\n- 先收敛范围再输出。',
    knowledgeSeeds: [{ title: '引用要求', body: '所有参考结论都要保留来源。', evidenceRefs: ['user:0'] }],
    migrationCandidates: [],
    toolSafetyNotes: '外发、下载、写文件和长期记忆更新都必须等待用户确认。',
    source: 'conversation',
    userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [],
  }
  return { ...base, ...overrides }
}

test('specialist blueprint quality passes for a concrete foundation', () => {
  const evaluation = evaluateSpecialistBlueprintQuality(blueprint())
  assert.equal(evaluation.passed, true)
  assert.deepEqual(evaluation.blockingIssueIds, [])
  assert.doesNotThrow(() => assertSpecialistBlueprintQualityPasses(blueprint()))
})

test('specialist blueprint quality catches hollow generic foundations', () => {
  const evaluation = evaluateSpecialistBlueprintQuality(blueprint({
    charter: '按用户要求工作',
    rolePersona: '根据用户需求处理任务',
    nonGoals: ['不做无关任务'],
    recurringTasks: ['相关任务'],
    requiredInputs: ['任务'],
    expectedOutputs: ['输出结果'],
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

  assert.equal(evaluation.passed, false)
  assert.ok(evaluation.blockingIssueIds.includes('charter'))
  assert.ok(evaluation.blockingIssueIds.includes('toolBoundaries'))
  assert.throws(() => assertSpecialistBlueprintQualityPasses(blueprint({
    charter: '按用户要求工作',
  })), /blocking issues/)
})

test('specialist blueprint quality rejects wordy foundations that never land on the specialist domain', () => {
  const evaluation = evaluateSpecialistBlueprintQuality(blueprint({
    intendedDomain: '视觉参考研究',
    routingTriggers: ['视觉研究'],
    charter: '负责把长期出现的问题拆解为稳定流程，整理判断依据，并输出结构化建议供后续复用。',
    rolePersona: '以专业顾问的姿态工作，先确认问题背景，再归纳关键判断，并保持清晰克制的沟通方式。',
    mainVsSpecialistSplit: '主 agent 保留目标判断和最终取舍，该专项 agent 负责重复性的资料处理、判断整理和交付物草拟。',
    seedRulesText: '# 专项 Agent\n- 先确认任务背景。\n- 再整理依据和约束。\n- 最后输出结构化建议。',
    taskExamples: {
      suitable: ['整理一组资料并提炼判断方向'],
      unsuitable: ['代表用户直接发布内容或外发文件'],
    },
    recurringTasks: ['整理资料依据', '比较判断方向'],
    expectedOutputs: ['结构化建议', '可复用清单'],
  }))

  assert.equal(evaluation.passed, false)
  assert.ok(evaluation.blockingIssueIds.includes('professionalSpecificity'))
})

test('specialist foundation markdown renders the reviewable foundation artifact', () => {
  const markdown = renderSpecialistFoundationMarkdown(blueprint())
  assert.match(markdown, /# 视觉研究专项 Agent Foundation/)
  assert.match(markdown, new RegExp(`Foundation pack: ${SPECIALIST_FOUNDATION_PACK_VERSION}`))
  for (const section of SPECIALIST_FOUNDATION_PACK_SECTIONS) {
    assert.match(markdown, new RegExp(section.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(markdown, /## Operating Model/)
  assert.match(markdown, /## Tool Boundaries/)
  assert.match(markdown, /browser: confirm/)
  assert.match(markdown, /## Memory\/Profile Policy/)
  assert.match(markdown, /## Quality Checks/)
})
