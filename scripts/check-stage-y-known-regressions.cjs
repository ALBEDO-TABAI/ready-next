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

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const REPORT_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report.md'
const SCHEMA_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report-schema.json'

// Stage Y successor pinned list — currently empty.
// Add rows here ONLY if Stage Y produces a NEW retired-with-reason
// disposition (path-b in §6 disposition tree). At Y closeout the list
// is empty because all 4 Y0.1 rows went green via path-a variants.
const STAGE_Y_KNOWN_REGRESSIONS = []

function main({ root = ROOT } = {}) {
  const errors = []

  // (a) §6.5 condition 1+2+3 enforcement: the disposition report MUST
  // exist + schema MUST exist + delegated validator MUST pass.
  const reportAbs = path.join(root, REPORT_REL)
  if (!fs.existsSync(reportAbs)) {
    errors.push(`§6.5 condition 3 fail: y0-1-disposition-report.md missing (${REPORT_REL})`)
  }
  const schemaAbs = path.join(root, SCHEMA_REL)
  if (!fs.existsSync(schemaAbs)) {
    errors.push(`§6.5 schema missing: ${SCHEMA_REL}`)
  }

  // (b) Delegate to check-y0-1-disposition-report.cjs for full schema
  // enforcement. We require that gate to also pass at this freeze.
  try {
    execFileSync('node', [path.join(__dirname, 'check-y0-1-disposition-report.cjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    errors.push(
      `§6.5 disposition-report validator failed (check-y0-1-disposition-report.cjs exit ${e.status}); fix the report before deleting the X gate`,
    )
  }

  // (c) Pinned-list validation: empty at this freeze (all 4 X1.8 rows went
  // green via path-a variants). If non-empty, mirror the X1.8 pattern.
  if (STAGE_Y_KNOWN_REGRESSIONS.length > 0) {
    // (placeholder for future Stage Y retired-with-reason rows)
    errors.push(`pinned-list validation not yet implemented for ${STAGE_Y_KNOWN_REGRESSIONS.length} row(s)`)
  }

  if (errors.length === 0) {
    console.log(
      `[check-stage-y-known-regressions] OK (empty pinned list — all 4 X1.8 rows went green via path-a; §6.5 conditions 1+2+3 verified via delegated check-y0-1-disposition-report.cjs)`,
    )
    return { ok: true, errors: [] }
  }
  return { ok: false, errors }
}

if (require.main === module) {
  const result = main()
  if (!result.ok) {
    console.error('[check-stage-y-known-regressions] FAIL:')
    for (const e of result.errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  process.exit(0)
}

module.exports = { main, STAGE_Y_KNOWN_REGRESSIONS }
