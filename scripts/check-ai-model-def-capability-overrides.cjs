#!/usr/bin/env node
/**
 * Stage S (PR-S2 / W3.0.5) — verify `AIModelDef` declares an optional
 * `capabilityOverrides` block with the canonical
 * `supportsVision / supportsThinking / supportsLongContext` field
 * names. This is the model-override layer (highest priority) for
 * the three-layer capability merge wired up in PR-S5.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/shared/ai-providers.ts'

function checkAIModelDefCapabilityOverrides({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing target file: ${TARGET_REL}`] }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  const ifaceMatch = src.match(/export\s+interface\s+AIModelDef\s*\{[\s\S]*?\n\}/)
  if (!ifaceMatch) {
    errors.push('Cannot find `export interface AIModelDef { ... }` block')
    return { ok: false, errors }
  }
  const body = ifaceMatch[0]

  if (!/\bcapabilityOverrides\?\s*:/.test(body)) {
    errors.push('AIModelDef is missing optional `capabilityOverrides?: { ... }` field')
  }
  for (const fieldName of ['supportsVision', 'supportsThinking', 'supportsLongContext']) {
    const re = new RegExp(`\\b${fieldName}\\?\\s*:`)
    if (!re.test(body)) {
      errors.push(`AIModelDef.capabilityOverrides is missing canonical field \`${fieldName}?:\``)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkAIModelDefCapabilityOverrides()
  if (!result.ok) {
    console.error('[check-ai-model-def-capability-overrides] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-ai-model-def-capability-overrides] OK')
}

module.exports = { checkAIModelDefCapabilityOverrides }
