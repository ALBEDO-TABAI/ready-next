#!/usr/bin/env node
/**
 * Stage S (PR-S6 / W4.1) — capability gate enforced in arbitration.
 *
 * `run-capability-controller.ts::resolveRunCapabilities` must read
 * `capabilityResolution.supportsVision` so the arbitration layer can
 * branch on the resolved vision capability without re-resolving from
 * `config`. This is the single integration point: PR-S5 already wires
 * the three-layer merge into `resolveAIConfigCapabilities`, and PR-S6
 * surfaces those flags onto `CapabilityResolution` (capability-resolver.ts).
 *
 * Pattern: literal grep for `capabilityResolution.supportsVision` plus a
 * sanity check that the file actually contains a vision-related branch.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/main/modules/agent-control/domain-adapters/run-capability-controller.ts'
const EXECUTOR_REL = 'src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts'

function checkCapabilityGateEnforcedInArbitration({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const targetAbs = path.join(root, TARGET_REL)
  if (!fs.existsSync(targetAbs)) {
    errors.push(`Missing target: ${TARGET_REL}`)
    return { ok: false, errors }
  }
  const src = fs.readFileSync(targetAbs, 'utf8')

  if (!/capabilityResolution\.supportsVision\b/.test(src)) {
    errors.push(`${TARGET_REL}: missing literal reference to \`capabilityResolution.supportsVision\``)
  }

  // Confirm the gating decision has a branch (not just a passive comment).
  const branchPattern = /capabilityResolution\.supportsVision\s*[!=]==?\s*(true|false)/
  if (!branchPattern.test(src)) {
    errors.push(`${TARGET_REL}: \`capabilityResolution.supportsVision\` must be branched on (=== true / !== true)`)
  }

  // P1-5 — capability floors must be computed on BOTH arbitration paths from the same function:
  // the controller (authoritative point) and the SDK executor (consumes the same computeCapabilityFloors).
  if (!/\bcomputeCapabilityFloors\s*\(/.test(src)) {
    errors.push(`${TARGET_REL}: missing \`computeCapabilityFloors(\` — capability floors not computed at the arbitration point`)
  }
  const executorAbs = path.join(root, EXECUTOR_REL)
  if (!fs.existsSync(executorAbs)) {
    errors.push(`Missing target: ${EXECUTOR_REL}`)
  } else if (!/\bcomputeCapabilityFloors\s*\(/.test(fs.readFileSync(executorAbs, 'utf8'))) {
    errors.push(`${EXECUTOR_REL}: missing \`computeCapabilityFloors(\` — SDK path must consume the same floors function`)
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkCapabilityGateEnforcedInArbitration()
  if (!result.ok) {
    console.error('[check-capability-gate-enforced-in-arbitration] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-capability-gate-enforced-in-arbitration] OK')
}

module.exports = { checkCapabilityGateEnforcedInArbitration }
