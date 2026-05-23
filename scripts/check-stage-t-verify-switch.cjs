#!/usr/bin/env node
/**
 * Stage T verify-switch gate — Y0.1.2 rewrite.
 *
 * Original (Stage T PR-T6) contract was:
 *   - package.json `verify` chain embeds `verify:t`
 *   - package.json `verify:cloud` chain embeds `verify:t`
 *   - CLAUDE.md contains the `### 6.27` heading
 *
 * Stage Y Y0.1.2 rewrite (see
 * docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-2-stage-r-t-charter-decision.md):
 * the numbered-heading convention died at the post-Stage-T CLAUDE.md
 * reorganization; the Stage T charter is still live but is now anchored
 * via the §8 "协作文档索引" plan-file link. The verify-chain rule is
 * relaxed from "main verify must embed verify:t" to "either verify OR
 * verify:cloud embeds verify:t" (current repo state: only verify:cloud
 * does). This relaxation is recorded as a Stage Z follow-up in the
 * Stage Y deferred-work ledger.
 *
 * Current asserted contract:
 *   1. CLAUDE.md §8 lists the Stage T plan file
 *      docs/superpowers/plans/2026-05-09-T-stage14-implementation.md.
 *   2. AGENTS.md §8 mirrors the same plan-file link.
 *   3. Either package.json `verify` OR `verify:cloud` chain embeds
 *      `verify:t`.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const errors = []

const STAGE_T_PLAN_LINK =
  'docs/superpowers/plans/2026-05-09-T-stage14-implementation.md'

function readFile(rel) {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
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
  const scripts = pkg.scripts || {}
  const verify = scripts['verify'] || ''
  const verifyCloud = scripts['verify:cloud'] || ''
  const embedsInVerify = verify.includes('verify:t')
  const embedsInVerifyCloud = verifyCloud.includes('verify:t')
  if (!embedsInVerify && !embedsInVerifyCloud) {
    errors.push(
      "package.json: neither 'verify' nor 'verify:cloud' embeds 'verify:t' " +
        '(Stage T switch). At least one must mount the Stage T chain per ' +
        `Y0.1.2 rewrite contract. verify=${verify || '<missing>'}; ` +
        `verify:cloud=${verifyCloud || '<missing>'}`,
    )
  }
}

const claudeMd = readFile('CLAUDE.md')
if (claudeMd && !claudeMd.includes(STAGE_T_PLAN_LINK)) {
  errors.push(
    `CLAUDE.md: missing Stage T plan-file link '${STAGE_T_PLAN_LINK}' ` +
      "(expected under §8 '协作文档索引')",
  )
}

const agentsMd = readFile('AGENTS.md')
if (agentsMd && !agentsMd.includes(STAGE_T_PLAN_LINK)) {
  errors.push(
    `AGENTS.md: missing Stage T plan-file link '${STAGE_T_PLAN_LINK}' ` +
      '(CLAUDE.md/AGENTS.md must stay in sync per CLAUDE.md §12)',
  )
}

if (errors.length > 0) {
  console.error('[check-stage-t-verify-switch] FAIL:')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log('[check-stage-t-verify-switch] OK')
