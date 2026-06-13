/**
 * EP3-A3 — charter list + routing index injection (L1.5): MAIN agent
 * sessions only; sourced from the agents-table roster + ACTIVE
 * routing-*.md cards; budget-clipped; billed under L1_5_agent_routing;
 * empty state omits the section entirely.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { MAIN_AGENT_ID } from '../main/modules/repositories/agent-registry-repository'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

test('agent-routing-injection declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-routing-injection transitive sqlite load')
})

type RosterEntry = { id: string; name: string; charter: string | null; status: string }

function scope(agent: string): ConversationScope {
  return {
    id: `scope-${agent}`, agent, title: '会话', sourceKind: 'local', sourceId: 'app',
    threadKey: `scope-${agent}`, meta: {},
    createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
  }
}

function routingCard(status: string, title: string): string {
  return ['---', `title: ${title}`, 'description: 该域请求转交专项 agent', 'confidence: H', 'tag: self',
    'created: 2026-06-12', `status: ${status}`, '---', '正文'].join('\n')
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-a3-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

function makeService(root: string, roster: RosterEntry[]): PromptAssemblyService {
  return new PromptAssemblyService({
    getMemoryRoot: () => root,
    getScopeMessages: () => [],
    getBeliefCardStore: () => new BeliefCardStore({ memoryRoot: root }),
    getAgentRoster: () => roster,
  })
}

const ROSTER: RosterEntry[] = [
  { id: MAIN_AGENT_ID, name: '管家', charter: '主 agent', status: 'active' },
  { id: 'collector', name: '采集手', charter: '负责小红书与微博采集 CHARTER_MARKER', status: 'active' },
  { id: 'retired-one', name: '退休者', charter: '不该出现 RETIRED_MARKER', status: 'retired' },
]

async function build(svc: PromptAssemblyService, agent: string) {
  const result = await svc.buildForScopedRun({ scope: scope(agent), message: '随便聊聊', coordinators: [] })
  return { result, injected: [result.systemPrompt, ...result.bootstrapMessages].join('\n') }
}

test('main session injects charter list + ACTIVE routing cards; staged routing never appears', async () => {
  const root = makeRoot()
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    writeFileSync(join(root, 'knowledge', 'routing-collector.md'), routingCard('active', 'ACTIVE_ROUTING_MARKER'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'routing-writer.md'), routingCard('staged', 'STAGED_ROUTING_MARKER'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'routing-retired-one.md'), routingCard('active', 'RETIRED_ROUTING_MARKER'), 'utf-8')
    const { injected } = await build(makeService(root, ROSTER), MAIN_AGENT_ID)
    assert.ok(injected.includes('## 专项 agent 与路由索引'))
    assert.ok(injected.includes('CHARTER_MARKER'), 'specialized charter listed')
    assert.ok(injected.includes('ACTIVE_ROUTING_MARKER'), 'active routing card listed')
    assert.ok(!injected.includes('STAGED_ROUTING_MARKER'), 'staged routing card stays quarantined')
    assert.ok(!injected.includes('RETIRED_MARKER'), 'non-active roster rows filtered')
    assert.ok(!injected.includes('RETIRED_ROUTING_MARKER'), 'routing cards targeting non-active agents are filtered')
    assert.ok(!injected.includes('管家（butler）'), 'the main agent never lists itself')

    const bill = events.find((event) => event.metric === 'context_bill')
    const sections = (bill as unknown as { sections: Record<string, number> }).sections
    assert.ok((sections.L1_5_agent_routing ?? 0) > 0, 'billed under L1_5_agent_routing')
  } finally {
    __setMetricSinkForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('specialized sessions NEVER see the section — 主 agent 保持薄的反面约束', async () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, 'knowledge', 'routing-collector.md'), routingCard('active', 'ACTIVE_ROUTING_MARKER'), 'utf-8')
    const { injected } = await build(makeService(root, ROSTER), 'collector')
    assert.ok(!injected.includes('## 专项 agent 与路由索引'), 'routing section absent')
    assert.ok(!injected.includes('CHARTER_MARKER'), '专项会话不注入彼此 charter')
    assert.ok(!injected.includes('路由索引：'), 'routing index listing absent')
    // note: the active routing card may still surface through the L1.5
    // knowledge INDEX — that is pre-existing K3 behavior for any active
    // card, not the A3 charter/routing section.
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('empty roster and no routing cards omit the section; bill entry is zero', async () => {
  const root = makeRoot()
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const onlyMain = [ROSTER[0]]
    const { injected } = await build(makeService(root, onlyMain), MAIN_AGENT_ID)
    assert.ok(!injected.includes('## 专项 agent 与路由索引'), '空表/无路由卡 → 段省略')
    const bill = events.find((event) => event.metric === 'context_bill')
    const sections = (bill as unknown as { sections: Record<string, number> }).sections
    assert.equal(sections.L1_5_agent_routing ?? 0, 0)
  } finally {
    __setMetricSinkForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('section is budget-clipped with the shared truncation marker', async () => {
  const root = makeRoot()
  try {
    const fatRoster: RosterEntry[] = [
      ROSTER[0],
      { id: 'fat-one', name: '长篇手', charter: `${'章'.repeat(700)}TAIL_MARKER`, status: 'active' },
    ]
    const { result } = await build(makeService(root, fatRoster), MAIN_AGENT_ID)
    const section = result.bootstrapMessages.find((message) => message.includes('## 专项 agent 与路由索引'))
    assert.ok(section, 'section renders')
    assert.ok(section!.includes('...[truncated]'), 'over-budget charter clipped')
    assert.ok(!section!.includes('TAIL_MARKER'), 'clipped tail not injected')
    assert.ok(section!.length <= 600 + 80, 'stays near the 600-char budget plus header/marker')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
