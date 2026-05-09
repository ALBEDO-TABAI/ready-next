#!/usr/bin/env node
/**
 * Stage S (PR-S7 / W4.5) — text-only models declare their capability
 * via `capabilityOverrides` rather than special-case literals.
 *
 * Asserts that the openai provider sub-module's `o3-mini` model entry
 * carries `capabilityOverrides: { supportsThinking: true,
 * supportsVision: false }` (PR-S7 fixture). This proves the resolver
 * pipeline has the data it needs for the legacy `m === 'o3-mini'`
 * branches that PR-S7 deleted.
 *
 * The matching runtime check (resolver returning thinking=true /
 * vision=false) lives in `model-capability-overrides.test.ts`.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/shared/ai-providers/openai.ts'

function checkTextOnlyModelsResolveTextOnly({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing target file: ${TARGET_REL}`] }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  // Locate the o3-mini model entry. Tolerant to single-line or
  // multi-line literal form. Capture the surrounding `{ ... }` block
  // so we can verify `capabilityOverrides` is set inside it.
  const entryRe = /\{\s*[^{}]*?id\s*:\s*['"]o3-mini['"][\s\S]*?\}/m
  const entryMatch = src.match(entryRe)
  if (!entryMatch) {
    errors.push(`${TARGET_REL}: cannot locate o3-mini model entry`)
    return { ok: errors.length === 0, errors }
  }

  const entryBody = entryMatch[0]
  if (!/capabilityOverrides\s*:/.test(entryBody)) {
    errors.push(`${TARGET_REL}: o3-mini entry must declare \`capabilityOverrides\` (PR-S7 fixture)`)
  }
  if (!/supportsThinking\s*:\s*true\b/.test(entryBody)) {
    errors.push(`${TARGET_REL}: o3-mini.capabilityOverrides.supportsThinking must be \`true\``)
  }
  if (!/supportsVision\s*:\s*false\b/.test(entryBody)) {
    errors.push(`${TARGET_REL}: o3-mini.capabilityOverrides.supportsVision must be \`false\``)
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkTextOnlyModelsResolveTextOnly()
  if (!result.ok) {
    console.error('[check-text-only-models-resolve-text-only] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-text-only-models-resolve-text-only] OK')
}

module.exports = { checkTextOnlyModelsResolveTextOnly }
