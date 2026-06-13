import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  agentDerivationGroup,
  _agentDerivationGroupChannelsForTest,
  type AgentDerivationGroupDeps,
} from '../main/modules/claude-bridge/ipc/agent-derivation-group'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

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
  const root = mkdtempSync(join(tmpdir(), 'ready-agent-derivation-flow-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

function fm(overrides: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '专项 agent 候选：小红书行情采集',
    description: '同域相似请求 3 次（candidate）',
    confidence: 'M',
    tag: 'aspire',
    created: '2026-06-13',
    status: 'staged',
    stage: 'candidate',
    ...overrides,
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

test('agentDerivationGroup registers and disposes derivation channels', () => {
  const { ipc, handlers, removeHandlerCalls } = createMockIpc()
  const root = makeRoot()
  try {
    const deps: AgentDerivationGroupDeps = {
      getBeliefCardStore: () => new BeliefCardStore({ memoryRoot: root }),
      getAgentRegistry: () => registry(),
    }
    const handle = agentDerivationGroup.register(ipc, deps)
    assert.deepEqual([...handlers.keys()].sort(), [..._agentDerivationGroupChannelsForTest].sort())
    assert.equal(agentDerivationGroup.namespace, 'agent:derivation')

    const baseline = removeHandlerCalls.length
    handle.dispose()
    assert.deepEqual(removeHandlerCalls.slice(baseline).sort(), [..._agentDerivationGroupChannelsForTest].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent derivation preview is read-only; confirm creates the specialist and routing card', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/agent-candidate-domain.md',
      frontmatter: fm(),
      body: [
        '最近在「小红书行情采集」域观察到重复出现的相似请求（观察记录，非定性）：',
        '',
        '- 2026-06-10 [stable] 采集小红书行情',
        '- 2026-06-11 [stable] 再采一轮小红书行情',
        '- 2026-06-12 [stable] 小红书行情再来一次',
      ].join('\n'),
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/xhs-note.md',
      frontmatter: fm({ title: '小红书经验', description: '小红书行情采集经验', tag: 'knowledge', status: 'active', stage: undefined }),
      body: '小红书行情采集时逐张点开更稳。',
    }).ok)
    const repo = registry()
    const deps: AgentDerivationGroupDeps = {
      getBeliefCardStore: () => store,
      getAgentRegistry: () => repo,
    }
    agentDerivationGroup.register(ipc, deps)

    const beforeCandidate = readFileSync(join(root, 'knowledge', 'agent-candidate-domain.md'), 'utf-8')
    const list = await handlers.get('agent:derivation:listCandidates')?.({} as IpcMainInvokeEvent)
    assert.equal(repo.rows.size, 0, 'preview must not create an agent')
    assert.equal(existsSync(join(root, 'agents', 'domain', 'RULES.md')), false, 'preview must not write RULES')
    assert.equal(existsSync(join(root, 'knowledge', 'routing-domain.md')), false, 'preview must not write routing card')
    assert.equal(readFileSync(join(root, 'knowledge', 'agent-candidate-domain.md'), 'utf-8'), beforeCandidate)
    assert.deepEqual((list as { data: unknown[] }).data.length, 1)
    const candidate = (list as { data: Array<{ defaultSpecialistId: string; migrationCandidates: Array<{ relPath: string }> }> }).data[0]
    assert.equal(candidate.defaultSpecialistId, 'domain')
    assert.deepEqual(candidate.migrationCandidates.map((item) => item.relPath), ['knowledge/xhs-note.md'])

    const confirmed = await handlers.get('agent:derivation:confirm')?.({} as IpcMainInvokeEvent, {
      candidateRelPath: 'knowledge/agent-candidate-domain.md',
      specialistId: 'xhs.collector',
      name: '小红书采集员',
      charter: '处理小红书低频可见采集',
      seedRulesText: '# 小红书采集员\n- 低频可见采集。',
      routingTriggers: ['小红书', '采集'],
      activateRouting: true,
      migrateCardRelPaths: ['knowledge/xhs-note.md'],
    })
    assert.equal((confirmed as { success: boolean }).success, true)
    assert.equal(repo.rows.get('xhs.collector')?.derivationReason, 'knowledge/agent-candidate-domain.md')
    assert.ok(readFileSync(join(root, 'agents', 'xhs.collector', 'RULES.md'), 'utf-8').includes('低频可见采集'))
    assert.equal(store.readCard('knowledge/xhs-note.md', { includeStaged: true }), null)
    assert.ok(store.readCard('agents/xhs.collector/knowledge/xhs-note.md', { includeStaged: true }))
    assert.equal(store.readCard('knowledge/routing-xhs.collector.md', { includeStaged: true })?.frontmatter.status, 'active')
    assert.equal(store.readCard('knowledge/agent-candidate-domain.md', { includeStaged: true })?.frontmatter.stage, 'emerged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent derivation confirm only migrates cards offered in the preview list', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/agent-candidate-domain.md',
      frontmatter: fm(),
      body: [
        '- 2026-06-10 小红书行情',
        '- 2026-06-11 小红书行情',
        '- 2026-06-12 小红书行情',
      ].join('\n'),
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/unrelated.md',
      frontmatter: fm({ title: '无关知识', description: '无关', tag: 'knowledge', status: 'active', stage: undefined }),
      body: '不能被该候选清单迁移。',
    }).ok)
    const repo = registry()
    agentDerivationGroup.register(ipc, {
      getBeliefCardStore: () => store,
      getAgentRegistry: () => repo,
    })

    const confirmed = await handlers.get('agent:derivation:confirm')?.({} as IpcMainInvokeEvent, {
      candidateRelPath: 'knowledge/agent-candidate-domain.md',
      specialistId: 'xhs.collector',
      name: '小红书采集员',
      charter: '处理小红书低频可见采集',
      seedRulesText: '# 小红书采集员',
      routingTriggers: ['小红书'],
      migrateCardRelPaths: ['knowledge/unrelated.md'],
    })
    assert.equal((confirmed as { success: boolean }).success, false)
    assert.match((confirmed as { error?: string }).error || '', /not offered/)
    assert.equal(repo.rows.size, 0, 'rejected IPC payload must not create an agent')
    assert.ok(store.readCard('knowledge/unrelated.md', { includeStaged: true }), 'unoffered card remains in place')
    assert.equal(existsSync(join(root, 'agents', 'xhs.collector', 'RULES.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent derivation reject marks the staged candidate rejected and removes it from preview results', async () => {
  const { ipc, handlers } = createMockIpc()
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/agent-candidate-domain.md',
      frontmatter: fm(),
      body: [
        '- 2026-06-10 小红书行情',
        '- 2026-06-11 小红书行情',
        '- 2026-06-12 小红书行情',
      ].join('\n'),
    }).ok)
    agentDerivationGroup.register(ipc, {
      getBeliefCardStore: () => store,
      getAgentRegistry: () => registry(),
    })

    const rejected = await handlers.get('agent:derivation:reject')?.({} as IpcMainInvokeEvent, {
      candidateRelPath: 'knowledge/agent-candidate-domain.md',
    })
    assert.equal((rejected as { success: boolean }).success, true)
    assert.deepEqual((rejected as { data: unknown[] }).data, [])
    assert.equal(store.readCard('knowledge/agent-candidate-domain.md', { includeStaged: true })?.frontmatter.status, 'rejected')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
