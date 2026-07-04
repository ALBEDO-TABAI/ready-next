import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createContinuationRunBudgetSeed,
  createRunBudgetSeed,
} from '../main/modules/agent-control/task-projection/run-budget-policy'
import {
  filterSkillPrimitivesBySession,
  shouldExposeSkillPrimitive,
} from '../main/modules/tools/skill-tool-session-gate'

// Phase 4 — tool gating expansion.
//
// Audit findings these tests pin:
//   C1 — long-skill resume budget upgrade was AND'd with `!continuationTaskId`,
//        denying explicit continuations the 80-iter ceiling.
//   C2 — primitive exposure was hint-only; a hint TTL miss nuked all
//        primitives mid-flow.
//   C3 — detached error errorKind collapsed all causes into one opaque
//        "action_not_allowed" message.
//   C4 — `continuation` task type fixed at 24 iter regardless of original
//        task's natural ceiling.

const SKILLS_TOOLS_PATH = new URL('../main/modules/tools/skills-tools.ts', import.meta.url)

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

// --- Phase 4.2 — createContinuationRunBudgetSeed -----------------------------

test('Phase 4.2 — createContinuationRunBudgetSeed inherits multi_step_task ceiling', () => {
  const seed = createContinuationRunBudgetSeed('multi_step_task')
  const baseline = createRunBudgetSeed('multi_step_task')
  assert.equal(seed.maxIterations, baseline.maxIterations, 'inherits multi_step preset')
  assert.equal(seed.maxToolCalls, baseline.maxToolCalls)
})

test('Phase 4.2 — createContinuationRunBudgetSeed inherits media_task ceiling', () => {
  const seed = createContinuationRunBudgetSeed('media_task')
  const baseline = createRunBudgetSeed('media_task')
  assert.equal(seed.maxIterations, baseline.maxIterations)
  assert.equal(seed.maxToolCalls, baseline.maxToolCalls)
})

test('Phase 4.2 — createContinuationRunBudgetSeed falls back to continuation preset for short types', () => {
  const baseline = createRunBudgetSeed('continuation')
  // direct_answer / short_task / null all collapse to the 24-iter continuation
  // preset — we don't grant a longer budget than the original task earned.
  for (const original of ['direct_answer', 'short_task', null, undefined] as const) {
    const seed = createContinuationRunBudgetSeed(original as any)
    assert.equal(seed.maxIterations, baseline.maxIterations, `original=${original}`)
    assert.equal(seed.maxToolCalls, baseline.maxToolCalls, `original=${original}`)
  }
})

// --- Phase 4.3 — primitive gate OR-fallback ---------------------------------

test('Phase 4.3 — shouldExposeSkillPrimitive returns true when ONLY the projection signal is present', () => {
  const exposed = shouldExposeSkillPrimitive(
    'sess-1',
    () => false,           // no active execution
    () => false,           // no reference hint (TTL miss simulation)
    () => true,            // skill task projection IS active
  )
  assert.equal(exposed, true)
})

test('Phase 4.3 — shouldExposeSkillPrimitive still false when ALL signals are false', () => {
  const exposed = shouldExposeSkillPrimitive(
    'sess-1',
    () => false,
    () => false,
    () => false,
  )
  assert.equal(exposed, false)
})

test('Phase 4.3 — shouldExposeSkillPrimitive remains backward-compatible (no 4th arg)', () => {
  // The optional 4th argument means existing 3-arg callers behave identically.
  const exposed = shouldExposeSkillPrimitive(
    'sess-1',
    () => false,
    () => true, // hint armed
  )
  assert.equal(exposed, true)
})

test('Phase 4.3 — filterSkillPrimitivesBySession honors the projection signal', () => {
  const defs = [{ name: 'skill_run_shell' }, { name: 'skill_ask_user' }]
  // Hint missed but projection active → primitives still exposed.
  const out = filterSkillPrimitivesBySession(
    defs,
    'sess-1',
    () => false,
    () => false,
    () => true,
  )
  assert.equal(out.length, 2)
})

// --- Wiring checks ----------------------------------------------------------

test('Phase 4.3 wiring — getSkillToolDefs passes hasActiveSkillTaskProjection to the gate', () => {
  const source = readSource(SKILLS_TOOLS_PATH)
  // RE-AUDIT FIX 4.3 — the dispatch site now wraps readSkillTaskProjection
  // in isSkillTaskProjectionLive so terminal projections (done/failed/error)
  // no longer leave primitives permanently exposed. Original Phase 4.3 used
  // the looser `readSkillTaskProjection !== null` check.
  assert.match(
    source,
    /hasActiveSkillTaskProjection\s*=\s*\(sid:\s*string\)\s*=>\s*\n?\s*isSkillTaskProjectionLive\(readSkillTaskProjection\(\{\s*sessionId:\s*sid\s*\}\)\)/,
  )
  // Production now passes additional projection signals after
  // `hasActiveSkillTaskProjection` (e.g. `hasActiveSkillTaskRun`); only pin
  // that the projection-coverage signal is in the call-site argument list,
  // not that it's the last arg.
  assert.match(
    source,
    /filterSkillPrimitivesBySession\([\s\S]*?hasReferenceHint,[\s\S]*?hasActiveSkillTaskProjection[\s\S]*?\)/,
  )
})

test('Phase 4.4 wiring — detached errorKind taxonomy split into 4 specific kinds', () => {
  const source = readSource(SKILLS_TOOLS_PATH)
  // The original blob errorKind must NOT be returned anymore (only allowed in
  // a comment that documents the migration).
  const dataReturns = source.match(/errorKind:\s*'detached_task_action_not_allowed'/g) || []
  assert.equal(dataReturns.length, 0, 'old detached_task_action_not_allowed must be gone from emit sites')

  // All four new errorKinds must be present.
  for (const kind of [
    'detached_task_skill_not_loaded',
    'detached_task_skill_action_unknown',
    'detached_task_hint_required',
    'detached_task_visibility_internal',
  ]) {
    assert.match(source, new RegExp(`errorKind:\\s*'${kind}'`), `missing errorKind ${kind}`)
  }
})

test('Phase 4.4 — every detached errorKind variant carries skillId + action + referenceHintSkillId for diagnosis', () => {
  const source = readSource(SKILLS_TOOLS_PATH)
  // The single emit point at the bottom of the reject branch carries all
  // three diagnostic fields. Pin them so a future refactor doesn't drop
  // referenceHintSkillId (which is what tells the model "your hint is
  // missing for this skill").
  const detachedRejectEmit = source.match(/data:\s*\{\s*errorKind:\s*detachedReject\.errorKind[\s\S]*?\}/)
  assert.ok(detachedRejectEmit, 'detached reject emit block exists')
  assert.match(detachedRejectEmit![0], /skillId,/)
  assert.match(detachedRejectEmit![0], /action:\s*requestedAction/)
  assert.match(detachedRejectEmit![0], /referenceHintSkillId,/)
})
