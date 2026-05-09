#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.3) — deepseek patch profile preserves
 * `reasoning_content` across multi-turn loops.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET = 'src/shared/ai-providers/patch-profiles/deepseek.ts'

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET)
  if (!fs.existsSync(abs)) return { ok: false, errors: [`Missing ${TARGET}`] }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  if (!/\.deepseek\\?\.\(?(com|ai)/.test(src) && !/deepseek\.\(com\|ai\)/.test(src)) {
    errors.push('matchPredicate must reference deepseek.com / deepseek.ai baseUrl')
  }
  if (!/deepseek-/i.test(src)) {
    errors.push('matchPredicate must check `deepseek-` model prefix')
  }
  if (!/reasoning_content/.test(src)) {
    errors.push('requestPatcher must reference `reasoning_content` (multi-turn preservation)')
  }
  if (!/\bexport\s+const\s+requestPatcher\s*=/.test(src)) {
    errors.push('Profile must export a non-undefined `requestPatcher`')
  }
  if (!/messages\b/.test(src)) {
    errors.push('requestPatcher must walk `messages` array')
  }
  // Must be a *preservation* (assistant-role check), not a synth.
  if (!/role\s*===\s*['"]assistant['"]/.test(src)) {
    errors.push('requestPatcher must filter for `role === "assistant"`')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-deepseek-reasoning-content-multi-turn] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-deepseek-reasoning-content-multi-turn] OK')
}

module.exports = { check }
