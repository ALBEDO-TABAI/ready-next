import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

import {
  hashSpecialistBlueprintForConfirmation,
} from '../main/modules/agent-control/agents/specialist-blueprint-confirmation'
import {
  hashSpecialistBlueprintReviewContent,
  materializeSpecialistBlueprintForReview,
} from '../main/modules/agent-control/agents/specialist-blueprint-review-content'
import {
  runSpecialistFoundationSemanticReview,
} from '../main/modules/agent-control/agents/specialist-foundation-semantic-judge'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

function registry() {
  return {
    get: (_id: string): AgentRegistryRecord | null => null,
    list: (): AgentRegistryRecord[] => [],
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
      routingTriggers: ['视觉研究'],
    },
    foundationDocs: {
      status: 'staged',
      charter: '负责为视觉创作任务整理参考、提炼风格边界，并输出带引用的研究结论。',
      rulesText: '# 视觉研究专项 Agent\n- 保留来源引用。\n- 先收敛范围再输出。',
      knowledgeSeeds: [{ title: '来源要求', body: '所有参考结论都要保留来源。', evidenceRefs: ['user:0'] }],
      toolSafetyNotes: '外发前确认。',
      foundationText: 'stale preview',
    },
    provenance: {
      userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
      sourceSessionId: 'session-1',
      sourceRunId: null,
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
    intendedDomain: '视觉参考研究',
    nonGoals: ['不直接外发文件', '不替代主 agent 做最终创意决策'],
    recurringTasks: ['整理视觉参考资料', '沉淀视觉规则'],
    requiredInputs: ['用户目标', '参考链接或附件'],
    expectedOutputs: ['结构化研究结论', '可复用知识卡草稿'],
    routingTriggers: ['视觉研究'],
    routingActivateOnCreate: false,
    seedRulesText: '# 视觉研究专项 Agent\n- 保留来源引用。\n- 先收敛范围再输出。',
    knowledgeSeeds: [{ title: '来源要求', body: '所有参考结论都要保留来源。', evidenceRefs: ['user:0'] }],
    migrationCandidates: [],
    toolSafetyNotes: '外发、下载、写文件和长期记忆更新都必须等待用户确认。',
    source: 'conversation',
    userRequestVerbatim: '我要一个视觉研究类型的专项 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [{ check: 'placeholder', pass: true }],
  }
  return { ...base, ...overrides }
}

test('semantic review content hash matches the canonical confirmation hash', async () => {
  const canonical = materializeSpecialistBlueprintForReview(registry(), blueprint())
  const review = await runSpecialistFoundationSemanticReview(canonical, {
    registry: registry(),
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    judge: async () => ({ issues: [] }),
  })

  assert.equal(review.review.status, 'passed')
  assert.equal(review.review.contentHash, hashSpecialistBlueprintReviewContent(review.blueprint))
  assert.equal(review.review.contentHash, hashSpecialistBlueprintForConfirmation(review.blueprint))
  assert.match(review.blueprint.foundationDocs.foundationText, /## Role Persona/)
  assert.notEqual(review.blueprint.foundationDocs.foundationText, 'stale preview')
})

test('review content hash excludes flow metadata but includes gate outputs', () => {
  const canonical = materializeSpecialistBlueprintForReview(registry(), blueprint())
  const hash = hashSpecialistBlueprintReviewContent(canonical)
  assert.equal(hashSpecialistBlueprintReviewContent({
    ...canonical,
    status: 'confirmed',
    semanticReview: {
      status: 'passed',
      contentHash: 'other',
      reviewedAt: '2026-06-20T00:00:00.000Z',
      issues: [],
      source: 'semantic_judge',
    },
    confirmation: {
      tokenId: 'token-1',
      confirmedAt: '2026-06-20T00:01:00.000Z',
      usedAt: null,
    },
    adoption: {
      blueprintId: canonical.blueprintId,
      createdAgentId: canonical.specialistId,
      confirmationTokenId: 'token-1',
      migratedCards: [],
      seedRelPaths: [],
      foundationRelPath: `agents/${canonical.specialistId}/FOUNDATION.md`,
      routingCardRelPath: `knowledge/routing-${canonical.specialistId}.md`,
      adoptedAt: '2026-06-20T00:02:00.000Z',
    },
  }), hash)
  assert.notEqual(hashSpecialistBlueprintReviewContent({
    ...canonical,
    admissionVerdict: { kind: 'clarify', missing: ['charter'] },
  }), hash)
  assert.notEqual(hashSpecialistBlueprintReviewContent({
    ...canonical,
    qualityChecks: [{ check: 'charter', pass: false, blocking: true }],
  }), hash)
})

test('semantic judge blocked result keeps closed issue ids', async () => {
  const result = await runSpecialistFoundationSemanticReview(blueprint(), {
    registry: registry(),
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    judge: async () => ({
      issues: [{
        id: 'scope_too_generic',
        message: '职责范围仍然过泛。',
        clarificationQuestion: '它应该长期负责哪些具体工作？',
      }],
    }),
  })

  assert.equal(result.review.status, 'blocked')
  assert.deepEqual(result.review.issues.map((issue) => issue.id), ['scope_too_generic'])
  assert.equal(result.review.source, 'semantic_judge')
})

test('semantic judge unavailable or malformed output never counts as pass', async () => {
  const noJudge = await runSpecialistFoundationSemanticReview(blueprint(), {
    registry: registry(),
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    unavailableReason: 'production_judge_not_configured',
  })
  assert.equal(noJudge.review.status, 'unavailable')
  assert.equal(noJudge.review.source, 'not_available')
  assert.equal(noJudge.review.unavailableReason, 'production_judge_not_configured')

  const unknown = await runSpecialistFoundationSemanticReview(blueprint(), {
    registry: registry(),
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    judge: async () => ({ issues: [{ id: 'freeform_issue' }] }),
  })
  assert.equal(unknown.review.status, 'unavailable')
  assert.equal(unknown.review.unavailableReason, 'unknown_issue_id')

  for (const raw of [null, undefined, '', {}, { ok: true }, { issues: 'x' }, { issues: null }]) {
    const empty = await runSpecialistFoundationSemanticReview(blueprint(), {
      registry: registry(),
      now: () => new Date('2026-06-20T00:00:00.000Z'),
      judge: async () => raw as never,
    })
    assert.equal(empty.review.status, 'unavailable')
    assert.equal(empty.review.unavailableReason, 'empty_or_malformed_output')
  }

  const explicitEmptyIssues = await runSpecialistFoundationSemanticReview(blueprint(), {
    registry: registry(),
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    judge: async () => ({ issues: [] }),
  })
  assert.equal(explicitEmptyIssues.review.status, 'passed')
})
