import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SPECIALIST_FOUNDATION_SEMANTIC_ISSUES,
  SPECIALIST_BLUEPRINT_SOURCE_MESSAGE_UNAVAILABLE_REASONS,
  SPECIALIST_BLUEPRINT_REQUIRED_FIELDS,
  isSpecialistBlueprintAdmissionVerdict,
  isSpecialistBlueprintSourceMessageUnavailableReason,
  isSpecialistBlueprintSource,
  isSpecialistBlueprintStatus,
  isSpecialistFoundationSemanticIssueId,
  validateSpecialistAgentBlueprintShape,
  type SpecialistAgentBlueprint,
} from '../shared/agent-specialist-blueprint'

function blueprint(overrides: Partial<SpecialistAgentBlueprint> = {}): SpecialistAgentBlueprint {
  return {
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
      charter: '负责视觉参考研究与素材归纳。',
      rulesText: '优先保留用户原话与来源证据。',
      knowledgeSeeds: [{ title: '来源要求', body: '保留引用来源。', evidenceRefs: ['user:0'] }],
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
    charter: '负责视觉参考研究与素材归纳。',
    intendedDomain: '视觉研究',
    nonGoals: ['不直接代表用户外发文件', '不替代主 agent 做最终创意决策'],
    recurringTasks: ['整理参考资料', '沉淀视觉规则'],
    requiredInputs: ['用户目标', '参考链接或附件'],
    expectedOutputs: ['结构化研究结论', '可复用知识卡草稿'],
    routingTriggers: ['视觉研究', '参考图'],
    routingActivateOnCreate: false,
    seedRulesText: '优先保留用户原话与来源证据。',
    knowledgeSeeds: [{ title: '来源要求', body: '保留引用来源。', evidenceRefs: ['user:0'] }],
    migrationCandidates: [],
    toolSafetyNotes: '需要外发或改写长期规则时必须确认。',
    source: 'conversation',
    userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [{ check: 'has_non_goals', pass: true }],
    ...overrides,
  }
}

test('specialist blueprint required field list covers the full agreed schema', () => {
  assert.deepEqual(SPECIALIST_BLUEPRINT_REQUIRED_FIELDS, [
    'blueprintId',
    'status',
    'inferredScope',
    'foundationDocs',
    'provenance',
    'confirmation',
    'rolePersona',
    'taskExamples',
    'mainVsSpecialistSplit',
    'toolBoundaries',
    'memoryProfilePolicy',
    'lifecycleNotes',
    'specialistId',
    'displayName',
    'charter',
    'intendedDomain',
    'nonGoals',
    'recurringTasks',
    'requiredInputs',
    'expectedOutputs',
    'routingTriggers',
    'routingActivateOnCreate',
    'seedRulesText',
    'knowledgeSeeds',
    'migrationCandidates',
    'toolSafetyNotes',
    'source',
    'userRequestVerbatim',
    'clarificationAnswers',
    'admissionVerdict',
    'qualityChecks',
  ])
})

test('specialist blueprint source is closed to the three intake paths', () => {
  assert.equal(isSpecialistBlueprintSource('conversation'), true)
  assert.equal(isSpecialistBlueprintSource('manual'), true)
  assert.equal(isSpecialistBlueprintSource('emergence-candidate'), true)
  assert.equal(isSpecialistBlueprintSource('handoff'), false)
})

test('specialist blueprint admission verdict vocabulary is closed', () => {
  assert.equal(isSpecialistBlueprintAdmissionVerdict({ kind: 'admit' }), true)
  assert.equal(isSpecialistBlueprintAdmissionVerdict({ kind: 'clarify', missing: ['nonGoals'] }), true)
  assert.equal(isSpecialistBlueprintAdmissionVerdict({ kind: 'reject_duplicate', existingAgentId: 'visual' }), true)
  assert.equal(isSpecialistBlueprintAdmissionVerdict({ kind: 'reject_unsafe', reason: 'external send' }), true)
  assert.equal(isSpecialistBlueprintAdmissionVerdict({ kind: 'reject_too_broad', reason: 'too broad' }), true)
  assert.equal(isSpecialistBlueprintAdmissionVerdict({ kind: 'reject_premature', reason: 'no evidence' }), true)
  assert.equal(isSpecialistBlueprintAdmissionVerdict({ kind: 'route' }), false)
})

test('specialist blueprint status vocabulary is closed', () => {
  assert.equal(isSpecialistBlueprintStatus('draft'), true)
  assert.equal(isSpecialistBlueprintStatus('needs_clarification'), true)
  assert.equal(isSpecialistBlueprintStatus('staged'), true)
  assert.equal(isSpecialistBlueprintStatus('confirmed'), true)
  assert.equal(isSpecialistBlueprintStatus('rejected'), true)
  assert.equal(isSpecialistBlueprintStatus('expired'), true)
  assert.equal(isSpecialistBlueprintStatus('active'), false)
})

test('specialist foundation semantic issue vocabulary is closed', () => {
  assert.deepEqual(SPECIALIST_FOUNDATION_SEMANTIC_ISSUES, [
    'scope_too_generic',
    'role_not_operational',
    'main_split_unclear',
    'weak_non_goals',
    'weak_task_examples',
    'weak_inputs_outputs',
    'tool_boundary_underexplained',
    'memory_policy_unclear',
    'knowledge_lacks_evidence',
    'foundation_echoes_request',
    'lifecycle_unclear',
  ])
  assert.equal(isSpecialistFoundationSemanticIssueId('scope_too_generic'), true)
  assert.equal(isSpecialistFoundationSemanticIssueId('freeform_issue'), false)
})

test('specialist blueprint source-message unavailable reason vocabulary is closed', () => {
  assert.deepEqual(SPECIALIST_BLUEPRINT_SOURCE_MESSAGE_UNAVAILABLE_REASONS, [
    'message_id_unavailable',
    'request_envelope_missing_message_id',
    'legacy_message_shape',
  ])
  assert.equal(isSpecialistBlueprintSourceMessageUnavailableReason('message_id_unavailable'), true)
  assert.equal(isSpecialistBlueprintSourceMessageUnavailableReason('empty'), false)
})

test('blueprint shape validation accepts the staged preview object and rejects incomplete shapes', () => {
  assert.deepEqual(validateSpecialistAgentBlueprintShape(blueprint()), { ok: true })
  assert.deepEqual(validateSpecialistAgentBlueprintShape({ ...blueprint(), nonGoals: 'none' }), {
    ok: false,
    reason: 'nonGoals must be an array',
  })
  const missing = blueprint() as Record<string, unknown>
  delete missing.userRequestVerbatim
  assert.deepEqual(validateSpecialistAgentBlueprintShape(missing), {
    ok: false,
    reason: 'missing field: userRequestVerbatim',
  })
  assert.deepEqual(validateSpecialistAgentBlueprintShape({ ...blueprint(), foundationDocs: { ...blueprint().foundationDocs, status: 'active' } }), {
    ok: false,
    reason: 'foundationDocs.status must be staged',
  })
})

test('blueprint shape validation accepts explicit unavailable message provenance and rejects unknown reasons', () => {
  assert.deepEqual(validateSpecialistAgentBlueprintShape(blueprint({
    provenance: {
      ...blueprint().provenance,
      sourceMessageId: null,
      sourceMessageUnavailableReason: 'message_id_unavailable',
    },
  })), { ok: true })

  assert.deepEqual(validateSpecialistAgentBlueprintShape(blueprint({
    provenance: {
      ...blueprint().provenance,
      sourceMessageId: null,
      sourceMessageUnavailableReason: 'unknown' as never,
    },
  })), {
    ok: false,
    reason: 'provenance.sourceMessageUnavailableReason is invalid',
  })
})

test('blueprint shape validation accepts optional adoption audit and rejects malformed audit', () => {
  assert.deepEqual(validateSpecialistAgentBlueprintShape(blueprint({
    adoption: {
      blueprintId: 'bp-visual-researcher',
      createdAgentId: 'visual-researcher',
      confirmationTokenId: 'token-1',
      migratedCards: [{ from: 'knowledge/xhs-note.md', to: 'agents/visual-researcher/knowledge/xhs-note.md' }],
      seedRelPaths: ['agents/visual-researcher/knowledge/seed-01.md'],
      foundationRelPath: 'agents/visual-researcher/FOUNDATION.md',
      routingCardRelPath: 'knowledge/routing-visual-researcher.md',
      adoptedAt: '2026-06-19T00:02:00.000Z',
    },
  })), { ok: true })

  assert.deepEqual(validateSpecialistAgentBlueprintShape(blueprint({
    adoption: {
      blueprintId: 'bp-visual-researcher',
      createdAgentId: 'visual-researcher',
      confirmationTokenId: 'token-1',
      migratedCards: [{ from: 'knowledge/xhs-note.md' } as { from: string; to: string }],
      seedRelPaths: ['agents/visual-researcher/knowledge/seed-01.md'],
      foundationRelPath: 'agents/visual-researcher/FOUNDATION.md',
      routingCardRelPath: 'knowledge/routing-visual-researcher.md',
      adoptedAt: '2026-06-19T00:02:00.000Z',
    },
  })), {
    ok: false,
    reason: 'adoption.migratedCards entries must include from/to strings',
  })
})

test('blueprint shape validation accepts optional semantic review and rejects malformed review', () => {
  assert.deepEqual(validateSpecialistAgentBlueprintShape(blueprint({
    semanticReview: {
      status: 'blocked',
      contentHash: 'hash-1',
      reviewedAt: '2026-06-19T00:02:00.000Z',
      source: 'semantic_judge',
      issues: [{
        id: 'scope_too_generic',
        message: '职责范围仍然过泛。',
        clarificationQuestion: '它应该长期负责哪些具体工作？',
      }],
    },
  })), { ok: true })

  assert.deepEqual(validateSpecialistAgentBlueprintShape(blueprint({
    semanticReview: {
      status: 'blocked',
      contentHash: 'hash-1',
      reviewedAt: '2026-06-19T00:02:00.000Z',
      source: 'semantic_judge',
      issues: [{
        id: 'freeform_issue',
        message: '自由文本缺口。',
      }],
    } as never,
  })), {
    ok: false,
    reason: 'semanticReview.issues entries must use known ids',
  })
})
