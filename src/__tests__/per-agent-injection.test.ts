/**
 * EP3-A2 — per-agent RULES/knowledge injection base (owner parameterized).
 * Owner comes from a FIXTURE projection's ownerAgentId (A1 column; the real
 * adoption→owner-switch e2e lands in A4). Asserts: owner X vs Y snapshots
 * differ; no owner falls back to scope.agent; sibling-agent zero leakage;
 * global+agent RULES share the single 2000-char budget; hostile owner ids
 * degrade to global-only.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import { BeliefCardStore, agentScopeKnowledgeDir } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

function scope(agent = 'butler'): ConversationScope {
  return {
    id: `scope-${agent}`, agent, title: '测试会话', sourceKind: 'local', sourceId: 'app',
    threadKey: `scope-${agent}`, meta: {},
    createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
  }
}

/** Fixture projection rows — the A1 column drives owner resolution. */
function projection(ownerAgentId: string | null): TaskProjectionRecord {
  return {
    taskId: `task-${ownerAgentId ?? 'none'}`, scopeId: 's1', runId: 'r1',
    taskType: 'multi_step_task', module: 'system', status: 'running',
    interactionState: 'running', steps: [], ownerAgentId,
    createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
  } as TaskProjectionRecord
}

function card(title: string, status = 'active'): string {
  return ['---', `title: ${title}`, 'description: 一句话', 'confidence: H', 'tag: knowledge',
    'created: 2026-06-12', `status: ${status}`, '---', `${title} 正文`].join('\n')
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-a2-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  mkdirSync(join(root, 'agents', 'agent-x', 'knowledge'), { recursive: true })
  mkdirSync(join(root, 'agents', 'agent-y', 'knowledge'), { recursive: true })
  writeFileSync(join(root, 'knowledge', 'global.md'), card('GLOBAL_CARD'), 'utf-8')
  writeFileSync(join(root, 'RULES.md'), 'GLOBAL_RULES_MARKER', 'utf-8')
  writeFileSync(join(root, 'agents', 'agent-x', 'knowledge', 'x.md'), card('X_AGENT_CARD'), 'utf-8')
  writeFileSync(join(root, 'agents', 'agent-x', 'RULES.md'), 'X_RULES_MARKER', 'utf-8')
  writeFileSync(join(root, 'agents', 'agent-y', 'knowledge', 'y.md'), card('Y_AGENT_CARD'), 'utf-8')
  writeFileSync(join(root, 'agents', 'agent-y', 'RULES.md'), 'Y_RULES_MARKER', 'utf-8')
  return root
}

function makeService(root: string): PromptAssemblyService {
  return new PromptAssemblyService({
    getMemoryRoot: () => root,
    getScopeMessages: () => [],
    getBeliefCardStore: () => new BeliefCardStore({ memoryRoot: root }),
  })
}

async function build(svc: PromptAssemblyService, ownerAgentId?: string | null, scopeAgent = 'butler') {
  const result = await svc.buildForScopedRun({
    scope: scope(scopeAgent), message: '随便聊聊', coordinators: [], ownerAgentId,
  })
  return { result, injected: [result.systemPrompt, ...result.bootstrapMessages].join('\n') }
}

test('owner X vs owner Y produce different snapshots; each sees own scope + global, never the sibling', async () => {
  const root = makeRoot()
  try {
    const svc = makeService(root)
    const x = await build(svc, projection('agent-x').ownerAgentId)
    const y = await build(svc, projection('agent-y').ownerAgentId)

    assert.notEqual(x.injected, y.injected, 'owner switches the injection snapshot')
    for (const [snapshot, own, ownRules, foreign, foreignRules] of [
      [x, 'X_AGENT_CARD', 'X_RULES_MARKER', 'Y_AGENT_CARD', 'Y_RULES_MARKER'],
      [y, 'Y_AGENT_CARD', 'Y_RULES_MARKER', 'X_AGENT_CARD', 'X_RULES_MARKER'],
    ] as const) {
      assert.ok(snapshot.injected.includes(own), `${own} present for its owner`)
      assert.ok(snapshot.injected.includes(ownRules), `${ownRules} present for its owner`)
      assert.ok(snapshot.injected.includes('GLOBAL_CARD'), 'global knowledge stays shared')
      assert.ok(snapshot.injected.includes('GLOBAL_RULES_MARKER'), 'global rules stay shared')
      assert.ok(!snapshot.injected.includes(foreign), `${foreign} never leaks across agents`)
      assert.ok(!snapshot.injected.includes(foreignRules), `${foreignRules} never leaks across agents`)
    }
    // 作用域优先：owner cards render before global, owner rules before global
    const index = x.result.bootstrapMessages.find((m) => m.includes('## 知识索引'))!
    assert.ok(index.indexOf('X_AGENT_CARD') < index.indexOf('GLOBAL_CARD'), 'owner-scope cards render first')
    assert.ok(x.result.systemPrompt.indexOf('X_RULES_MARKER') < x.result.systemPrompt.indexOf('GLOBAL_RULES_MARKER'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no owner falls back to scope.agent; default butler scope behaves exactly like before A2', async () => {
  const root = makeRoot()
  try {
    const svc = makeService(root)
    // scope.agent = agent-y, no explicit owner → Y scope injected
    const fallback = await build(svc, projection(null).ownerAgentId, 'agent-y')
    assert.ok(fallback.injected.includes('Y_AGENT_CARD'))
    assert.ok(fallback.injected.includes('Y_RULES_MARKER'))
    assert.ok(!fallback.injected.includes('X_AGENT_CARD'))
    // butler scope with no agents/butler dir → 存量零感知: global only
    const legacy = await build(svc, undefined, 'butler')
    assert.ok(legacy.injected.includes('GLOBAL_CARD') && legacy.injected.includes('GLOBAL_RULES_MARKER'))
    for (const banned of ['X_AGENT_CARD', 'Y_AGENT_CARD', 'X_RULES_MARKER', 'Y_RULES_MARKER']) {
      assert.ok(!legacy.injected.includes(banned), `${banned} absent without owner scope`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('staged ban extends to per-agent dirs; hostile owner ids degrade to global-only', async () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, 'agents', 'agent-x', 'knowledge', 'staged.md'), card('X_STAGED_CARD', 'staged'), 'utf-8')
    const svc = makeService(root)
    const x = await build(svc, 'agent-x')
    assert.ok(!x.injected.includes('X_STAGED_CARD'), 'staged cards stay quarantined in agent scope too')

    // traversal-shaped ids resolve to NO agent dir, never a path fragment
    assert.equal(agentScopeKnowledgeDir('../escape'), null)
    assert.equal(agentScopeKnowledgeDir('..'), null)
    assert.equal(agentScopeKnowledgeDir('a/b'), null)
    const hostile = await build(svc, '../agent-x', 'butler')
    assert.ok(!hostile.injected.includes('X_AGENT_CARD'), 'hostile owner id falls back, no scope read')
    assert.ok(hostile.injected.includes('GLOBAL_CARD'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('global+agent RULES share the single 2000-char budget; owner rules survive, global tail clips', async () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, 'agents', 'agent-x', 'RULES.md'), `X_HEAD_MARKER${'规'.repeat(1200)}`, 'utf-8')
    writeFileSync(join(root, 'RULES.md'), `${'则'.repeat(1200)}GLOBAL_TAIL_MARKER`, 'utf-8')
    const x = await build(makeService(root), 'agent-x')
    const rulesSection = x.result.systemPrompt.slice(x.result.systemPrompt.indexOf('## 运行规则'))
    assert.ok(rulesSection.includes('X_HEAD_MARKER'), 'owner-scope head survives (作用域优先)')
    assert.ok(rulesSection.includes('...[truncated]'), 'combined overflow carries the truncation marker')
    assert.ok(!rulesSection.includes('GLOBAL_TAIL_MARKER'), 'tail beyond the COMBINED 2000 budget is clipped')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
