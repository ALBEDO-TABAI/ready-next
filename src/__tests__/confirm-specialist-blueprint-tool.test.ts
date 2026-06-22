import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { SpecialistBlueprintConfirmationStore } from '../main/modules/agent-control/agents/specialist-blueprint-confirmation'
import { SpecialistBlueprintStore } from '../main/modules/agent-control/agents/specialist-blueprint-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import {
  executeConfirmSpecialistBlueprint,
} from '../main/modules/tools/builtins/confirm-specialist-blueprint'
import {
  executeRenameSpecialistAgent,
} from '../main/modules/tools/builtins/rename-specialist-agent'
import {
  getAgentInteractionAnthropicTools,
  getAgentInteractionOpenAITools,
} from '../main/modules/tools/agent-interaction-tool-defs'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

type JsonSchemaObject = {
  properties?: Record<string, unknown>
}

function anthropicTool(name: string): { description?: string; input_schema?: JsonSchemaObject } {
  const tool = getAgentInteractionAnthropicTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `Anthropic tool ${name} must be registered`)
  return tool as { description?: string; input_schema?: JsonSchemaObject }
}

function openAITool(name: string): { function?: { description?: string; parameters?: JsonSchemaObject } } {
  const tool = getAgentInteractionOpenAITools().find((candidate) => {
    const fn = candidate.function as { name?: string } | undefined
    return fn?.name === name
  })
  assert.ok(tool, `OpenAI tool ${name} must be registered`)
  return tool as { function?: { description?: string; parameters?: JsonSchemaObject } }
}

function registry(initial: AgentRegistryRecord[] = []) {
  const rows = new Map<string, AgentRegistryRecord>(initial.map((row) => [row.id, row]))
  return {
    rows,
    get: (id: string): AgentRegistryRecord | null => rows.get(id) ?? null,
    list: (): AgentRegistryRecord[] => [...rows.values()],
    create: (input: {
      id: string
      name: string
      charter?: string | null
      personaRef?: string | null
      parentAgentId?: string | null
      derivationReason?: string | null
    }): AgentRegistryRecord => {
      if (rows.has(input.id)) throw new Error('duplicate agent')
      const record: AgentRegistryRecord = {
        id: input.id,
        name: input.name,
        charter: input.charter ?? null,
        personaRef: input.personaRef ?? null,
        status: 'active',
        parentAgentId: input.parentAgentId ?? null,
        derivationReason: input.derivationReason ?? null,
        mergedIntoAgentId: null,
        createdAt: '2026-06-22T00:00:00.000Z',
      }
      rows.set(record.id, record)
      return record
    },
    updateName: (id: string, name: string): AgentRegistryRecord => {
      const current = rows.get(id)
      if (!current) throw new Error('agent not found')
      if (current.id === 'butler') throw new Error('main agent display name is managed separately')
      if (current.status !== 'active') throw new Error('only active agents can be renamed')
      const next = { ...current, name }
      rows.set(id, next)
      return next
    },
  }
}

function blueprint(overrides: Partial<SpecialistAgentBlueprint> = {}): SpecialistAgentBlueprint {
  const base: SpecialistAgentBlueprint = {
    blueprintId: 'bp-campaign-writer',
    status: 'staged',
    inferredScope: {
      slug: 'campaign-writer',
      displayName: '营销文案专项 Agent',
      domain: '文案创作',
      routingTriggers: ['写文案', '文案', '公众号文章'],
    },
    foundationDocs: {
      status: 'staged',
      charter: '负责为品牌、产品和内容运营任务撰写、改写和优化文案，并输出可直接迭代的版本。',
      rulesText: '# 营销文案专项 Agent\n- 先确认平台、受众和目标。\n- 输出至少一个可直接使用的版本。',
      knowledgeSeeds: [{ title: '文案边界', body: '不替用户发布，不处理账号登录。', evidenceRefs: ['user:0'] }],
      toolSafetyNotes: '外发和写入长期记忆前需要确认。',
      foundationText: '# 营销文案专项 Agent Foundation',
    },
    provenance: {
      userRequestVerbatim: '帮我创建一个专门负责帮我处理文案类工作的 agent',
      sourceSessionId: 'session-1',
      sourceRunId: null,
      sourceMessageId: 'message-1',
      createdAt: '2026-06-22T00:00:00.000Z',
    },
    confirmation: {
      tokenId: null,
      confirmedAt: null,
      usedAt: null,
    },
    rolePersona: '以资深文案编辑的姿态工作，先界定传播目的和受众，再给出结构清晰、可修改的文案。',
    taskExamples: {
      suitable: ['写小红书种草文案', '改公众号开头', '生成产品卖点文案'],
      unsuitable: ['直接发布到平台', '分析财务数据', '替用户登录账号'],
    },
    mainVsSpecialistSplit: '主 agent 负责理解总目标和协调材料，文案专项 agent 负责成稿、改稿和文风迭代。',
    toolBoundaries: {
      browser: { mode: 'deny', notes: '不主动浏览网页；只使用用户提供的素材和已确认资料。' },
      write: { mode: 'confirm', notes: '写入文件或长期资产前必须确认路径和内容。' },
      externalSend: { mode: 'deny', notes: '不代表用户发送或发布内容。' },
      longMemory: { mode: 'confirm', notes: '只记住用户确认过的长期文风偏好。' },
    },
    memoryProfilePolicy: '只在用户确认后记录稳定文风、品牌禁用词和常用输出格式。',
    lifecycleNotes: '当文案类型变化、触发词失效或职责与其它 agent 重叠时，需要重新确认。',
    specialistId: 'campaign-writer',
    displayName: '营销文案专项 Agent',
    charter: '负责为品牌、产品和内容运营任务撰写、改写和优化文案，并输出可直接迭代的版本。',
    intendedDomain: '文案创作',
    nonGoals: ['不发布内容', '不登录账号', '不处理付款', '不做数据分析'],
    recurringTasks: ['撰写平台文案初稿', '改写已有文案语气', '整理多个标题版本'],
    requiredInputs: ['发布平台与字数限制', '目标受众与核心卖点', '品牌语气和禁用词'],
    expectedOutputs: ['可直接编辑的文案成稿', '标题与开头备选版本', '修改理由摘要'],
    routingTriggers: ['写文案', '文案', '公众号文章'],
    routingActivateOnCreate: false,
    seedRulesText: '# 营销文案专项 Agent\n- 先确认平台、受众和目标。\n- 输出至少一个可直接使用的版本。',
    knowledgeSeeds: [{ title: '文案边界', body: '不替用户发布，不处理账号登录。', evidenceRefs: ['user:0'] }],
    migrationCandidates: [],
    toolSafetyNotes: '外发、写入和长期记忆更新都必须等待用户确认。',
    source: 'conversation',
    userRequestVerbatim: '帮我创建一个专门负责帮我处理文案类工作的 agent',
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [{ check: 'professional_specificity', pass: true }],
  }
  return { ...base, ...overrides }
}

test('agent_interaction exposes specialist confirm and rename tools to the model', () => {
  const proposeDescription = String(anthropicTool('propose_specialist_blueprint').description || '')
  assert.match(proposeDescription, /ask_user_questions/)
  assert.match(proposeDescription, /confirm_specialist_blueprint/)
  assert.match(proposeDescription, /确认创建/)
  assert.match(proposeDescription, /我想修改/)

  for (const tool of [
    anthropicTool('confirm_specialist_blueprint'),
    openAITool('confirm_specialist_blueprint').function,
  ]) {
    assert.match(String(tool?.description || ''), /二级确认/)
    assert.match(String(tool?.description || ''), /ask_user_questions/)
    assert.ok((tool?.input_schema || tool?.parameters)?.properties?.action)
  }

  for (const tool of [
    anthropicTool('rename_specialist_agent'),
    openAITool('rename_specialist_agent').function,
  ]) {
    assert.match(String(tool?.description || ''), /改显示名/)
    assert.match(String(tool?.description || ''), /ask_user_questions/)
    assert.match(String(tool?.description || ''), /不要回答“去设置页手动改”/)
    assert.ok((tool?.input_schema || tool?.parameters)?.properties?.display_name)
  }
})

test('confirm_specialist_blueprint creates a specialist through the shared confirmation path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-confirm-specialist-'))
  try {
    const blueprintStore = new SpecialistBlueprintStore()
    const confirmationStore = new SpecialistBlueprintConfirmationStore()
    const beliefStore = new BeliefCardStore({ memoryRoot: root })
    const repo = registry()
    blueprintStore.upsert(blueprint())

    const output = await executeConfirmSpecialistBlueprint({
      action: 'confirm_create',
      blueprint_id: 'bp-campaign-writer',
      confirmation_source: 'direct_user_message',
      user_confirmation_verbatim: '确认创建',
    }, {
      getBlueprintStore: () => blueprintStore,
      getConfirmationStore: () => confirmationStore,
      getBeliefCardStore: () => beliefStore,
      getAgentRegistry: () => repo,
      sessionId: 'session-1',
      currentUserText: '确认创建',
      runSemanticFoundationJudge: async () => ({ issues: [] }),
      now: () => new Date('2026-06-22T00:00:00.000Z'),
    })

    assert.equal(output.data?.createdAgent, true)
    assert.equal(output.data?.agentId, 'campaign-writer')
    assert.equal(repo.get('campaign-writer')?.name, '营销文案专项 Agent')
    assert.equal(blueprintStore.get('bp-campaign-writer')?.adoption?.createdAgentId, 'campaign-writer')
    assert.equal(beliefStore.readCard('knowledge/routing-campaign-writer.md', { includeStaged: true })?.frontmatter.status, 'staged')
    assert.equal(output.data?.routingActivated, false)
    assert.equal(output.data?.routingStatus, 'staged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('confirm_specialist_blueprint treats rejection wording as a hard stop even when action is wrong', async () => {
  const blueprintStore = new SpecialistBlueprintStore()
  const confirmationStore = new SpecialistBlueprintConfirmationStore()
  const repo = registry()
  blueprintStore.upsert(blueprint())

  const output = await executeConfirmSpecialistBlueprint({
    action: 'confirm_create',
    blueprint_id: 'bp-campaign-writer',
    confirmation_source: 'direct_user_message',
    user_confirmation_verbatim: '不创建',
  }, {
    getBlueprintStore: () => blueprintStore,
    getConfirmationStore: () => confirmationStore,
    getBeliefCardStore: () => null,
    getAgentRegistry: () => repo,
    sessionId: 'session-1',
    currentUserText: '不创建',
  })

  assert.equal(output.data?.errorKind, 'confirmation_intent_missing')
  assert.equal(repo.get('campaign-writer'), null)
  assert.equal(blueprintStore.get('bp-campaign-writer')?.status, 'staged')
})

test('confirm_specialist_blueprint rejects a blueprint without creating an agent', async () => {
  const blueprintStore = new SpecialistBlueprintStore()
  const confirmationStore = new SpecialistBlueprintConfirmationStore()
  const repo = registry()
  blueprintStore.upsert(blueprint())

  const output = await executeConfirmSpecialistBlueprint({
    action: 'reject',
    blueprint_id: 'bp-campaign-writer',
    confirmation_source: 'direct_user_message',
    user_confirmation_verbatim: '不创建',
  }, {
    getBlueprintStore: () => blueprintStore,
    getConfirmationStore: () => confirmationStore,
    getBeliefCardStore: () => null,
    getAgentRegistry: () => repo,
    sessionId: 'session-1',
    currentUserText: '不创建',
  })

  assert.equal(output.data?.createdAgent, false)
  assert.equal(blueprintStore.get('bp-campaign-writer')?.status, 'rejected')
  assert.equal(repo.get('campaign-writer'), null)
})

test('rename_specialist_agent requires current user wording and updates an active specialist', () => {
  const repo = registry([{
    id: 'campaign-writer',
    name: '营销文案专项 Agent',
    charter: '文案',
    personaRef: null,
    status: 'active',
    parentAgentId: 'butler',
    derivationReason: null,
    mergedIntoAgentId: null,
    createdAt: '2026-06-22T00:00:00.000Z',
  }])

  const output = executeRenameSpecialistAgent({
    specialist_id: 'campaign-writer',
    display_name: '葵老板',
    user_request_verbatim: '把文案专项Agent 改名为 葵老板',
  }, {
    registry: repo,
    currentUserText: '帮我把文案专项Agent 改名为 葵老板',
  })

  assert.equal(output.data?.displayName, '葵老板')
  assert.equal(repo.get('campaign-writer')?.name, '葵老板')

  const rejected = executeRenameSpecialistAgent({
    specialist_id: 'campaign-writer',
    display_name: '新名字',
    user_request_verbatim: '把文案专项Agent 改名为 新名字',
  }, {
    registry: repo,
    currentUserText: '没有改名请求',
  })
  assert.equal(rejected.data?.errorKind, 'rename_verbatim_mismatch')
  assert.equal(repo.get('campaign-writer')?.name, '葵老板')
})
