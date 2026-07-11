import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentExecutionProfileResolver } from '../main/modules/agent-control/agents/agent-execution-profile'
import { BUILTIN_AGENT_PRESETS } from '../main/modules/agent-control/agents/builtin-agent-presets'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'

const rows: AgentRegistryRecord[] = [
  { id: 'butler', name: 'Ready', charter: '主', personaRef: 'butler', status: 'active', parentAgentId: null, derivationReason: null, mergedIntoAgentId: null, createdAt: 'now' },
  ...(['copywriter', 'video-editor', 'analyst'] as const).map((id) => ({
    id, name: id, charter: `${id} charter`, personaRef: id, status: 'active' as const,
    parentAgentId: 'butler', derivationReason: null, mergedIntoAgentId: null, createdAt: 'now',
  })),
  { id: 'persona-only', name: 'Persona', charter: '聊聊', personaRef: 'persona-only', status: 'active', parentAgentId: 'butler', derivationReason: null, mergedIntoAgentId: null, createdAt: 'now' },
]

function makeResolver(options: { routing?: string[]; personaRules?: boolean; personaFoundation?: string } = {}) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return new AgentExecutionProfileResolver({
    registry: { get: (id) => byId.get(id) ?? null },
    personality: { getPersonality: async (id) => ({ personalityText: `persona:${id}` }) },
    readAsset: (path) => {
      const id = rows.find((row) => path.includes(`agents/${row.id}/`))?.id
      if (!id) return 'main soul'
      if (path.endsWith('/RULES.md')) return id === 'persona-only' && !options.personaRules ? '' : `${id} rules`
      if (path.endsWith('/FOUNDATION.md')) {
        if (id === 'persona-only') return options.personaFoundation ?? ''
        return BUILTIN_AGENT_PRESETS[id as keyof typeof BUILTIN_AGENT_PRESETS]?.foundation ?? ''
      }
      return ''
    },
    getKnowledgeStore: () => ({
      listCards: () => [],
      listRoutingCards: () => (options.routing ?? ['copywriter', 'video-editor', 'analyst']).map((targetAgentId) => ({ targetAgentId, relPath: `knowledge/routing-${targetAgentId}.md` })),
      renderKnowledgeIndex: () => ({ text: '', renderedRelPaths: [] }),
    }),
    isKnowledgeEnabled: () => true,
  })
}

test('disabled and merged agents are not presented as ready even though execution can redirect', () => {
  const mutable = rows.map((row) => ({ ...row }))
  mutable.find((row) => row.id === 'video-editor')!.status = 'disabled'
  const merged = mutable.find((row) => row.id === 'copywriter')!
  merged.status = 'merged'
  merged.mergedIntoAgentId = 'analyst'
  const resolver = new AgentExecutionProfileResolver({
    registry: { get: (id) => mutable.find((row) => row.id === id) ?? null },
    personality: { getPersonality: async () => null },
    readAsset: () => '',
    getKnowledgeStore: () => ({ listCards: () => [], listRoutingCards: () => [], renderKnowledgeIndex: () => ({ text: '', renderedRelPaths: [] }) }),
    isKnowledgeEnabled: () => true,
  })

  assert.deepEqual(resolver.resolveReadiness('video-editor'), {
    conversationReady: false, handoffReady: false, autoRoutable: false, collaborationReady: false,
    reasons: ['agent_inactive'],
  })
  assert.deepEqual(resolver.resolveReadiness('copywriter'), {
    conversationReady: false, handoffReady: false, autoRoutable: false, collaborationReady: false,
    reasons: ['agent_merged'],
  })
})

test('the three builtin specialists pass every readiness gate from their mechanical preset packs', async () => {
  const resolver = makeResolver()
  for (const id of ['copywriter', 'video-editor', 'analyst']) {
    const profile = await resolver.resolve(id)
    assert.deepEqual(profile.readiness, {
      conversationReady: true,
      handoffReady: true,
      autoRoutable: true,
      collaborationReady: true,
      reasons: [],
    }, id)
  }
})

test('persona-only remains manually chat-ready but cannot route, handoff, or collaborate', async () => {
  const profile = await makeResolver({ routing: [] }).resolve('persona-only')
  assert.equal(profile.readiness.conversationReady, true)
  assert.equal(profile.readiness.handoffReady, false)
  assert.equal(profile.readiness.autoRoutable, false)
  assert.equal(profile.readiness.collaborationReady, false)
  assert.ok(profile.readiness.reasons.includes('rules_missing'))
  assert.ok(profile.readiness.reasons.includes('foundation_missing'))
})

test('an arbitrary nonempty foundation is not accepted as a collaboration pack', async () => {
  const profile = await makeResolver({ routing: ['persona-only'], personaRules: true, personaFoundation: 'looks plausible' }).resolve('persona-only')
  assert.equal(profile.readiness.handoffReady, true)
  assert.equal(profile.readiness.autoRoutable, true)
  assert.equal(profile.readiness.collaborationReady, false)
  assert.ok(profile.readiness.reasons.includes('foundation_invalid'))
})
