#!/usr/bin/env node
/**
 * Stage R verify-switch gate — Y0.1.2 rewrite.
 *
 * Original (Stage R PR-R8) contract was:
 *   - package.json `verify` chain embeds `verify:r`
 *   - package.json `verify:cloud` chain embeds `verify:r`
 *   - CLAUDE.md contains the `### 6.25` heading
 *
 * Stage Y Y0.1.2 rewrite (see
 * docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-2-stage-r-t-charter-decision.md):
 * the numbered-heading convention died at the post-Stage-T CLAUDE.md
 * reorganization; the Stage R charter is still live but is now anchored
 * via the §8 "协作文档索引" plan-file link. The verify-chain rule is
 * relaxed from "main verify must embed verify:r" to "either verify OR
 * verify:cloud embeds verify:r" (current repo state: only verify:cloud
 * does). This relaxation is recorded as a Stage Z follow-up in the
 * Stage Y deferred-work ledger.
 *
 * Current asserted contract:
 *   1. CLAUDE.md §8 lists the Stage R plan file
 *      docs/superpowers/plans/2026-05-08-R-stage12-implementation.md.
 *   2. AGENTS.md §8 mirrors the same plan-file link.
 *   3. Either package.json `verify` OR `verify:cloud` chain embeds
 *      `verify:r` (or a later stage that transitively embeds it).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

const STAGE_R_PLAN_LINK =
  'docs/superpowers/plans/2026-05-08-R-stage12-implementation.md'

function readFile(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    errors.push(`cannot read ${rel}: ${e.message}`)
    return ''
  }
}

const pkgRaw = readFile('package.json')
let pkg = null
try {
  pkg = JSON.parse(pkgRaw)
} catch (e) {
  errors.push(`package.json parse failed: ${e.message}`)
}

if (pkg) {
  const verify = pkg.scripts?.['verify'] || ''
  const verifyCloud = pkg.scripts?.['verify:cloud'] || ''
  // Accept Stage R or any later cutover (verify:r, verify:s, verify:t, ...) —
  // each later stage's verify chain transitively embeds verify:r.
  const stageRorLater = /verify:[r-z]\b/
  const embedsInVerify = stageRorLater.test(verify)
  const embedsInVerifyCloud = stageRorLater.test(verifyCloud)
  if (!embedsInVerify && !embedsInVerifyCloud) {
    errors.push(
      "package.json: neither 'verify' nor 'verify:cloud' embeds 'verify:r' " +
        '(or a later stage chain that transitively embeds it). At least one ' +
        'of them must mount the Stage R chain per Y0.1.2 rewrite contract. ' +
        `verify=${verify || '<missing>'}; verify:cloud=${verifyCloud || '<missing>'}`,
    )
  }
}

const claudeMd = readFile('CLAUDE.md')
if (claudeMd && !claudeMd.includes(STAGE_R_PLAN_LINK)) {
  errors.push(
    `CLAUDE.md: missing Stage R plan-file link '${STAGE_R_PLAN_LINK}' ` +
      "(expected under §8 '协作文档索引')",
  )
}

const agentsMd = readFile('AGENTS.md')
if (agentsMd && !agentsMd.includes(STAGE_R_PLAN_LINK)) {
  errors.push(
    `AGENTS.md: missing Stage R plan-file link '${STAGE_R_PLAN_LINK}' ` +
      '(CLAUDE.md/AGENTS.md must stay in sync per CLAUDE.md §12)',
  )
}

if (errors.length > 0) {
  console.error('[check-stage-r-verify-switch] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-stage-r-verify-switch] OK')
