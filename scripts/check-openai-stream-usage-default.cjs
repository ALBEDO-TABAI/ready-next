#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.5) — `openai-compatible` provider sub-module
 * ships a `defaultRequestPatcher` that turns on
 * `stream_options.include_usage = true` and the legacy
 * `stream_usage = true` mirror, but only when the caller has not set
 * the value (preserves user config).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET = 'src/shared/ai-providers/openai-compatible.ts'

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET)
  if (!fs.existsSync(abs)) return { ok: false, errors: [`Missing ${TARGET}`] }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  if (!/\bexport\s+const\s+defaultRequestPatcher\b/.test(src)) {
    errors.push('Sub-module must export `defaultRequestPatcher`')
  }
  if (!/stream_options\b/.test(src)) {
    errors.push('defaultRequestPatcher must reference `stream_options`')
  }
  if (!/include_usage\b/.test(src)) {
    errors.push('defaultRequestPatcher must set `include_usage`')
  }
  if (!/stream_usage\b/.test(src)) {
    errors.push('defaultRequestPatcher must set legacy `stream_usage` mirror')
  }
  // Must preserve user-supplied value (only fill `=== undefined`).
  if (!/===\s*undefined/.test(src)) {
    errors.push('defaultRequestPatcher must only fill `=== undefined` slots (preserve user config)')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-openai-stream-usage-default] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-openai-stream-usage-default] OK')
}

module.exports = { check }
