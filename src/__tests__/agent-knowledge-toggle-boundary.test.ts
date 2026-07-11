import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import type { AgentExecutionProfile } from '../shared/agent-execution-profile'

test('turning off knowledge cards keeps the frozen Agent RULES in the prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-knowledge-toggle-'))
  try {
    writeFileSync(join(root, 'RULES.md'), 'GLOBAL_RULES', 'utf8')
    const profile: AgentExecutionProfile = {
      requestedAgentId: 'analyst', effectiveAgentId: 'analyst', personaRef: 'analyst', name: '智识',
      charter: '分析', personality: 'PERSONA', rules: 'ANALYST_RULES',
      knowledgeIndex: 'SECRET_KNOWLEDGE_INDEX', allowedKnowledgeRefs: ['agents/analyst/knowledge/secret.md'],
      knowledgeWriteOwnerAgentId: 'analyst', knowledgeWriteNamespace: 'agents/analyst/knowledge',
      executionMaterialHash: 'hash', readinessRevision: 'ready', redirectChain: [],
      readiness: { conversationReady: true, handoffReady: true, autoRoutable: true, collaborationReady: true, reasons: [] },
    }
    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      isKnowledgeSystemEnabled: () => false,
    })
    const result = await service.buildForScopedRun({
      scope: {
        id: 'scope-1', agent: 'analyst', activeAgentId: 'analyst', handoffGeneration: 0,
        title: '会话', sourceKind: 'local', sourceId: 'app', threadKey: 'scope-1', meta: {}, createdAt: 'now', updatedAt: 'now',
      },
      message: '分析一下', coordinators: [], executionProfile: profile,
    })
    const prompt = [result.systemPrompt, ...result.bootstrapMessages].join('\n')
    assert.match(prompt, /ANALYST_RULES/)
    assert.doesNotMatch(prompt, /SECRET_KNOWLEDGE_INDEX/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
