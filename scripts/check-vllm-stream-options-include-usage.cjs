#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.5) — vLLM patch profile forces
 * `body.stream_options.include_usage === true && body.stream_usage === true`
 * after running, but only when the caller has not set the value.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET = 'src/shared/ai-providers/patch-profiles/vllm.ts'

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET)
  if (!fs.existsSync(abs)) return { ok: false, errors: [`Missing ${TARGET}`] }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  if (!/\bexport\s+const\s+requestPatcher\s*=/.test(src)) {
    errors.push('Profile must export a non-undefined `requestPatcher`')
  }
  if (!/stream_options\b/.test(src)) {
    errors.push('requestPatcher must reference `stream_options`')
  }
  if (!/include_usage\b/.test(src)) {
    errors.push('requestPatcher must set `include_usage`')
  }
  if (!/stream_usage\b/.test(src)) {
    errors.push('requestPatcher must set `stream_usage` field')
  }
  // matchPredicate must require /v1 baseUrl
  if (!/\\\/v1\\\/\?\$|\/v1\\?\/\?\$|v1\\?\\\/\?\$|v1\/\?\$/.test(src)) {
    errors.push('matchPredicate must require baseUrl ending in `/v1` or `/v1/`')
  }
  // matchPredicate keywords
  if (!/vllm\//.test(src)) {
    errors.push('matchPredicate must check `vllm/` model prefix')
  }
  if (!/qwen-/.test(src)) {
    errors.push('matchPredicate must check `qwen-` keyword')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-vllm-stream-options-include-usage] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-vllm-stream-options-include-usage] OK')
}

module.exports = { check }
