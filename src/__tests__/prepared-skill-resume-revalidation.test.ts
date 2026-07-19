import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPreparedSkillTurnTruth,
  revalidateSavedSkillAuthorization,
  resolveCurrentLegalAuthorizationForSavedSkill,
} from '../main/modules/agent-control/skills/prepared-skill-turn'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  resolvePreparedSkillTurnAuthority,
  resolveTurnTextPolicyDecision,
} from '../main/modules/agent-control/runtime-core/agent-sdk-turn-preparation'
import { classifyFollowupIntent } from '../shared/agent-followup-intent'

function savedPreparedSkill() {
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'demo-skill',
    allowedTypedActions: ['skill_demo_run'],
    allowedPrimitives: ['skill_read_artifact'],
    source: 'trusted_resume',
    reason: 'checkpoint_fixture',
  })
  return buildPreparedSkillTurnTruth({
    identity: {
      mode: 'skill',
      relation: 'resume',
      skillId: 'demo-skill',
      skillName: 'Demo Skill',
      confidence: 'trusted_handle',
      source: 'run_state_resource',
      contextText: 'original request text',
    },
    authorization,
    requestOrResourceAnchorDigest: 'anchor-digest',
    floors: {
      toolNames: new Set(['skill_demo_run', 'skill_read_artifact']),
      reasons: ['skill_selected:demo-skill'],
    },
    surface: { composition: 'additive', exclusiveScopeRef: null },
  })
}

test('durable prepared skill bypasses semantic selection when hint and user text differ', () => {
  const saved = savedPreparedSkill()
  let semanticCalls = 0
  const currentLegal = resolveCurrentLegalAuthorizationForSavedSkill({
    saved,
    skillPresent: true,
    currentActionOwners: new Map([
      ['skill_demo_run', 'demo-skill'],
      ['skill_other_run', 'other-skill'],
    ]),
    currentAllowedPrimitives: new Set(['skill_read_artifact']),
  })

  for (const changedTurn of [
    { userText: 'completely different text', hint: null },
    { userText: 'another request', hint: 'another-skill' },
  ]) {
    const resolved = resolvePreparedSkillTurnAuthority({
      durablePreparedSkill: saved,
      resolveSaved: () => currentLegal,
      resolveSemantic: () => {
        semanticCalls += 1
        throw new Error(`semantic resolver must not inspect ${changedTurn.userText}/${changedTurn.hint}`)
      },
    })
    assert.equal(resolved.identity, saved.identity)
    assert.equal(resolved.authorization, currentLegal)
  }
  assert.equal(semanticCalls, 0)
})

test('saved skill resume keeps the exact checkpoint surface and rejects registry narrowing', () => {
  const saved = savedPreparedSkill()
  const currentLegal = resolveCurrentLegalAuthorizationForSavedSkill({
    saved,
    skillPresent: true,
    currentActionOwners: new Map([
      ['skill_demo_run', 'demo-skill'],
      ['skill_demo_new', 'demo-skill'],
      ['skill_demo_impostor', 'other-skill'],
    ]),
    currentAllowedPrimitives: new Set(['skill_read_artifact', 'skill_export_artifact']),
  })
  const ready = revalidateSavedSkillAuthorization({
    saved,
    currentLegalAuthorization: currentLegal,
    currentlyAvailableToolNames: new Set([
      'skill_demo_run',
      'skill_demo_new',
      'skill_read_artifact',
      'skill_export_artifact',
    ]),
    currentSurface: { composition: 'additive', exclusiveScopeRef: null },
    requestOrResourceAnchorDigest: 'anchor-digest',
  })
  assert.equal(ready.status, 'ready')
  if (ready.status !== 'ready' || ready.authorization.mode !== 'selected') return
  assert.deepEqual([...ready.authorization.allowedTypedActions], ['skill_demo_run'])
  assert.deepEqual([...ready.authorization.allowedPrimitives], ['skill_read_artifact'])

  const narrowed = revalidateSavedSkillAuthorization({
    saved,
    currentLegalAuthorization: resolveCurrentLegalAuthorizationForSavedSkill({
      saved,
      skillPresent: true,
      currentActionOwners: new Map([['skill_demo_run', 'other-skill']]),
      currentAllowedPrimitives: new Set(['skill_read_artifact']),
    }),
    currentlyAvailableToolNames: new Set(['skill_read_artifact']),
    currentSurface: { composition: 'additive', exclusiveScopeRef: null },
    requestOrResourceAnchorDigest: 'anchor-digest',
  })
  assert.deepEqual(narrowed, {
    status: 'waiting',
    reason: 'skill_authorization_narrowed',
    missingToolNames: ['skill_demo_run'],
  })
})

test('durable Browser steering is kept verbatim and cannot trigger fresh-turn text policy', () => {
  const activeContext = {
    hasActiveTaskContext: true,
    taskRefs: [{ taskId: 'browser-parent', status: 'running', taskType: 'browser' }],
  }
  for (const primaryInstruction of [
    '不要打开新页，在当前页继续',
    '现在进度如何？继续采集',
    '登录我的账号，然后上传 报告.pdf',
  ]) {
    const followup = classifyFollowupIntent(primaryInstruction, activeContext)
    assert.deepEqual(resolveTurnTextPolicyDecision({
      durableBrowserWorkflow: true,
      primaryInstruction,
      followup,
    }), {
      negations: [],
      releasedNegations: [],
      verbatimGrants: [],
      narrowToStatusTools: false,
    })
  }

  const freshStatus = '现在进度如何？'
  const freshDecision = resolveTurnTextPolicyDecision({
    durableBrowserWorkflow: false,
    primaryInstruction: freshStatus,
    followup: classifyFollowupIntent(freshStatus, activeContext),
  })
  assert.equal(freshDecision.narrowToStatusTools, true)
})
