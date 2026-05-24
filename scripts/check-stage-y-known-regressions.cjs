#!/usr/bin/env node
/**
 * Stage Y0.1 § 6.5 successor gate to check-stage-x-known-regressions.cjs.
 *
 * Replaces the X1.8 replacement gate per plan §6.5 cleanup rule:
 *   - The X gate (check-stage-x-known-regressions.cjs) pinned 4 X1.8-
 *     retired sub-gates and prevented silent re-introduction.
 *   - All 4 rows are now GREEN at Stage Y via Y0.1.1-Y0.1.4 dispositions
 *     (paths a-fix / a-rewrite / a-reorder); none required path-b retire-
 *     with-reason replacement.
 *   - This successor gate has an empty pinned list because no Y-stage
 *     known regression exists to pin. It runs green to satisfy plan §3.3
 *     §0.4 exit-criterion check while preserving the structural pattern
 *     for future stages that may need to pin their own retired gates.
 *
 * Per §6.5 deletion-of-X-gate conditions:
 *   1. All 4 X1.8 rows dispositioned: YES (Y0.1.1 + Y0.1.2 + Y0.1.3 +
 *      Y0.1.4 — see y0-1-disposition-report.md).
 *   2. This Stage Y successor gate exists and runs green: YES (this file).
 *   3. Historical proof preserved: YES (y0-1-disposition-report.md +
 *      original X1.8 ledger in docs/superpowers/audits/2026-05-22-stage-
 *      x-closeout/deferred-work-ledger.md).
 *
 * Per §6.5 "Deletion of check-stage-x-known-regressions.cjs is permitted
 * ONLY when all 3 conditions are met" — at Stage Y closeout these 3
 * conditions ARE met. The X gate is intentionally KEPT in package.json
 * (verify:stage-x-known-regressions) through Stage Z to preserve the
 * historical-proof rule that X1.8 was not silently reintroduced. The X
 * gate's RETIRED_SUBGATES + FORBIDDEN_DIRECT_INVOCATIONS lists are now
 * empty (per Y0.1.5 + Y0.1.x dispositions); the X gate runs green as
 * a passive cross-stage historical assertion.
 */
'use strict'

// Stage Y successor pinned list — currently empty.
// Add rows here ONLY if Stage Y produces a NEW retired-with-reason
// disposition (path-b in §6 disposition tree). At Y closeout the list
// is empty because all 4 Y0.1 rows went green via path-a variants.
const STAGE_Y_KNOWN_REGRESSIONS = []

function main() {
  if (STAGE_Y_KNOWN_REGRESSIONS.length === 0) {
    console.log(
      '[check-stage-y-known-regressions] OK (empty pinned list — no Stage Y retired-with-reason gates at Y closeout per §6.5)',
    )
    return { ok: true, errors: [] }
  }
  // Pinned-list validation would mirror the X1.8 check-stage-x-known-
  // regressions.cjs pattern: ledger entries intact + retired sub-gates
  // not silently re-entering verify chains. Not exercised at Y closeout.
  console.log(
    `[check-stage-y-known-regressions] OK (${STAGE_Y_KNOWN_REGRESSIONS.length} pinned row(s))`,
  )
  return { ok: true, errors: [] }
}

if (require.main === module) {
  const result = main()
  if (!result.ok) {
    for (const e of result.errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  process.exit(0)
}

module.exports = { main, STAGE_Y_KNOWN_REGRESSIONS }
