#!/usr/bin/env node
/**
 * Stage S (PR-S2 / W3.0.5) — verify `AIProviderDef` declares an
 * optional `capabilityClass` block with the canonical
 * `supportsVision / supportsThinking / supportsLongContext` field
 * names. This is the provider-default layer for the three-layer
 * capability merge wired up in PR-S5.
 *
 * Codex round 1 spec note (#3) — field names are
 * `supportsVision / supportsThinking / supportsLongContext`,
 * not the bare `vision / thinking / longContext` shorthand.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/shared/ai-providers.ts'

function checkAIProviderDefCapabilityClass({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing target file: ${TARGET_REL}`] }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  // Find the AIProviderDef interface block (greedy enough to span the body).
  const ifaceMatch = src.match(/export\s+interface\s+AIProviderDef\s*\{[\s\S]*?\n\}/)
  if (!ifaceMatch) {
    errors.push('Cannot find `export interface AIProviderDef { ... }` block')
    return { ok: false, errors }
  }
  const body = ifaceMatch[0]

  if (!/\bcapabilityClass\?\s*:/.test(body)) {
    errors.push('AIProviderDef is missing optional `capabilityClass?: { ... }` field')
  }
  // Canonical field names — must use `supportsVision`, etc., not bare
  // `vision`. Look inside the block for at least one occurrence.
  for (const fieldName of ['supportsVision', 'supportsThinking', 'supportsLongContext']) {
    const re = new RegExp(`\\b${fieldName}\\?\\s*:`)
    if (!re.test(body)) {
      errors.push(`AIProviderDef.capabilityClass is missing canonical field \`${fieldName}?:\``)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkAIProviderDefCapabilityClass()
  if (!result.ok) {
    console.error('[check-ai-provider-def-capability-class] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-ai-provider-def-capability-class] OK')
}

module.exports = { checkAIProviderDefCapabilityClass }
