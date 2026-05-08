#!/usr/bin/env node
/**
 * Stage S (PR-S5 / W4.0) — conservative default contract.
 *
 * Providers that are not proven to support a capability must declare
 * the capability as `false` in their `capabilityClass`. This is the
 * "未填 = 拒绝" rule the user spec calls out:
 *
 *   - `fox`               (FoxCode / NewCLI Codex — text-only Codex relay)
 *   - `volcengine`        (Doubao chat models without vision)
 *   - `openai-compatible` (generic third-party endpoint, capabilities unknown)
 *
 * Each of these three sub-modules must declare BOTH:
 *
 *   - capabilityClass.supportsVision   = false
 *   - capabilityClass.supportsThinking = false
 *
 * `supportsLongContext` is intentionally NOT gated here because PR-S5's
 * three-layer merge has a context-window-driven legacy fallback
 * (`(modelDef?.contextWindow ?? 0) >= 128000`) that already gives
 * model-level granularity — providers can opt their large-context
 * models in via `capabilityOverrides` or `contextWindow` without
 * needing a provider-class flip.
 *
 * The output of `resolveAIConfigCapabilities` for any model under
 * these three providers (when neither `capabilityOverrides` nor user
 * `visionMode/thinkingMode='on'` is set) must therefore resolve to
 * `false` for vision and thinking — because the three-layer merge
 * walks: model overrides (none) → provider class (false) → legacy
 * heuristic (skipped because provider class already set the value).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const CONSERVATIVE_PROVIDERS = ['fox', 'volcengine', 'openai-compatible']
const REQUIRED_FALSE_FIELDS = ['supportsVision', 'supportsThinking']

function checkCapabilityGateConservativeDefault({ root = REPO_DEFAULT } = {}) {
  const subDir = path.join(root, 'src/shared/ai-providers')
  if (!fs.existsSync(subDir)) {
    return { ok: false, errors: ['Missing src/shared/ai-providers/ directory'] }
  }

  const errors = []

  for (const providerId of CONSERVATIVE_PROVIDERS) {
    const file = `${providerId}.ts`
    const abs = path.join(subDir, file)
    const rel = `src/shared/ai-providers/${file}`
    if (!fs.existsSync(abs)) {
      errors.push(`${rel}: missing provider sub-module`)
      continue
    }
    const src = fs.readFileSync(abs, 'utf8')
    const blockMatch = src.match(/export\s+const\s+capabilityClass\s*:\s*ProviderCapabilityClass\s*=\s*(\{[\s\S]*?\})/)
    if (!blockMatch) {
      errors.push(`${rel}: missing capabilityClass literal`)
      continue
    }
    const body = blockMatch[1]
    for (const field of REQUIRED_FALSE_FIELDS) {
      const falseRe = new RegExp(`\\b${field}\\s*:\\s*false\\b`)
      const trueRe = new RegExp(`\\b${field}\\s*:\\s*true\\b`)
      if (trueRe.test(body)) {
        errors.push(`${rel}: capabilityClass.${field} must be \`false\` for conservative default (provider not proven to support it)`)
        continue
      }
      if (!falseRe.test(body)) {
        errors.push(`${rel}: capabilityClass.${field} must be explicitly \`false\` (not missing / not undefined)`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkCapabilityGateConservativeDefault()
  if (!result.ok) {
    console.error('[check-capability-gate-conservative-default] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-capability-gate-conservative-default] OK')
}

module.exports = {
  checkCapabilityGateConservativeDefault,
  CONSERVATIVE_PROVIDERS,
  REQUIRED_FALSE_FIELDS,
}
