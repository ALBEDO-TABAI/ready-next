import assert from 'node:assert/strict'
import test from 'node:test'

import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import {
  buildCodexRetryAuthorizationRequest,
  resolveCodexProductTurnAuthorization,
} from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

function request(): SendScopedRequest {
  return {
    scopeId: 'scope-1', requestId: 'request-1', message: '再试一次',
    userMessage: {
      id: 'control-r', content: '再试一次', timestamp: '2026-09-02T00:00:00.000Z',
      meta: {},
      attachmentConfirmation: {
        selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0,
      },
    },
    explicitRetry: { predecessorRunId: 'run-b', predecessorPresentationDigest: 'a'.repeat(64) },
  }
}

const scope = {
  id: 'scope-1', aliasGeneration: 1, messageVisibilityEpoch: 0,
  agent: 'butler', activeAgentId: 'butler', handoffGeneration: 0, title: 't',
  sourceKind: 'local' as const, sourceId: 'app', threadKey: 'scope-1', meta: {},
  createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
}

test('retry authorization evaluates semantic task root B rather than control R', () => {
  const effective = buildCodexRetryAuthorizationRequest(request(), [
    { type: 'text', text: '继续总结第五章', text_elements: [] },
  ])
  assert.equal(effective.message, '继续总结第五章')
  assert.equal(effective.userMessage.content, '继续总结第五章')
  assert.equal(effective.explicitRetry, undefined)
})

test('product authorization forwards observe versus commit to the only resolver', () => {
  const modes: string[] = []
  for (const mode of ['observe', 'commit'] as const) {
    resolveCodexProductTurnAuthorization({
      mode,
      host: {
        getScope: () => scope,
        resolveSkillAuthorizationForTurn: (input) => {
          modes.push(input.mode)
          return buildExplicitNoSkillAuthorization('no_skill_signal')
        },
      },
      request: request(), scopeId: 'scope-1', externalReadSlice: null,
    })
  }
  assert.deepEqual(modes, ['observe', 'commit'])
})
