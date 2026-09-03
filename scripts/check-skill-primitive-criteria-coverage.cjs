#!/usr/bin/env node
/**
 * R-CRIT (方案 b) gate — skill-primitive delivery coverage counting (red-first).
 *
 * The incident's terminal `proof_gap` was a structural false-negative: c1
 * (steps_complete) requires run_state/task_event proofs that inline
 * reference-skill runs NEVER mint, so it rejected every such run regardless of
 * delivery. The fix replaces c1 with a COUNTING `delivery_coverage` criterion
 * for skill-primitive multi_step runs: one-to-one target↔artifact coverage, so
 * a complete delivery accepts AND an under-delivery (1 of 2 docs) still fails —
 * the latter is NOT achievable by any proof-kind test (a single artifact would
 * satisfy it). This gate pins the mechanism + its wiring so neither can be
 * silently removed, and pins the behavioral regression test that reproduces the
 * incident's "many intermediate artifacts, one delivered" shape. A declared
 * output remains an obligation for short and child-backed skill runs too.
 *
 * Deliberately red on the pre-fix code (none of these symbols existed).
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const CRITERIA_FILE = 'src/main/modules/agent-control/quality/criteria-templates.ts'
const ADJUDICATOR_FILE = 'src/main/modules/agent-control/quality/task-adjudicator.ts'
const FINALIZER_FILE = 'src/main/modules/agent-control/runtime-core/run-finalizer-adjudication.ts'
const TASK_FACTS_FILE = 'src/main/modules/agent-control/runtime-core/run-finalizer-task-facts.ts'
const REGRESSION_TEST = 'src/__tests__/skill-primitive-criteria-coverage.test.ts'

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []

  const criteria = read(CRITERIA_FILE)
  if (!criteria) {
    violations.push({ file: CRITERIA_FILE, reason: 'missing file' })
  } else {
    if (!/CriteriaKind[\s\S]*?\|\s*['"]delivery_coverage['"]/.test(criteria)) {
      violations.push({ file: CRITERIA_FILE, reason: "CriteriaKind must include 'delivery_coverage'" })
    }
    if (!/coverageTargets/.test(criteria)) {
      violations.push({ file: CRITERIA_FILE, reason: 'resolveCriteria must accept coverageTargets (steps_json expectedOutputs)' })
    }
    // Boundary: the conversion belongs to skill tasks and does not weaken the
    // independent child run_state criterion.
    if (!/skillDeliveryCoverable\s*=\s*module\s*===\s*['"]skill['"]\s*&&\s*coverageTargets\.length\s*>\s*0/.test(criteria)) {
      violations.push({ file: CRITERIA_FILE, reason: 'coverage conversion must be gated on skill module with declared targets' })
    }
    // Declared targets → convert c1 to a delivery_coverage item carrying expected.
    if (!/kind:\s*['"]delivery_coverage['"][\s\S]*?expected:\s*coverageTargets/.test(criteria)) {
      violations.push({ file: CRITERIA_FILE, reason: 'declared targets must convert c1 to a delivery_coverage item carrying expected' })
    }
    // MONOTONIC boundary: conversion happens ONLY when targets were declared —
    // the no-target case must NOT flip to NA (that fail-open drop of c1 would let
    // a single c2 artifact accept an unverifiable delivery). Guard the gate.
    if (!/skillDeliveryCoverable/.test(criteria)) {
      violations.push({ file: CRITERIA_FILE, reason: 'conversion must be gated on coverageTargets.length > 0 (no-target case stays monotonic, must not fail-open to NA)' })
    }
    if (/未声明预期产出/.test(criteria)) {
      violations.push({ file: CRITERIA_FILE, reason: 'no-target NA fallback must be removed (it fail-opens: NA drops c1 → single c2 artifact accepts an unverifiable delivery)' })
    }
    // Shared normalizer so producer-filter and adjudicator agree on real targets.
    if (!/export function normalizeDeliveryTarget/.test(criteria)) {
      violations.push({ file: CRITERIA_FILE, reason: 'must export normalizeDeliveryTarget (shared by producer-filter + adjudicator counter)' })
    }
  }

  const adjudicator = read(ADJUDICATOR_FILE)
  if (!adjudicator) {
    violations.push({ file: ADJUDICATOR_FILE, reason: 'missing file' })
  } else {
    if (!/delivery_coverage:\s*\[/.test(adjudicator)) {
      violations.push({ file: ADJUDICATOR_FILE, reason: 'CRITERIA_PROOF_MAP must document delivery_coverage source kind' })
    }
    if (!/export function resolveDeliveryCoverage/.test(adjudicator)) {
      violations.push({ file: ADJUDICATOR_FILE, reason: 'resolveDeliveryCoverage counting function must exist' })
    }
    // One-to-one over DISTINCT real deliveries: delivered paths must be DEDUPED
    // (N proof copies of one file must not cover N targets) and matched via a
    // MAXIMUM bipartite matching (greedy could starve a restrictive target and
    // false-reject a complete delivery). Both are the review-hardened invariants.
    if (!/new Set\(deliveredArtifactPaths/.test(adjudicator) && !/\[\.\.\.new Set\(/.test(adjudicator)) {
      violations.push({ file: ADJUDICATOR_FILE, reason: 'delivered paths must be de-duplicated before counting (one real file covers ≤1 target)' })
    }
    if (!/augment/.test(adjudicator) || !/matchedDeliveryToTarget/.test(adjudicator)) {
      violations.push({ file: ADJUDICATOR_FILE, reason: 'coverage must use maximum bipartite matching (augmenting paths), not greedy first-match' })
    }
    // delivery_coverage must be special-cased, NOT satisfied by presentKinds membership.
    if (!/item\.kind\s*===\s*['"]delivery_coverage['"]/.test(adjudicator)) {
      violations.push({ file: ADJUDICATOR_FILE, reason: 'adjudicator must special-case delivery_coverage (counted, not proof-kind membership)' })
    }
  }

  const finalizer = read(FINALIZER_FILE)
  const taskFacts = read(TASK_FACTS_FILE)
  if (!finalizer) {
    violations.push({ file: FINALIZER_FILE, reason: 'missing file' })
  } else {
    if (!taskFacts || !/function deriveCoverageTargets/.test(taskFacts)) {
      violations.push({ file: TASK_FACTS_FILE, reason: 'finalizer must derive coverage targets from steps_json expectedOutputs' })
    }
    if (!/coverageTargets:\s*deriveCoverageTargets/.test(finalizer)) {
      violations.push({ file: FINALIZER_FILE, reason: 'finalizer must feed coverageTargets into resolveCriteria' })
    }
    if (!/adjudicator_criteria_resolved/.test(finalizer)) {
      violations.push({ file: FINALIZER_FILE, reason: 'finalizer must log adjudicator_criteria_resolved (coverage_count|na)' })
    }
  }

  const test = read(REGRESSION_TEST)
  if (!test) {
    violations.push({ file: REGRESSION_TEST, reason: 'missing behavioral regression test' })
  } else {
    // The fixture must be the incident shape (many intermediate artifacts, one
    // delivered) — NOT a "1 artifact" fixture that a naive count would pass.
    if (!/length:\s*32/.test(test) || !/33/.test(test)) {
      violations.push({ file: REGRESSION_TEST, reason: 'under-delivery fixture must reproduce the incident (≫1 intermediate artifacts, ≥2 total), not a 1-artifact false-green' })
    }
    if (!/notEqual\(result\.verdict,\s*'accept'\)/.test(test)) {
      violations.push({ file: REGRESSION_TEST, reason: 'under-delivery must assert verdict≠accept' })
    }
  }

  if (violations.length === 0) {
    console.log('[check-skill-primitive-criteria-coverage] OK')
    process.exit(0)
  }
  console.error('[check-skill-primitive-criteria-coverage] FAIL:')
  for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`)
  process.exit(1)
}

main()
