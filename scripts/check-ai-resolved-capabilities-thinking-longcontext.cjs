#!/usr/bin/env node
/**
 * Stage S (PR-S2 / W3.0.6) — verify `AIResolvedCapabilities` declares
 * required (non-optional) `supportsThinking: boolean` and
 * `supportsLongContext: boolean` fields.
 *
 * Required (not `?:`) so consumers can branch unconditionally once
 * PR-S5 wires the `model.capabilityOverrides → provider.capabilityClass
 * → legacy heuristics` three-layer merge. PR-S2 emits `false`
 * placeholders to keep the type sound until then.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/shared/ai-providers.ts'

function checkAIResolvedCapabilitiesThinkingLongcontext({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing target file: ${TARGET_REL}`] }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  const ifaceMatch = src.match(/export\s+interface\s+AIResolvedCapabilities\s*\{[\s\S]*?\n\}/)
  if (!ifaceMatch) {
    errors.push('Cannot find `export interface AIResolvedCapabilities { ... }` block')
    return { ok: false, errors }
  }
  const body = ifaceMatch[0]

  // Required (no `?`): `\bsupportsThinking\s*:` and `\bsupportsLongContext\s*:`.
  // Reject the optional `?:` form explicitly.
  for (const fieldName of ['supportsThinking', 'supportsLongContext']) {
    const requiredRe = new RegExp(`\\b${fieldName}\\s*:\\s*boolean\\b`)
    const optionalRe = new RegExp(`\\b${fieldName}\\?\\s*:`)
    if (optionalRe.test(body)) {
      errors.push(`AIResolvedCapabilities.${fieldName} must be required, not optional (\`${fieldName}: boolean\`)`)
      continue
    }
    if (!requiredRe.test(body)) {
      errors.push(`AIResolvedCapabilities is missing required field \`${fieldName}: boolean\``)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkAIResolvedCapabilitiesThinkingLongcontext()
  if (!result.ok) {
    console.error('[check-ai-resolved-capabilities-thinking-longcontext] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-ai-resolved-capabilities-thinking-longcontext] OK')
}

module.exports = { checkAIResolvedCapabilitiesThinkingLongcontext }
