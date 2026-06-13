import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deriveSpecialistAgent, prepareSpecialistAgentDerivation } from '../main/modules/agent-control/agents/agent-factory'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-factory-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

function fm(over: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '候选',
    description: '多次出现同类请求',
    confidence: 'H',
    tag: 'aspire',
    created: '2026-06-13',
    status: 'staged',
    stage: 'candidate',
    ...over,
  }
}

function registry() {
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
      const record: AgentRegistryRecord = {
        id: input.id,
        name: input.name,
        charter: input.charter ?? null,
        personaRef: input.personaRef ?? null,
        status: 'active',
        parentAgentId: input.parentAgentId ?? null,
        derivationReason: input.derivationReason ?? null,
        mergedIntoAgentId: null,
        createdAt: '2026-06-13T00:00:00.000Z',
      }
      rows.set(record.id, record)
      return record
    },
  }
}

const CANDIDATE_BODY = [
  '- 2026-06-10 小红书采集',
  '- 2026-06-11 小红书采集',
  '- 2026-06-12 小红书采集',
].join('\n')

test('AgentFactory prepare phase is read-only until user confirmation commits the plan', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/collector-candidate.md',
      frontmatter: fm(),
      body: CANDIDATE_BODY,
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/xhs-note.md',
      frontmatter: fm({ title: '小红书经验', tag: 'knowledge', status: 'active', stage: undefined }),
      body: '逐张点开更稳。',
    }).ok)
    const repo = registry()
    const candidateBefore = readFileSync(join(root, 'knowledge', 'collector-candidate.md'), 'utf-8')
    const cardBefore = readFileSync(join(root, 'knowledge', 'xhs-note.md'), 'utf-8')

    const plan = prepareSpecialistAgentDerivation(repo, store, {
      specialistId: 'xhs.collector',
      name: '小红书采集员',
      charter: '处理小红书低频可见采集',
      candidateRelPath: 'knowledge/collector-candidate.md',
      seedRulesText: '# 小红书采集员\n- 低频可见采集。',
      routingTriggers: ['小红书', '采集'],
      migrateCardRelPaths: ['knowledge/xhs-note.md'],
      now: new Date('2026-06-13T12:00:00.000Z'),
    })

    assert.equal(plan.routingCardRelPath, 'knowledge/routing-xhs.collector.md')
    assert.deepEqual(plan.cardMigrations, [{ from: 'knowledge/xhs-note.md', to: 'agents/xhs.collector/knowledge/xhs-note.md' }])
    assert.equal(repo.rows.size, 0, 'prepare must not create an agent row')
    assert.equal(existsSync(join(root, 'agents', 'xhs.collector', 'RULES.md')), false, 'prepare must not write RULES')
    assert.equal(existsSync(join(root, 'knowledge', 'routing-xhs.collector.md')), false, 'prepare must not write routing card')
    assert.equal(readFileSync(join(root, 'knowledge', 'collector-candidate.md'), 'utf-8'), candidateBefore, 'prepare must not update candidate')
    assert.equal(readFileSync(join(root, 'knowledge', 'xhs-note.md'), 'utf-8'), cardBefore, 'prepare must not move selected cards')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('AgentFactory derives a specialist with lineage, RULES, staged routing card, migrated cards, and emerged candidate stage', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/collector-candidate.md',
      frontmatter: fm(),
      body: CANDIDATE_BODY,
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/xhs-note.md',
      frontmatter: fm({ title: '小红书经验', tag: 'knowledge', status: 'active', stage: undefined }),
      body: '逐张点开更稳。',
    }).ok)
    const repo = registry()

    const result = deriveSpecialistAgent(repo, store, {
      specialistId: 'xhs.collector',
      name: '小红书采集员',
      charter: '处理小红书低频可见采集',
      candidateRelPath: 'knowledge/collector-candidate.md',
      seedRulesText: '# 小红书采集员\n- 低频可见采集。',
      routingTriggers: ['小红书', '采集'],
      migrateCardRelPaths: ['knowledge/xhs-note.md'],
      now: new Date('2026-06-13T12:00:00.000Z'),
    })

    assert.equal(result.agent.parentAgentId, 'butler')
    assert.equal(result.agent.derivationReason, 'knowledge/collector-candidate.md')
    assert.equal(result.rulesRelPath, 'agents/xhs.collector/RULES.md')
    assert.ok(readFileSync(join(root, result.rulesRelPath), 'utf-8').includes('低频可见采集'))
    assert.ok(existsSync(join(root, 'agents', 'xhs.collector', 'knowledge', 'sites')))
    assert.deepEqual(result.migratedCards, [{ from: 'knowledge/xhs-note.md', to: 'agents/xhs.collector/knowledge/xhs-note.md' }])
    assert.equal(store.readCard('knowledge/xhs-note.md', { includeStaged: true }), null, 'selected cards move out of global scope')
    assert.ok(store.readCard('agents/xhs.collector/knowledge/xhs-note.md', { includeStaged: true }))

    const routing = store.readCard(result.routingCardRelPath, { includeStaged: true })
    assert.equal(routing?.frontmatter.status, 'staged', 'routing card defaults staged')
    assert.deepEqual(routing?.frontmatter.triggers, ['小红书', '采集'])
    const candidate = store.readCard('knowledge/collector-candidate.md', { includeStaged: true })
    assert.equal(candidate?.frontmatter.stage, 'emerged')
    assert.equal(candidate?.frontmatter.status, 'staged', 'candidate lifecycle status is untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('AgentFactory rejects invalid or duplicate specialist ids before writing', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/candidate.md',
      frontmatter: fm(),
      body: CANDIDATE_BODY,
    }).ok)
    const repo = registry()
    assert.throws(() => deriveSpecialistAgent(repo, store, {
      specialistId: 'BadUpper',
      name: '坏 ID',
      candidateRelPath: 'knowledge/candidate.md',
      seedRulesText: 'rules',
      routingTriggers: ['bad'],
    }), /lowercase slug/)
    repo.create({ id: 'exists', name: '已有' })
    assert.throws(() => deriveSpecialistAgent(repo, store, {
      specialistId: 'exists',
      name: '重复',
      candidateRelPath: 'knowledge/candidate.md',
      seedRulesText: 'rules',
      routingTriggers: ['重复'],
    }), /already exists/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('AgentFactory rejects ineligible candidates and bad routing triggers before any write', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/not-candidate.md',
      frontmatter: fm({ tag: 'knowledge', status: 'active', stage: undefined }),
      body: CANDIDATE_BODY,
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/weak-candidate.md',
      frontmatter: fm(),
      body: '- 2026-06-10 证据不足',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/candidate.md',
      frontmatter: fm(),
      body: CANDIDATE_BODY,
    }).ok)
    const repo = registry()
    const assertNoPartialWrite = (id: string) => {
      assert.equal(repo.rows.has(id), false, 'failed derivation must not create an agent row')
      assert.equal(existsSync(join(root, 'agents', id, 'RULES.md')), false, 'failed derivation must not write RULES')
      assert.equal(existsSync(join(root, 'knowledge', `routing-${id}.md`)), false, 'failed derivation must not write routing card')
    }

    assert.throws(() => deriveSpecialistAgent(repo, store, {
      specialistId: 'notcandidate',
      name: '非候选',
      candidateRelPath: 'knowledge/not-candidate.md',
      seedRulesText: 'rules',
      routingTriggers: ['正常'],
    }), /not an eligible staged candidate/)
    assertNoPartialWrite('notcandidate')

    assert.throws(() => deriveSpecialistAgent(repo, store, {
      specialistId: 'weakcandidate',
      name: '证据不足',
      candidateRelPath: 'knowledge/weak-candidate.md',
      seedRulesText: 'rules',
      routingTriggers: ['正常'],
    }), /at least 3 evidence dates/)
    assertNoPartialWrite('weakcandidate')

    assert.throws(() => deriveSpecialistAgent(repo, store, {
      specialistId: 'badtrigger',
      name: '坏触发词',
      candidateRelPath: 'knowledge/candidate.md',
      seedRulesText: 'rules',
      routingTriggers: ['小红书.*'],
    }), /invalid routing triggers/)
    assertNoPartialWrite('badtrigger')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
