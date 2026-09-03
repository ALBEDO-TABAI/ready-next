import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSemanticSkillAuthorizationForTurn } from '../main/modules/agent-control/runtime-core/skill-turn-authorization-resolver'
import type { SkillContextOrchestratorLike } from '../main/modules/agent-control/runtime-core/agent-sdk-types'

function orchestrator(calls: string[]): SkillContextOrchestratorLike {
  return {
    observeCurrentReferenceSkillHint: () => {
      calls.push('observe')
      return { id: 'fixture-skill', name: 'Fixture Skill', applicableToolNames: [] }
    },
    peekCurrentReferenceSkillHint: () => {
      calls.push('peek')
      return { id: 'fixture-skill', name: 'Fixture Skill', applicableToolNames: [] }
    },
    getCurrentReferenceSkillHint: () => {
      calls.push('get')
      return { id: 'fixture-skill', name: 'Fixture Skill', applicableToolNames: [] }
    },
    findExplicitlyRequestedSkills: (text) => {
      calls.push(`find:${text}`)
      return text.includes('fixture-skill')
        ? [{ id: 'fixture-skill', name: 'Fixture Skill' }]
        : []
    },
    buildPreferredSkillToolNames: (_text, _sessionId, hint) => {
      calls.push(`build:${hint?.id || 'none'}`)
      return []
    },
    rememberExplicitReferenceSkillHint: () => {
      calls.push('remember-explicit')
      return true
    },
    rememberReferenceSkillToolApplicability: () => {
      calls.push('remember-tools')
      return true
    },
  }
}

test('observe resolves from one captured hint and performs zero hint writes', () => {
  const calls: string[] = []
  const observedHint = {
    id: 'fixture-skill', name: 'Fixture Skill', applicableToolNames: [],
  }
  const authorization = resolveSemanticSkillAuthorizationForTurn({
    mode: 'observe',
    message: '继续处理',
    sessionId: 'scope-1',
    messageVisibilityEpoch: 2,
    skillHintRelevantForTurn: true,
    observedReferenceHint: observedHint,
    orchestrator: orchestrator(calls),
  })
  assert.equal(authorization.mode, 'selected')
  assert.equal(calls.filter((call) => call === 'observe').length, 0)
  assert.equal(calls.some((call) => ['peek', 'get', 'remember-explicit', 'remember-tools'].includes(call)), false)
  assert.ok(calls.some((call) => call === 'build:fixture-skill'))
})

test('commit keeps the ordinary mutation path explicit', () => {
  const calls: string[] = []
  const authorization = resolveSemanticSkillAuthorizationForTurn({
    mode: 'commit',
    message: '继续处理',
    sessionId: 'scope-1',
    messageVisibilityEpoch: 2,
    skillHintRelevantForTurn: true,
    orchestrator: orchestrator(calls),
  })
  assert.equal(authorization.mode, 'selected')
  assert.ok(calls.includes('get'))
  assert.ok(calls.includes('remember-tools'))
})
