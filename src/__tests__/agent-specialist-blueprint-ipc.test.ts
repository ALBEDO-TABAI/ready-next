import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  agentSpecialistBlueprintGroup,
  _agentSpecialistBlueprintGroupChannelsForTest,
  type AgentSpecialistBlueprintGroupDeps,
} from '../main/modules/claude-bridge/ipc/agent-specialist-blueprint-group'
import { SpecialistBlueprintConfirmationStore } from '../main/modules/agent-control/agents/specialist-blueprint-confirmation'
import { SpecialistBlueprintStore } from '../main/modules/agent-control/agents/specialist-blueprint-store'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function createMockIpc() {
  const handlers = new Map<string, HandlerFn>()
  const removeHandlerCalls: string[] = []
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      removeHandlerCalls.push(channel)
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  return { ipc, handlers, removeHandlerCalls }
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-blueprint-ipc-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

function registry() {
  const rows = new Map<string, AgentRegistryRecord>()
  return {
    rows,
    get: (id: string) => rows.get(id) ?? null,
    list: () => [...rows.values()],
    create: (input: {
      id: string
      name: string
      charter?: string | null
      personaRef?: string | null
      parentAgentId?: string | null
      derivationReason?: string | null
    }) => {
      const record: AgentRegistryRecord = {
        id: input.id,
        name: input.name,
        charter: input.charter ?? null,
        personaRef: input.personaRef ?? null,
        status: 'active',
        parentAgentId: input.parentAgentId ?? null,
        derivationReason: input.derivationReason ?? null,
        mergedIntoAgentId: null,
        createdAt: '2026-06-19T00:00:00.000Z',
      }
      rows.set(record.id, record)
      return record
    },
  }
}

function writeKnowledgeCard(store: BeliefCardStore, relPath: string, title: string): void {
  const frontmatter: BeliefCardFrontmatter = {
    title,
    description: `${title} 描述`,
    confidence: 'H',
    tag: 'knowledge',
    created: '2026-06-19',
    status: 'active',
  }
  const result = store.writeCard({ relPath, frontmatter, body: `${title} 内容` })
  assert.equal(result.ok, true)
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
      foundationText: '# 视觉研究专项 Agent Foundation',
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
    intendedDomain: '视觉研究',
    nonGoals: ['不外发文件', '不替代主 agent 做最终创意决策'],
    recurringTasks: ['整理参考资料', '沉淀视觉规则'],
    requiredInputs: ['用户目标', '参考链接或附件'],
    expectedOutputs: ['研究结论', '可复用知识卡草稿'],
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
    qualityChecks: [{ check: 'has_non_goals', pass: true }],
  }
  return { ...base, ...overrides }
}

function deps(root: string): AgentSpecialistBlueprintGroupDeps & { registryRows: Map<string, AgentRegistryRecord>; blueprintStore: SpecialistBlueprintStore } {
  const store = new SpecialistBlueprintStore()
  const confirmation = new SpecialistBlueprintConfirmationStore()
  const cards = new BeliefCardStore({ memoryRoot: root })
  const repo = registry()
  return {
    registryRows: repo.rows,
    blueprintStore: store,
    getBlueprintStore: () => store,
    getConfirmationStore: () => confirmation,
    getBeliefCardStore: () => cards,
    getAgentRegistry: () => repo,
    runSemanticFoundationJudge: async () => ({ issues: [] }),
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  }
}

test('agentSpecialistBlueprintGroup registers and disposes blueprint channels', () => {
  const { ipc, handlers, removeHandlerCalls } = createMockIpc()
  const root = makeRoot()
  try {
    const handle = agentSpecialistBlueprintGroup.register(ipc, deps(root))
    assert.deepEqual([...handlers.keys()].sort(), [..._agentSpecialistBlueprintGroupChannelsForTest].sort())
    assert.equal(agentSpecialistBlueprintGroup.namespace, 'agent:specialistBlueprint')
    const baseline = removeHandlerCalls.length
    handle.dispose()
    assert.deepEqual(removeHandlerCalls.slice(baseline).sort(), [..._agentSpecialistBlueprintGroupChannelsForTest].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint IPC validates untrusted payloads before storing drafts', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    agentSpecialistBlueprintGroup.register(ipc, deps(root))
    const invalid = await handlers.get('agent:specialistBlueprint:upsertDraft')?.({} as IpcMainInvokeEvent, {
      blueprint: { blueprintId: 'bp-bad' },
    })
    assert.equal((invalid as { success: boolean }).success, false)
    assert.match((invalid as { error?: string }).error || '', /missing field/)

    const valid = await handlers.get('agent:specialistBlueprint:upsertDraft')?.({} as IpcMainInvokeEvent, {
      blueprint: blueprint(),
    })
    assert.equal((valid as { success: boolean }).success, true)
    const listed = await handlers.get('agent:specialistBlueprint:list')?.({} as IpcMainInvokeEvent)
    assert.equal((listed as { data: SpecialistAgentBlueprint[] }).data[0].blueprintId, 'bp-visual-researcher')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint IPC consumes token after factory create and rejects replay', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
	  try {
	    const state = deps(root)
	    writeKnowledgeCard(state.getBeliefCardStore() as BeliefCardStore, 'knowledge/xhs-note.md', '小红书经验')
	    agentSpecialistBlueprintGroup.register(ipc, state)
	    await handlers.get('agent:specialistBlueprint:upsertDraft')?.({} as IpcMainInvokeEvent, {
	      blueprint: blueprint({ migrationCandidates: ['knowledge/xhs-note.md'] }),
	    })
    const admission = await handlers.get('agent:specialistBlueprint:runAdmission')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
    })
    assert.equal((admission as { data: { verdict: { kind: string } } }).data.verdict.kind, 'admit')

    const denied = await handlers.get('agent:specialistBlueprint:confirmCreate')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
      tokenId: 'missing-token',
    })
    assert.equal((denied as { success: boolean }).success, false)
    assert.equal(state.registryRows.size, 0)

    const token = await handlers.get('agent:specialistBlueprint:requestConfirmation')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
    })
    assert.equal((token as { success: boolean }).success, true)
    const tokenId = (token as { data: { tokenId: string } }).data.tokenId
	    const created = await handlers.get('agent:specialistBlueprint:confirmCreate')?.({} as IpcMainInvokeEvent, {
	      blueprintId: 'bp-visual-researcher',
	      sessionId: 'studio',
	      tokenId,
	      migrateCardRelPaths: ['knowledge/xhs-note.md'],
	    })
	    assert.equal((created as { success: boolean }).success, true)
	    assert.deepEqual((created as { data: { result: { migratedCards: unknown[]; seedRelPaths: string[] } } }).data.result.migratedCards, [{
	      from: 'knowledge/xhs-note.md',
	      to: 'agents/visual-researcher/knowledge/xhs-note.md',
	    }])
	    assert.deepEqual((created as { data: { result: { seedRelPaths: string[] } } }).data.result.seedRelPaths, ['agents/visual-researcher/knowledge/seed-01.md'])
	    assert.equal((created as { data: { result: { foundationRelPath: string } } }).data.result.foundationRelPath, 'agents/visual-researcher/FOUNDATION.md')
	    assert.equal(state.registryRows.get('visual-researcher')?.derivationReason, 'blueprint:bp-visual-researcher')
	    assert.ok(existsSync(join(root, 'agents', 'visual-researcher', 'RULES.md')))
	    assert.ok(existsSync(join(root, 'agents', 'visual-researcher', 'FOUNDATION.md')))
	    assert.equal(state.getBeliefCardStore()?.readCard('knowledge/routing-visual-researcher.md', { includeStaged: true })?.frontmatter.status, 'staged')
	    const adopted = state.blueprintStore.get('bp-visual-researcher')?.adoption
	    assert.equal(adopted?.createdAgentId, 'visual-researcher')
	    assert.equal(adopted?.confirmationTokenId, tokenId)
	    assert.deepEqual(adopted?.migratedCards, [{
	      from: 'knowledge/xhs-note.md',
	      to: 'agents/visual-researcher/knowledge/xhs-note.md',
	    }])
	    assert.deepEqual(adopted?.seedRelPaths, ['agents/visual-researcher/knowledge/seed-01.md'])
	    assert.equal(adopted?.foundationRelPath, 'agents/visual-researcher/FOUNDATION.md')
	    assert.equal(adopted?.routingCardRelPath, 'knowledge/routing-visual-researcher.md')

	    const replay = await handlers.get('agent:specialistBlueprint:confirmCreate')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
      tokenId,
    })
    assert.equal((replay as { success: boolean }).success, false)
    assert.match((replay as { error?: string }).error || '', /already used/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint IPC leaves token reusable when create dependencies fail before factory create', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const state = deps(root)
    let cards: BeliefCardStore | null = null
    state.getBeliefCardStore = () => cards
    agentSpecialistBlueprintGroup.register(ipc, state)
    await handlers.get('agent:specialistBlueprint:upsertDraft')?.({} as IpcMainInvokeEvent, { blueprint: blueprint() })
    await handlers.get('agent:specialistBlueprint:runAdmission')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
    })
    const token = await handlers.get('agent:specialistBlueprint:requestConfirmation')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
    })
    const tokenId = (token as { data: { tokenId: string } }).data.tokenId

    const failed = await handlers.get('agent:specialistBlueprint:confirmCreate')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
      tokenId,
    })
    assert.equal((failed as { success: boolean }).success, false)
    assert.match((failed as { error?: string }).error || '', /Belief card store not available/)
    assert.equal(state.registryRows.size, 0)
    assert.equal(state.blueprintStore.get('bp-visual-researcher')?.confirmation.usedAt, null)

    cards = new BeliefCardStore({ memoryRoot: root })
    const retried = await handlers.get('agent:specialistBlueprint:confirmCreate')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
      tokenId,
    })
    assert.equal((retried as { success: boolean }).success, true)
    assert.equal(state.registryRows.get('visual-researcher')?.derivationReason, 'blueprint:bp-visual-researcher')
    assert.ok(state.blueprintStore.get('bp-visual-researcher')?.confirmation.usedAt)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint IPC requires explicit ack when semantic review is unavailable', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const state = deps(root)
    state.runSemanticFoundationJudge = undefined
    state.semanticFoundationJudgeUnavailableReason = 'production_judge_not_configured'
    agentSpecialistBlueprintGroup.register(ipc, state)
    await handlers.get('agent:specialistBlueprint:upsertDraft')?.({} as IpcMainInvokeEvent, { blueprint: blueprint() })
    const admission = await handlers.get('agent:specialistBlueprint:runAdmission')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
    })
    assert.equal((admission as { data: { blueprint: SpecialistAgentBlueprint } }).data.blueprint.semanticReview?.status, 'unavailable')
    assert.equal(
      (admission as { data: { blueprint: SpecialistAgentBlueprint } }).data.blueprint.semanticReview?.unavailableReason,
      'production_judge_not_configured',
    )

    const denied = await handlers.get('agent:specialistBlueprint:requestConfirmation')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
    })
    assert.equal((denied as { success: boolean }).success, false)
    assert.match((denied as { error?: string }).error || '', /explicit unverified confirmation/)

    const contentHash = state.blueprintStore.get('bp-visual-researcher')?.semanticReview?.contentHash
    assert.ok(contentHash)
    const token = await handlers.get('agent:specialistBlueprint:requestConfirmation')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
      unverifiedSemanticReviewAck: {
        kind: 'unverified_semantic_review',
        contentHash,
      },
    })
    assert.equal((token as { success: boolean }).success, true)
    assert.equal(state.blueprintStore.get('bp-visual-researcher')?.semanticReview?.source, 'unverified_explicit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint IPC does not downgrade a current semantic block into unavailable ack', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const state = deps(root)
    state.runSemanticFoundationJudge = async () => ({
      issues: [{
        id: 'scope_too_generic',
        message: '职责范围仍然过泛。',
      }],
    })
    agentSpecialistBlueprintGroup.register(ipc, state)
    await handlers.get('agent:specialistBlueprint:upsertDraft')?.({} as IpcMainInvokeEvent, { blueprint: blueprint() })
    const blocked = await handlers.get('agent:specialistBlueprint:runAdmission')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
    })
    assert.equal((blocked as { data: { blueprint: SpecialistAgentBlueprint } }).data.blueprint.status, 'needs_clarification')
    assert.equal((blocked as { data: { blueprint: SpecialistAgentBlueprint } }).data.blueprint.semanticReview?.status, 'blocked')
    const blockedHash = state.blueprintStore.get('bp-visual-researcher')?.semanticReview?.contentHash
    assert.ok(blockedHash)

    state.runSemanticFoundationJudge = undefined
    const refresh = await handlers.get('agent:specialistBlueprint:runAdmission')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
    })
    assert.equal((refresh as { data: { blueprint: SpecialistAgentBlueprint } }).data.blueprint.status, 'needs_clarification')
    assert.equal((refresh as { data: { blueprint: SpecialistAgentBlueprint } }).data.blueprint.semanticReview?.status, 'blocked')

    const denied = await handlers.get('agent:specialistBlueprint:requestConfirmation')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
      unverifiedSemanticReviewAck: {
        kind: 'unverified_semantic_review',
        contentHash: blockedHash,
      },
    })
    assert.equal((denied as { success: boolean }).success, false)
    assert.match((denied as { error?: string }).error || '', /blueprint admission is not admit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint IPC rejects confirmed blueprint overwrite and content-hash token replay', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const state = deps(root)
    agentSpecialistBlueprintGroup.register(ipc, state)
    await handlers.get('agent:specialistBlueprint:upsertDraft')?.({} as IpcMainInvokeEvent, { blueprint: blueprint() })
    await handlers.get('agent:specialistBlueprint:runAdmission')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
    })
    const token = await handlers.get('agent:specialistBlueprint:requestConfirmation')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
    })
    const tokenId = (token as { data: { tokenId: string } }).data.tokenId

    const overwrite = await handlers.get('agent:specialistBlueprint:runAdmission')?.({} as IpcMainInvokeEvent, {
      blueprint: blueprint({ displayName: '换包专项 Agent', charter: '换包内容' }),
    })
    assert.equal((overwrite as { success: boolean }).success, false)
    assert.match((overwrite as { error?: string }).error || '', /confirmed blueprint cannot be overwritten/)

    state.blueprintStore.patch('bp-visual-researcher', { displayName: '内部篡改' })
    const tampered = await handlers.get('agent:specialistBlueprint:confirmCreate')?.({} as IpcMainInvokeEvent, {
      blueprintId: 'bp-visual-researcher',
      sessionId: 'studio',
      tokenId,
    })
    assert.equal((tampered as { success: boolean }).success, false)
    assert.match((tampered as { error?: string }).error || '', /content mismatch/)
    assert.equal(state.registryRows.size, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
