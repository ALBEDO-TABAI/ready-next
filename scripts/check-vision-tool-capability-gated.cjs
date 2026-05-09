#!/usr/bin/env node
/**
 * Stage S (PR-S6 / W4.2) — vision tool capability gating.
 *
 * Round 1 (helper-only) checked the helper + `supportsVision` reference
 * existed in `tool-gateway.ts`. Round 2 strengthened this to require a
 * production consumer of `filterToolsByVisionCapability` outside the
 * gateway file — i.e. the bundle path that builds the model's tool list
 * actually calls it. We assert:
 *
 *   1. `tool-gateway.ts` declares the helper + symbols.
 *   2. `execution-tool-config.ts` (the model-visible bundle path)
 *      imports and CALLS `filterToolsByVisionCapability` at least once
 *      in BOTH the anthropic path (`getPolicyAnthropicTools`) and the
 *      openai bundle path (`getPolicyOpenAIToolBundle`).
 *   3. `run-capability-controller.ts` writes `capabilityResolution`
 *      onto the policy so the bundle path has the flag to consult.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const GATEWAY_REL = 'src/main/modules/agent-control/tool-gateway.ts'
const BUNDLE_REL = 'src/main/modules/agent-control/execution-tool-config.ts'
const CONTROLLER_REL = 'src/main/modules/agent-control/run-capability-controller.ts'

function checkVisionToolCapabilityGated({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const gatewayAbs = path.join(root, GATEWAY_REL)
  if (!fs.existsSync(gatewayAbs)) {
    errors.push(`Missing target: ${GATEWAY_REL}`)
    return { ok: false, errors }
  }
  const gatewaySrc = fs.readFileSync(gatewayAbs, 'utf8')

  if (!/\bsupportsVision\b/.test(gatewaySrc)) {
    errors.push(`${GATEWAY_REL}: missing \`supportsVision\` reference`)
  }
  if (!/\bCapabilityResolution\b/.test(gatewaySrc)) {
    errors.push(`${GATEWAY_REL}: missing \`CapabilityResolution\` type reference`)
  }
  if (!/\bVISION_REQUIRING_TOOL_NAMES\b/.test(gatewaySrc)) {
    errors.push(`${GATEWAY_REL}: missing \`VISION_REQUIRING_TOOL_NAMES\` allowlist export`)
  }
  if (!/\bfilterToolsByVisionCapability\b/.test(gatewaySrc)) {
    errors.push(`${GATEWAY_REL}: missing \`filterToolsByVisionCapability\` helper`)
  }

  // Round 2 strengthening — the bundle path must actually invoke the
  // helper, not just hold a dead export.
  const bundleAbs = path.join(root, BUNDLE_REL)
  if (!fs.existsSync(bundleAbs)) {
    errors.push(`Missing target: ${BUNDLE_REL}`)
  } else {
    const bundleSrc = fs.readFileSync(bundleAbs, 'utf8')
    const importsHelper = /import\s*\{[^}]*\bfilterToolsByVisionCapability\b[^}]*\}\s*from\s*['"]\.\/tool-gateway['"]/.test(bundleSrc)
    if (!importsHelper) {
      errors.push(`${BUNDLE_REL}: must import \`filterToolsByVisionCapability\` from './tool-gateway'`)
    }
    const callCount = (bundleSrc.match(/\bfilterToolsByVisionCapability\s*\(/g) || []).length
    if (callCount < 2) {
      errors.push(`${BUNDLE_REL}: filterToolsByVisionCapability called ${callCount} time(s); expected ≥ 2 (anthropic path + openai bundle path)`)
    }
  }

  // Round 2 strengthening — the controller must thread capabilityResolution
  // onto the policy so the bundle path has data to consult.
  const controllerAbs = path.join(root, CONTROLLER_REL)
  if (!fs.existsSync(controllerAbs)) {
    errors.push(`Missing target: ${CONTROLLER_REL}`)
  } else {
    const controllerSrc = fs.readFileSync(controllerAbs, 'utf8')
    if (!/toolPolicy\.capabilityResolution\s*=/.test(controllerSrc)) {
      errors.push(`${CONTROLLER_REL}: must assign \`toolPolicy.capabilityResolution\` so the bundle path can filter`)
    }
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
