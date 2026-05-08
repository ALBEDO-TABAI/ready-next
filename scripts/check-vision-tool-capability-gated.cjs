#!/usr/bin/env node
/**
 * Stage S (PR-S6 / W4.2) — vision tool capability gating.
 *
 * `tool-gateway.ts` must carry a load-time check that consults
 * `capabilityResolution.supportsVision` (or a `CapabilityResolution`
 * type ref) before exposing vision-bearing tools to the model.
 *
 * Today the `view_image` tool does not yet ship; the gateway exposes
 * the helper `filterToolsByVisionCapability(tools, capabilityResolution)`
 * + a `VISION_REQUIRING_TOOL_NAMES` allowlist so future vision tools
 * land in one place. The gate just checks the helper + the
 * `supportsVision` reference are wired in the gateway file.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/main/modules/agent-control/tool-gateway.ts'

function checkVisionToolCapabilityGated({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const targetAbs = path.join(root, TARGET_REL)
  if (!fs.existsSync(targetAbs)) {
    errors.push(`Missing target: ${TARGET_REL}`)
    return { ok: false, errors }
  }
  const src = fs.readFileSync(targetAbs, 'utf8')

  if (!/\bsupportsVision\b/.test(src)) {
    errors.push(`${TARGET_REL}: missing \`supportsVision\` reference`)
  }
  if (!/\bCapabilityResolution\b/.test(src)) {
    errors.push(`${TARGET_REL}: missing \`CapabilityResolution\` type reference`)
  }
  if (!/\bVISION_REQUIRING_TOOL_NAMES\b/.test(src)) {
    errors.push(`${TARGET_REL}: missing \`VISION_REQUIRING_TOOL_NAMES\` allowlist export`)
  }
  if (!/\bfilterToolsByVisionCapability\b/.test(src)) {
    errors.push(`${TARGET_REL}: missing \`filterToolsByVisionCapability\` helper`)
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkVisionToolCapabilityGated()
  if (!result.ok) {
    console.error('[check-vision-tool-capability-gated] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-vision-tool-capability-gated] OK')
}

module.exports = { checkVisionToolCapabilityGated }
