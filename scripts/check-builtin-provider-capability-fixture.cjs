#!/usr/bin/env node
/**
 * Stage S (PR-S5 / W4.0) — built-in provider capabilityClass fixture gate.
 *
 * Each of the 7 declared providers under `src/shared/ai-providers/`
 * must export a `capabilityClass: ProviderCapabilityClass` literal
 * with all three canonical fields populated as `true | false`
 * (no `undefined` / no missing fields). PR-S3 wrote the literals;
 * this gate freezes the shape so PR-S5's three-layer merge can rely
 * on each provider supplying a complete fixture (and never silently
 * fall through to the legacy heuristic for the `provider class` layer
 * just because someone forgot to declare a field).
 *
 * Field names are canonical:
 *   - supportsVision
 *   - supportsThinking
 *   - supportsLongContext
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const PROVIDER_FILES = [
  'moonshot.ts',
  'anthropic.ts',
  'fox.ts',
  'openai.ts',
  'gemini.ts',
  'volcengine.ts',
  'openai-compatible.ts',
]

const REQUIRED_FIELDS = ['supportsVision', 'supportsThinking', 'supportsLongContext']

function checkBuiltinProviderCapabilityFixture({ root = REPO_DEFAULT } = {}) {
  const subDir = path.join(root, 'src/shared/ai-providers')
  if (!fs.existsSync(subDir)) {
    return { ok: false, errors: ['Missing src/shared/ai-providers/ directory'] }
  }

  const errors = []

  for (const file of PROVIDER_FILES) {
    const abs = path.join(subDir, file)
    const rel = `src/shared/ai-providers/${file}`
    if (!fs.existsSync(abs)) {
      errors.push(`${rel}: missing provider sub-module`)
      continue
    }
    const src = fs.readFileSync(abs, 'utf8')

    // Locate the capabilityClass literal block. It must be:
    //   export const capabilityClass: ProviderCapabilityClass = {
    //     supportsVision: <bool>,
    //     supportsThinking: <bool>,
    //     supportsLongContext: <bool>,
    //   }
    const blockMatch = src.match(/export\s+const\s+capabilityClass\s*:\s*ProviderCapabilityClass\s*=\s*(\{[\s\S]*?\})/)
    if (!blockMatch) {
      errors.push(`${rel}: missing \`export const capabilityClass: ProviderCapabilityClass = { ... }\` literal`)
      continue
    }
    const body = blockMatch[1]

    for (const field of REQUIRED_FIELDS) {
      // Canonical literal form: `<field>: true,` or `<field>: false,`.
      // Reject `undefined`, ternaries, identifier references, or
      // missing field outright.
      const literalRe = new RegExp(`\\b${field}\\s*:\\s*(true|false)\\b`)
      if (!literalRe.test(body)) {
        errors.push(`${rel}: capabilityClass.${field} must be a boolean literal (true|false)`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkBuiltinProviderCapabilityFixture()
  if (!result.ok) {
    console.error('[check-builtin-provider-capability-fixture] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-builtin-provider-capability-fixture] OK')
}

module.exports = { checkBuiltinProviderCapabilityFixture, PROVIDER_FILES, REQUIRED_FIELDS }
