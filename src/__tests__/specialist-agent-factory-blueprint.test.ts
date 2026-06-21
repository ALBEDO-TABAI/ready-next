import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deriveSpecialistAgentFromBlueprint,
  prepareSpecialistAgentFromBlueprint,
} from '../main/modules/agent-control/agents/agent-factory'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-blueprint-factory-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

function registry(options: { throwOnCreate?: boolean } = {}) {
  const rows = new Map<string, AgentRegistryRecord>()
  return {
    rows,
    get: (id: string) => rows.get(id) ?? null,
    create: (input: {
      id: string
      name: string
      charter?: string | null
      personaRef?: string | null
      parentAgentId?: string | null
      derivationReason?: string | null
    }) => {
      if (options.throwOnCreate) throw new Error('registry create failed')
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
    status: 'confirmed',
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
      tokenId: 'token-1',
      confirmedAt: '2026-06-19T00:01:00.000Z',
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

test('blueprint factory prepare requires confirmed blueprint and matching token', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const repo = registry()
    assert.throws(() => prepareSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint({ status: 'staged' }),
      confirmationTokenId: 'token-1',
    }), /blueprint must be confirmed/)
    assert.throws(() => prepareSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint(),
      confirmationTokenId: 'wrong-token',
    }), /confirmation token mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint factory creates agent, staged RULES knowledge seeds, and staged routing through one path', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const repo = registry()
    const result = deriveSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint(),
      confirmationTokenId: 'token-1',
      now: new Date('2026-06-19T12:00:00.000Z'),
    })

    assert.equal(result.agent.id, 'visual-researcher')
    assert.equal(result.agent.derivationReason, 'blueprint:bp-visual-researcher')
    assert.equal(result.rulesRelPath, 'agents/visual-researcher/RULES.md')
    assert.equal(result.foundationRelPath, 'agents/visual-researcher/FOUNDATION.md')
    assert.ok(readFileSync(join(root, result.rulesRelPath), 'utf-8').includes('保留来源引用'))
    assert.ok(readFileSync(join(root, result.foundationRelPath || ''), 'utf-8').includes('## Tool Boundaries'))
    const seed = store.readCard('agents/visual-researcher/knowledge/seed-01.md', { includeStaged: true })
    assert.equal(seed?.frontmatter.status, 'staged')
    assert.equal(seed?.frontmatter.source, 'blueprint:bp-visual-researcher')
	    const routing = store.readCard(result.routingCardRelPath, { includeStaged: true })
	    assert.equal(routing?.frontmatter.status, 'staged')
	    assert.deepEqual(routing?.frontmatter.triggers, ['视觉研究', '参考图'])
	    assert.deepEqual(result.seedRelPaths, ['agents/visual-researcher/knowledge/seed-01.md'])
	    assert.deepEqual(result.migratedCards, [])
	  } finally {
	    rmSync(root, { recursive: true, force: true })
	  }
	})

test('blueprint factory migrates only selected candidate cards into the new agent', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    writeKnowledgeCard(store, 'knowledge/xhs-note.md', '小红书经验')
    writeKnowledgeCard(store, 'knowledge/unused-note.md', '暂不迁移')
    const repo = registry()
    const result = deriveSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint({ migrationCandidates: ['knowledge/xhs-note.md', 'knowledge/unused-note.md'] }),
      confirmationTokenId: 'token-1',
      migrateCardRelPaths: ['knowledge/xhs-note.md'],
      now: new Date('2026-06-19T12:00:00.000Z'),
    })

    assert.deepEqual(result.migratedCards, [{
      from: 'knowledge/xhs-note.md',
      to: 'agents/visual-researcher/knowledge/xhs-note.md',
    }])
    assert.equal(store.readCard('knowledge/xhs-note.md', { includeStaged: true }), null)
    assert.equal(store.readCard('agents/visual-researcher/knowledge/xhs-note.md', { includeStaged: true })?.frontmatter.status, 'active')
    assert.equal(store.readCard('knowledge/unused-note.md', { includeStaged: true })?.frontmatter.title, '暂不迁移')
    assert.equal(store.readCard(result.routingCardRelPath, { includeStaged: true })?.frontmatter.status, 'staged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint factory rejects migration cards that were not offered by the blueprint', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const repo = registry()
    assert.throws(() => prepareSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint({ migrationCandidates: ['knowledge/xhs-note.md'] }),
      confirmationTokenId: 'token-1',
      migrateCardRelPaths: ['knowledge/other-note.md'],
    }), /migration card was not offered/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint factory rejects migration targets that would overwrite blueprint seeds', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    writeKnowledgeCard(store, 'knowledge/seed-01.md', '会撞种子名')
    const repo = registry()
    assert.throws(() => prepareSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint({ migrationCandidates: ['knowledge/seed-01.md'] }),
      confirmationTokenId: 'token-1',
      migrateCardRelPaths: ['knowledge/seed-01.md'],
    }), /migration target conflicts with blueprint seed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint factory reruns admission after confirmation', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const repo = registry()
    assert.throws(() => deriveSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint({ intendedDomain: '全能' }),
      confirmationTokenId: 'token-1',
    }), /blueprint admission rejected/)
    assert.equal(repo.rows.size, 0)
    assert.equal(existsSync(join(root, 'agents', 'visual-researcher', 'RULES.md')), false)
    assert.equal(existsSync(join(root, 'agents', 'visual-researcher', 'FOUNDATION.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint factory rejects confirmed hollow blueprint even with matching token', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const repo = registry()
    assert.throws(() => deriveSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint({
        charter: '按用户要求工作',
        rolePersona: '根据用户需求处理任务',
        seedRulesText: '注意安全，按用户要求输出结果。',
      }),
      confirmationTokenId: 'token-1',
    }), /blueprint admission rejected/)
    assert.equal(repo.rows.size, 0)
    assert.equal(existsSync(join(root, 'agents', 'visual-researcher', 'FOUNDATION.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint factory cleans written assets if registry create fails last', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    writeKnowledgeCard(store, 'knowledge/xhs-note.md', '小红书经验')
    const repo = registry({ throwOnCreate: true })
    assert.throws(() => deriveSpecialistAgentFromBlueprint(repo, store, {
      blueprint: blueprint({ migrationCandidates: ['knowledge/xhs-note.md'] }),
      confirmationTokenId: 'token-1',
      migrateCardRelPaths: ['knowledge/xhs-note.md'],
    }), /registry create failed/)
    assert.equal(existsSync(join(root, 'agents', 'visual-researcher', 'RULES.md')), false)
    assert.equal(store.readCard('agents/visual-researcher/knowledge/seed-01.md', { includeStaged: true }), null)
    assert.equal(store.readCard('agents/visual-researcher/knowledge/xhs-note.md', { includeStaged: true }), null)
    assert.equal(store.readCard('knowledge/xhs-note.md', { includeStaged: true })?.frontmatter.title, '小红书经验')
    assert.equal(store.readCard('knowledge/routing-visual-researcher.md', { includeStaged: true }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('blueprint factory rollback leaves the same blueprint retryable', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    writeKnowledgeCard(store, 'knowledge/xhs-note.md', '小红书经验')
    const base = registry()
    let failCreate = true
    const repo = {
      rows: base.rows,
      get: base.get,
      create: (input: Parameters<typeof base.create>[0]) => {
        if (failCreate) {
          failCreate = false
          throw new Error('registry create failed once')
        }
        return base.create(input)
      },
    }
    const input = {
      blueprint: blueprint({ migrationCandidates: ['knowledge/xhs-note.md'] }),
      confirmationTokenId: 'token-1',
      migrateCardRelPaths: ['knowledge/xhs-note.md'],
    }

    assert.throws(() => deriveSpecialistAgentFromBlueprint(repo, store, input), /registry create failed once/)
    assert.equal(existsSync(join(root, 'agents', 'visual-researcher', 'knowledge')), false)
    assert.equal(store.readCard('knowledge/xhs-note.md', { includeStaged: true })?.frontmatter.title, '小红书经验')

    const retried = deriveSpecialistAgentFromBlueprint(repo, store, input)
    assert.equal(retried.agent.id, 'visual-researcher')
    assert.deepEqual(retried.migratedCards, [{
      from: 'knowledge/xhs-note.md',
      to: 'agents/visual-researcher/knowledge/xhs-note.md',
    }])
    assert.equal(store.readCard('knowledge/xhs-note.md', { includeStaged: true }), null)
    assert.equal(store.readCard('agents/visual-researcher/knowledge/xhs-note.md', { includeStaged: true })?.frontmatter.title, '小红书经验')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
