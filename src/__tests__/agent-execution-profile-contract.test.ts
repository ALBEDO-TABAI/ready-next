import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentExecutionProfileResolver } from '../main/modules/agent-control/agents/agent-execution-profile'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import { BUILTIN_AGENT_PRESETS } from '../main/modules/agent-control/agents/builtin-agent-presets'

function registry(rows: AgentRegistryRecord[]) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return { get: (id: string) => byId.get(id) ?? null }
}

const baseRows: AgentRegistryRecord[] = [
  { id: 'butler', name: 'Ready', charter: '主 Agent', personaRef: 'butler', status: 'active', parentAgentId: null, derivationReason: null, mergedIntoAgentId: null, createdAt: 'now' },
  { id: 'analyst', name: '智识', charter: '分析', personaRef: 'analyst', status: 'active', parentAgentId: 'butler', derivationReason: null, mergedIntoAgentId: null, createdAt: 'now' },
  { id: 'old-analyst', name: '旧智识', charter: '旧', personaRef: 'old-analyst', status: 'merged', parentAgentId: 'butler', derivationReason: null, mergedIntoAgentId: 'analyst', createdAt: 'now' },
]

function resolver(rows = baseRows, knowledgeBody = '正文一', knowledgeEnabled = true) {
  return new AgentExecutionProfileResolver({
    registry: registry(rows),
    personality: { getPersonality: async (id) => ({ personalityText: `persona:${id}` }) },
    getKnowledgeStore: () => ({
      listCards: ({ dir } = {}) => dir?.includes('analyst')
        ? [{ relPath: 'agents/analyst/knowledge/a.md', body: knowledgeBody, frontmatter: { status: 'active', title: 'A', description: 'A', confidence: 'H' } }]
        : [],
      listRoutingCards: () => [{ targetAgentId: 'analyst', relPath: 'knowledge/routing-analyst.md' }],
      renderKnowledgeIndex: ({ ownerAgentId }) => ownerAgentId === 'analyst' ? ({
        text: '- A（H）: A → agents/analyst/knowledge/a.md',
        renderedRelPaths: ['agents/analyst/knowledge/a.md'],
      }) : ({ text: '', renderedRelPaths: [] }),
    }),
    readAsset: (path) => path.includes('analyst/RULES.md') ? 'analyst rules' : path.includes('analyst/FOUNDATION.md') ? BUILTIN_AGENT_PRESETS.analyst!.foundation : 'main fallback',
    isKnowledgeEnabled: () => knowledgeEnabled,
  })
}

test('profile resolves persona, rules and knowledge from the same effective agent', async () => {
  const profile = await resolver().resolve('analyst')
  assert.equal(profile.effectiveAgentId, 'analyst')
  assert.equal(profile.personality, 'persona:analyst')
  assert.equal(profile.rules, 'analyst rules')
  assert.deepEqual(profile.allowedKnowledgeRefs, ['agents/analyst/knowledge/a.md'])
  assert.equal(profile.readiness.collaborationReady, true)
})

test('execution material hash changes when active knowledge body changes', async () => {
  const before = await resolver(baseRows, '正文一').resolve('analyst')
  const after = await resolver(baseRows, '正文二').resolve('analyst')
  assert.notEqual(before.executionMaterialHash, after.executionMaterialHash)
})

test('knowledge toggle removes cards and allowlist without removing agent rules', async () => {
  const profile = await resolver(baseRows, '正文一', false).resolve('analyst')
  assert.equal(profile.rules, 'analyst rules')
  assert.equal(profile.knowledgeIndex, '')
  assert.deepEqual(profile.allowedKnowledgeRefs, [])
})

test('merged ids redirect while missing and disabled ids fall back without reading sibling assets', async () => {
  const merged = await resolver().resolve('old-analyst')
  assert.equal(merged.effectiveAgentId, 'analyst')
  assert.deepEqual(merged.redirectChain, [{ from: 'old-analyst', to: 'analyst', reason: 'merged' }])

  const missing = await resolver().resolve('missing-agent')
  assert.equal(missing.effectiveAgentId, 'butler')
  assert.equal(missing.allowedKnowledgeRefs.includes('agents/analyst/knowledge/a.md'), false)
})
