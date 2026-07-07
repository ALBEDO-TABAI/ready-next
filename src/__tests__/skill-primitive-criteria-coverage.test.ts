/**
 * R-CRIT (方案 b) — the terminal adjudicator counts delivered-artifact coverage
 * against a skill-primitive run's declared expected outputs, replacing the
 * c1(steps_complete) proof-kind false-negative.
 *
 * Two contract points (companion §R-CRIT C-CRIT):
 *   1. a COMPLETE skill-primitive delivery is no longer false-negatived;
 *   2. an UNDER-delivery (delivered < expected) still fails (verdict≠accept) —
 *      and critically, the under-delivery fixture reproduces the incident's
 *      "many intermediate artifacts, only one hitting the delivery path" shape,
 *      NOT a "1 artifact" fixture (which a naive artifact-count would false-green).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  adjudicateTerminalOutcome,
  resolveDeliveryCoverage,
} from '../main/modules/agent-control/quality/task-adjudicator'
import { resolveCriteria, normalizeDeliveryTarget } from '../main/modules/agent-control/quality/criteria-templates'
import { collectArtifactProof } from '../main/modules/agent-control/quality/proof-collector'
import { deriveCoverageTargets } from '../main/modules/agent-control/runtime-core/run-finalizer'

const NOW = new Date('2026-07-07T08:00:00Z')
const artifact = (path: string) => collectArtifactProof(path, NOW)

// The incident shape: 32 intermediate skill-runtime writes + exactly ONE doc
// delivered to the user's target directory (V/); the second doc never landed.
const INTERMEDIATES = Array.from({ length: 32 }, (_, i) =>
  artifact(`/home/u/.skill-runtime/outputs/image-deep-read/part-${i}.md`))
const DELIVERED_DESC = artifact('/Users/user/V/110b543cd333-描述层完整报告.md')
const DELIVERED_DEEP = artifact('/Users/user/V/110b543cd333-深读分析报告.md')
const TARGET_DIR = '/Users/user/V'

// ── resolveDeliveryCoverage — the pure one-to-one counter ────────────────────
test('resolveDeliveryCoverage: intermediate writes do not inflate coverage (under-delivery)', () => {
  const targets = [TARGET_DIR, TARGET_DIR] // two docs promised to the same dir
  const delivered = [...INTERMEDIATES.map((p) => p.ref), DELIVERED_DESC.ref]
  assert.deepEqual(resolveDeliveryCoverage(targets, delivered), { delivered: 1, expected: 2 })
})

test('resolveDeliveryCoverage: both docs delivered → full coverage', () => {
  const targets = [TARGET_DIR, TARGET_DIR]
  const delivered = [...INTERMEDIATES.map((p) => p.ref), DELIVERED_DESC.ref, DELIVERED_DEEP.ref]
  assert.deepEqual(resolveDeliveryCoverage(targets, delivered), { delivered: 2, expected: 2 })
})

test('resolveDeliveryCoverage: one delivered artifact cannot cover two targets (one-to-one)', () => {
  assert.deepEqual(resolveDeliveryCoverage(['报告.md', '报告.md'], ['/V/报告.md']), { delivered: 1, expected: 2 })
})

test('resolveDeliveryCoverage: filename-token targets match by basename', () => {
  assert.deepEqual(
    resolveDeliveryCoverage(['深读.md', '描述.md'], ['/a/描述.md', '/b/part1.md']),
    { delivered: 1, expected: 2 },
  )
})

test('resolveDeliveryCoverage: empty expected is vacuous (0/0)', () => {
  assert.deepEqual(resolveDeliveryCoverage([], ['/V/x.md']), { delivered: 0, expected: 0 })
})

// finding #1 — duplicate proofs of ONE real file must not cover two targets.
test('resolveDeliveryCoverage: N proof copies of one real file cover at most one target (dedup)', () => {
  assert.deepEqual(
    resolveDeliveryCoverage(['/a/报告.md', '/b/报告.md'], ['/a/报告.md', '/a/报告.md']),
    { delivered: 1, expected: 2 },
  )
  // same for the incident's identical-directory-target shape
  assert.deepEqual(
    resolveDeliveryCoverage([TARGET_DIR, TARGET_DIR], ['/Users/user/V/报告.md', '/Users/user/V/报告.md']),
    { delivered: 1, expected: 2 },
  )
})

// finding #3 — a colliding basename in a DIFFERENT directory must not satisfy a full-path target.
test('resolveDeliveryCoverage: path-anchored — an intermediate elsewhere with the same basename does NOT match a full-path target', () => {
  assert.deepEqual(
    resolveDeliveryCoverage(
      ['/Users/user/V/深读.md', '/Users/user/V/描述.md'],
      ['/Users/user/V/描述.md', '/home/u/.skill-runtime/outputs/深读.md'],
    ),
    { delivered: 1, expected: 2 },
  )
})

// finding #7 — greedy first-match would starve a nested target; maximum matching must not.
test('resolveDeliveryCoverage: maximum bipartite matching does not false-reject a complete nested-dir delivery', () => {
  assert.deepEqual(resolveDeliveryCoverage(['a', 'a/b'], ['a/b/x.md', 'a/y.md']), { delivered: 2, expected: 2 })
  // order-independent (greedy was order-flaky here)
  assert.deepEqual(resolveDeliveryCoverage(['a', 'a/b'], ['a/y.md', 'a/b/x.md']), { delivered: 2, expected: 2 })
})

// finding #8 — a target that normalizes empty must not create a silently-passing coverage item.
test('R-CRIT: a declared target that normalizes empty ("/") is NOT vacuously accepted', () => {
  const criteria = resolveCriteria('multi_step_task', 'skill', {
    skillExecutionForm: null,
    hasPlannedSteps: true,
    coverageTargets: ['/'],
  })
  const c1 = criteria.items.find((i) => i.id === 'c1')
  // The shared normalizer drops "/" → no real target remains → c1 stays active
  // steps_complete (monotonic), NOT a delivery_coverage item that vacuously passes.
  assert.equal(c1?.kind, 'steps_complete')
  assert.ok(!c1?.notApplicable)
  const result = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria: criteria.items,
    proofs: [DELIVERED_DESC],
    mode: 'enforce',
    now: NOW,
  })
  assert.notEqual(result.verdict, 'accept')
})

test('resolveDeliveryCoverage: a mix where only garbage targets normalize empty counts only the real ones', () => {
  // '/' vanishes; '报告.md' remains → expected 1, satisfied by the delivered file
  assert.deepEqual(resolveDeliveryCoverage(['报告.md', '/'], ['/V/报告.md']), { delivered: 1, expected: 1 })
})

// round-2 finding #1/#4 — the shared normalizer must be idempotent, else the
// producer-filter and adjudicator disagree on which targets are real.
test('normalizeDeliveryTarget is idempotent (fixpoint) over pathological quote/slash tokens', () => {
  for (const token of ['/"/', '"a"/', '\\"\\', "'x'/", '//"//', '/Users/user/V', '/Users/user/V/报告.md', '"报告.md"', '/', '']) {
    const once = normalizeDeliveryTarget(token)
    assert.equal(normalizeDeliveryTarget(once), once, `must be idempotent for ${JSON.stringify(token)}`)
  }
  assert.equal(normalizeDeliveryTarget('/Users/user/V'), '/Users/user/V', 'real dir survives unchanged')
  assert.equal(normalizeDeliveryTarget('/Users/user/V/报告.md'), '/Users/user/V/报告.md', 'real file survives unchanged')
})

// round-2 finding #3 — expected must NOT be deduped: the incident is 2 docs to
// the SAME directory; deduping [V,V]→[V] would false-accept a 1-of-2 delivery.
test('resolveDeliveryCoverage: identical directory targets stay counted (no expected-side dedup → incident not false-accepted)', () => {
  assert.deepEqual(
    resolveDeliveryCoverage(['/Users/user/V', '/Users/user/V'], ['/Users/user/V/doc1.md']),
    { delivered: 1, expected: 2 },
  )
})

// ── adjudicateTerminalOutcome — under-delivery MUST NOT accept ────────────────
// NOTE: these drive the CONSUMER by hand-supplying coverageTargets. Live
// activation depends on the deferred producer (steps_json expectedOutputs);
// P1 ships the consumer + a monotonic no-target default (see the monotonic test).
test('R-CRIT consumer: under-delivery (1 of 2 docs) fails WHEN targets are supplied — counting mechanism', () => {
  const criteria = resolveCriteria('multi_step_task', 'skill', {
    skillExecutionForm: null,
    hasPlannedSteps: true,
    coverageTargets: [TARGET_DIR, TARGET_DIR],
  })
  // c1 became delivery_coverage(expected 2); s1 exempted; c2(artifact) remains.
  const c1 = criteria.items.find((item) => item.id === 'c1')
  assert.equal(c1?.kind, 'delivery_coverage')
  assert.deepEqual(c1?.expected, [TARGET_DIR, TARGET_DIR])

  const proofs = [...INTERMEDIATES, DELIVERED_DESC]
  const result = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'model_declared_done',
    criteria: criteria.items,
    proofs,
    mode: 'enforce',
    now: NOW,
  })

  // FALSE-GREEN GUARD: there are 33 artifact proofs (≥2), so a naive
  // "artifact count ≥ expected" test would PASS this run — exactly the trap the
  // plan warns against. Coverage-by-target correctly fails it at 1/2.
  assert.equal(proofs.filter((p) => p.kind === 'artifact').length, 33)
  assert.notEqual(result.verdict, 'accept')
  assert.ok(result.checkIn.blockers.includes('criteria_unsatisfied:c1'))

  const coverage = result.criteriaResolutions.find((r) => r.kind === 'delivery_coverage')
  assert.deepEqual(coverage?.coverage, { delivered: 1, expected: 2 })
  assert.equal(coverage?.satisfied, false)
})

test('R-CRIT: complete skill-primitive delivery (2 of 2 docs) is accepted — no false-negative', () => {
  const criteria = resolveCriteria('multi_step_task', 'skill', {
    skillExecutionForm: null,
    hasPlannedSteps: true,
    coverageTargets: [TARGET_DIR, TARGET_DIR],
  })
  const proofs = [...INTERMEDIATES, DELIVERED_DESC, DELIVERED_DEEP]
  const result = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'model_declared_done',
    criteria: criteria.items,
    proofs,
    mode: 'enforce',
    now: NOW,
  })
  assert.equal(result.verdict, 'accept')
  const coverage = result.criteriaResolutions.find((r) => r.kind === 'delivery_coverage')
  assert.deepEqual(coverage?.coverage, { delivered: 2, expected: 2 })
})

// ── resolveCriteria wiring — activation boundary ─────────────────────────────
test('R-CRIT wiring: skill + planned steps + declared targets → c1 becomes delivery_coverage', () => {
  const resolved = resolveCriteria('multi_step_task', 'skill', {
    hasPlannedSteps: true,
    coverageTargets: [TARGET_DIR],
  })
  assert.equal(resolved.items.find((i) => i.id === 'c1')?.kind, 'delivery_coverage')
})

test('R-CRIT monotonic: skill + planned steps + NO declared targets keeps c1 active (no fail-open regression)', () => {
  const resolved = resolveCriteria('multi_step_task', 'skill', { hasPlannedSteps: true })
  const c1 = resolved.items.find((i) => i.id === 'c1')
  assert.equal(c1?.kind, 'steps_complete', 'no targets → c1 unchanged (NOT converted)')
  assert.ok(!c1?.notApplicable, 'must NOT be NA — NA would drop c1 and let a single c2 artifact fail-open accept an unverifiable delivery')
  // Terminal verdict for a 1-doc delivery stays NON-accept (pre-P1 behavior preserved → monotonic).
  const result = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'model_declared_done',
    criteria: resolved.items,
    proofs: [DELIVERED_DESC],
    mode: 'enforce',
    now: NOW,
  })
  assert.notEqual(result.verdict, 'accept', 'no-target skill-primitive run must not silently accept an unverifiable delivery')
})

test('R-CRIT wiring: a skill run carrying a run_state handle keeps c1 as steps_complete (not weakened)', () => {
  const resolved = resolveCriteria('multi_step_task', 'skill', {
    skillHasRunStateHandle: true,
    hasPlannedSteps: true,
    coverageTargets: [TARGET_DIR],
  })
  const c1 = resolved.items.find((i) => i.id === 'c1')
  assert.equal(c1?.kind, 'steps_complete')
  assert.ok(!c1?.notApplicable)
})

test('R-CRIT wiring: a skill run with real step-completion proof keeps c1 as steps_complete', () => {
  const resolved = resolveCriteria('multi_step_task', 'skill', {
    hasPlannedSteps: true,
    hasStepCompletionProof: true,
    coverageTargets: [TARGET_DIR],
  })
  assert.equal(resolved.items.find((i) => i.id === 'c1')?.kind, 'steps_complete')
})

// ── zero-perturbation — non-skill / non-planned paths untouched ──────────────
test('R-CRIT zero-perturbation: document module c1 is never converted to coverage', () => {
  const resolved = resolveCriteria('multi_step_task', 'document', {
    hasPlannedSteps: true,
    coverageTargets: [TARGET_DIR],
  })
  assert.equal(resolved.items.find((i) => i.id === 'c1')?.kind, 'steps_complete')
})

test('R-CRIT zero-perturbation: system module multi_step c1 unchanged', () => {
  const resolved = resolveCriteria('multi_step_task', 'system', {
    hasPlannedSteps: true,
    coverageTargets: [TARGET_DIR],
  })
  assert.equal(resolved.items.find((i) => i.id === 'c1')?.kind, 'steps_complete')
})

// ── finding #6 — the live finalizer glue (steps_json → targets) is behavioral ─
test('deriveCoverageTargets: flattens steps_json expectedOutputs, dedups by step id with the patch winning', () => {
  const projection = {
    steps: [
      { id: 'step-1', description: 'a', expectedOutputs: ['/Users/user/V/描述.md'] },
      { id: 'step-2', description: 'b', expectedOutputs: ['STALE-should-be-overwritten'] },
      { id: 'step-3', description: 'c' }, // no expectedOutputs → contributes nothing
    ],
  } as never
  const patch = { steps: [{ id: 'step-2', description: 'b', expectedOutputs: ['/Users/user/V/深读.md'] }] }
  assert.deepEqual(deriveCoverageTargets(projection, patch), ['/Users/user/V/描述.md', '/Users/user/V/深读.md'])
})

test('deriveCoverageTargets: guards non-array steps and empty/whitespace outputs', () => {
  assert.deepEqual(deriveCoverageTargets({ steps: null } as never, null), [])
  assert.deepEqual(deriveCoverageTargets({ steps: 'nope' } as never, { steps: 'nope' }), [])
  assert.deepEqual(
    deriveCoverageTargets({ steps: [{ id: 's', description: 'x', expectedOutputs: ['', '   '] }] } as never),
    [],
  )
})

test('R-CRIT zero-perturbation: adjudicating an ordinary artifact criterion is unchanged by the new path', () => {
  const items = [
    { id: 'c1', text: 'x', kind: 'artifact' as const, source: 'template' as const },
  ]
  const accepted = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria: items,
    proofs: [DELIVERED_DESC],
    mode: 'enforce',
    now: NOW,
  })
  assert.equal(accepted.verdict, 'accept')
})
