/**
 * Stage 4 W1 — pure-read SkillTurnIdentity resolver tests.
 *
 * Drive `resolveSkillTurnIdentity` with synthetic frozen snapshots and
 * assert the resolver returns identity shapes that project to the same
 * legacy values turn-engine A-F segments would produce. Per v6 plan §4,
 * the resolver runs in shadow mode in W1 (legacy A-F still drive
 * observable behavior); these tests pin that the resolver alone can
 * derive identity correctly so W2 can safely cut over.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectIdentityToLegacyShape,
  resolveSkillTurnIdentity,
  type SkillTurnIdentity,
} from '../main/modules/agent-control/skill-turn-identity'
import type {
  ReferenceHintSnapshot,
  SkillTurnIdentitySnapshot,
} from '../main/modules/agent-control/skill-turn-identity-snapshot'
import type { ExplicitRunStateResourceCandidate } from '../main/modules/agent-control/run-state-resource-resolver'

// ---------------------------------------------------------------------------
// Snapshot factory — minimal, mostly nulls. Override per test.
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<SkillTurnIdentitySnapshot> = {}): SkillTurnIdentitySnapshot {
  const base = {
    request: Object.freeze({
      sessionId: 'scope-test',
      primaryInstruction: '',
      pureUserText: '',
    }),
    contextualUserInput: '',
    currentTurnResumeText: '',
    explicitRunStateResourceForTurn: null,
    providedContinuationState: null,
    isSkillResumeTurnDetected: false,
    isConfigRepairTurnDetected: false,
    previousAssistantSkillToolUses: Object.freeze([] as string[]),
    firstSkillMatch: null,
    firstExplicitSkillId: null,
    runStateResourceVia: null,
    explicitlyRequestedSkillsBySkillIdProbe: Object.freeze([] as Array<{ skillId?: string; id?: string; name?: string }>),
    referenceHintSnapshot: null as ReferenceHintSnapshot,
    hasActiveSkillExecutionSnapshot: false,
    activeSkillContextSnapshot: null,
    hasStrongActiveSkillContext: false,
    latestSkillRunSnapshot: null,
    supervisorSnapshot: null,
    resumeCandidatesSnapshot: Object.freeze([]),
  }
  return Object.freeze({ ...base, ...overrides }) as SkillTurnIdentitySnapshot
}

function makeRunStateCandidate(overrides: Partial<ExplicitRunStateResourceCandidate> = {}): ExplicitRunStateResourceCandidate {
  return {
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    runStatePath: '/tmp/run_state.json',
    outputDir: '/tmp/out',
    sceneScoresPath: null,
    deliveryReportPath: null,
    explicitAction: null,
    sourceText: '',
    ...overrides,
  } as ExplicitRunStateResourceCandidate
}

// ---------------------------------------------------------------------------
// Shadow consistency tests (v6 plan §4 W1 target list)
// ---------------------------------------------------------------------------

test('shadow resolver matches legacy on explicit skill mention', () => {
  // Mirror legacy Point A (turn-engine.ts:1346): when `findExplicitlyRequestedSkills`
  // returns a match, hasExplicitSkill = true, source = explicit.
  const snapshot = makeSnapshot({
    firstSkillMatch: Object.freeze({
      text: 'use video-expert-analyzer',
      skills: Object.freeze([{ id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }]),
    }),
    firstExplicitSkillId: 'video-expert-analyzer',
  })

  const identity = resolveSkillTurnIdentity(snapshot)
  assert.equal(identity.mode, 'skill')
  if (identity.mode === 'skill') {
    assert.equal(identity.relation, 'new')
    assert.equal(identity.skillId, 'video-expert-analyzer')
    assert.equal(identity.skillName, 'Video Expert Analyzer')
    assert.equal(identity.confidence, 'explicit')
    assert.equal(identity.source, 'explicit_user_mention')
    assert.equal(identity.contextText, 'use video-expert-analyzer')
  }

  const projected = projectIdentityToLegacyShape(identity, null)
  assert.equal(projected.hasExplicitSkill, true)
  assert.equal(projected.lookbackRearmedSkillId, null) // explicit mention is NOT lookback origin
  assert.equal(projected.referenceSkillHintVia, 'explicit')
})

test('shadow resolver matches legacy on run_state resource resume', () => {
  // Mirror legacy Point B (turn-engine.ts:1454-1474): explicit run_state resource
  // present + resume intent → hasExplicitSkill = true, via = 'resource'.
  const snapshot = makeSnapshot({
    isSkillResumeTurnDetected: true,
    explicitRunStateResourceForTurn: makeRunStateCandidate({
      skillId: 'video-expert-analyzer',
      skillName: 'VEA',
    }),
    runStateResourceVia: 'resource',
  })

  const identity = resolveSkillTurnIdentity(snapshot)
  assert.equal(identity.mode, 'skill')
  if (identity.mode === 'skill') {
    assert.equal(identity.relation, 'resume')
    assert.equal(identity.skillId, 'video-expert-analyzer')
    assert.equal(identity.skillName, 'VEA')
    assert.equal(identity.confidence, 'trusted_handle')
    assert.equal(identity.source, 'run_state_resource')
    assert.equal(identity.contextText, '用户希望继续使用 skill "VEA"')
    assert.equal(identity.resumeHandle?.runStatePath, '/tmp/run_state.json')
    assert.equal(identity.resumeHandle?.outputDir, '/tmp/out')
  }

  const projected = projectIdentityToLegacyShape(identity, 'resource')
  assert.equal(projected.hasExplicitSkill, true)
  assert.equal(projected.lookbackRearmedSkillId, 'video-expert-analyzer')
  assert.equal(projected.referenceSkillHintVia, 'resource')
})

test('shadow resolver matches legacy on no-skill turn', () => {
  // Mirror legacy default path: no skill mention, no resume intent, no
  // run_state, no hint, no history. mode:'none', reason:'turn_not_skill_resume'.
  const snapshot = makeSnapshot()

  const identity = resolveSkillTurnIdentity(snapshot)
  assert.equal(identity.mode, 'none')
  if (identity.mode === 'none') {
    assert.equal(identity.reason, 'turn_not_skill_resume')
  }

  const projected = projectIdentityToLegacyShape(identity, null)
  assert.equal(projected.hasExplicitSkill, false)
  assert.equal(projected.lookbackRearmedSkillId, null)
  assert.equal(projected.referenceSkillHintVia, null)
})

test('shadow resolver matches legacy on config-repair no-recoverable-task path', () => {
  // Mirror legacy Point E inner branch (turn-engine.ts:1576-1610): config-repair
  // turn but no recoverable history (no priorToolUses, no hint, no historicalSkill)
  // → identity.mode='none', reason='config_repair_no_recoverable_task' so the
  // W2 applier can preserve legacy `finish({success:true, status:'done'})`.
  const snapshot = makeSnapshot({
    isSkillResumeTurnDetected: true,
    isConfigRepairTurnDetected: true,
    previousAssistantSkillToolUses: Object.freeze([] as string[]),
    referenceHintSnapshot: null,
    activeSkillContextSnapshot: null,
    latestSkillRunSnapshot: null,
  })

  const identity = resolveSkillTurnIdentity(snapshot)
  assert.equal(identity.mode, 'none')
  if (identity.mode === 'none') {
    assert.equal(identity.reason, 'config_repair_no_recoverable_task')
  }
})

// ---------------------------------------------------------------------------
// Additional resolver coverage — Points C, D, E happy paths
// ---------------------------------------------------------------------------

test('resolver point C: prior tool use lookback infers skillId from skill_<id>_<action>', () => {
  // Mirror legacy Point C (turn-engine.ts:1475-1490): no explicit, no resource,
  // resume intent, prior assistant skill tool uses → confidence:'history',
  // source:'prior_tool_use_lookback'.
  const snapshot = makeSnapshot({
    isSkillResumeTurnDetected: true,
    previousAssistantSkillToolUses: Object.freeze([
      'skill_video_expert_analyzer_pipeline',
      'skill_video_expert_analyzer_score',
    ]),
  })

  const identity = resolveSkillTurnIdentity(snapshot)
  assert.equal(identity.mode, 'skill')
  if (identity.mode === 'skill') {
    assert.equal(identity.confidence, 'history')
    assert.equal(identity.source, 'prior_tool_use_lookback')
    // inferSkillFromToolNames captures the longest leading skill_id segment
    assert.equal(identity.skillId, 'video_expert_analyzer')
  }
})

test('resolver point D: reference hint alone (no resume intent) does NOT trigger skill mode', () => {
  // Mirror legacy guard at turn-engine.ts:1491: hint requires `isSkillResumeTurnDetected`.
  // Without it, hint must NOT alone arm skill identity — this is W3's tightening
  // baseline (current behavior already gated on isSkillResumeTurnDetected).
  const snapshot = makeSnapshot({
    isSkillResumeTurnDetected: false,
    referenceHintSnapshot: { id: 'video-expert-analyzer', name: 'VEA' },
  })

  const identity = resolveSkillTurnIdentity(snapshot)
  assert.equal(identity.mode, 'none')
  if (identity.mode === 'none') {
    assert.equal(identity.reason, 'turn_not_skill_resume')
  }
})

test('resolver point D: reference hint with resume intent triggers confidence:hint', () => {
  // Mirror legacy Point D (turn-engine.ts:1491-1503): no explicit, no resource,
  // resume intent, reference hint present, no strong active context → confidence:'hint'.
  const snapshot = makeSnapshot({
    isSkillResumeTurnDetected: true,
    referenceHintSnapshot: { id: 'video-expert-analyzer', name: 'VEA' },
  })

  const identity = resolveSkillTurnIdentity(snapshot)
  assert.equal(identity.mode, 'skill')
  if (identity.mode === 'skill') {
    assert.equal(identity.confidence, 'hint')
    assert.equal(identity.source, 'reference_hint')
    assert.equal(identity.skillId, 'video-expert-analyzer')
    assert.equal(identity.contextText, '用户希望继续使用 skill "VEA"')
  }
})

test('resolver respects hasStrongActiveSkillContext gate (skips Point D when active context is non-hint)', () => {
  // Mirror legacy guard at turn-engine.ts:1491 `!hasStrongActiveSkillContext()`.
  // When a strong active context already exists (source !== 'reference_hint'),
  // Points C and D MUST NOT fire. The resolver falls through to Point E.
  const snapshot = makeSnapshot({
    isSkillResumeTurnDetected: true,
    referenceHintSnapshot: { id: 'video-expert-analyzer', name: 'VEA' },
    hasStrongActiveSkillContext: true,
    activeSkillContextSnapshot: Object.freeze({
      skillId: 'lets-go-rss',
      skillName: 'RSS Reader',
      taskRunId: null,
      detachedTaskId: null,
      runStatePath: null,
      outputDir: null,
      sceneScoresPath: null,
      deliveryReportPath: null,
      action: null,
      source: 'projection',
      confidence: 80,
      status: null,
      staleBlockerReason: null,
      observedAt: new Date().toISOString(),
    }),
  })

  const identity = resolveSkillTurnIdentity(snapshot)
  // Falls through to Point E and picks up active context's skill (not hint's).
  assert.equal(identity.mode, 'skill')
  if (identity.mode === 'skill') {
    assert.equal(identity.skillId, 'lets-go-rss')
    assert.equal(identity.source, 'skill_history')
  }
})

// ---------------------------------------------------------------------------
// Projection helper — explicit invariant
// ---------------------------------------------------------------------------

test('projectIdentityToLegacyShape: lookbackRearmedSkillId is null for explicit_user_mention', () => {
  // Legacy A doesn't set lookbackRearmedSkill (only B/C/D/E do).
  const identity: SkillTurnIdentity = {
    mode: 'skill',
    relation: 'new',
    skillId: 'foo',
    skillName: 'Foo',
    confidence: 'explicit',
    source: 'explicit_user_mention',
    contextText: 'use foo',
  }
  const projected = projectIdentityToLegacyShape(identity, null)
  assert.equal(projected.lookbackRearmedSkillId, null)
  assert.equal(projected.referenceSkillHintVia, 'explicit')
})

test('projectIdentityToLegacyShape: resource_history uses resource_history via', () => {
  const identity: SkillTurnIdentity = {
    mode: 'skill',
    relation: 'resume',
    skillId: 'vea',
    skillName: 'VEA',
    confidence: 'trusted_handle',
    source: 'run_state_resource',
    contextText: '...',
  }
  const projected = projectIdentityToLegacyShape(identity, 'resource_history')
  assert.equal(projected.referenceSkillHintVia, 'resource_history')
})
