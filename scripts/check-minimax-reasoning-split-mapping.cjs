#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.4) — minimax patch profile maps
 * `reasoning_details` (returned when caller sets
 * `extra_body.reasoning_split=true`) to
 * `additional_kwargs.reasoning_content`.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET = 'src/shared/ai-providers/patch-profiles/minimax.ts'

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET)
  if (!fs.existsSync(abs)) return { ok: false, errors: [`Missing ${TARGET}`] }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  if (!/api\.minimax\.chat/.test(src)) {
    errors.push('matchPredicate must reference `api.minimax.chat`')
  }
  if (!/minimaxi\.com/i.test(src)) {
    errors.push('matchPredicate must reference `minimaxi.com`')
  }
  if (!/MiniMax-/.test(src)) {
    errors.push('matchPredicate must check `MiniMax-` model prefix')
  }
  if (!/reasoning_details/.test(src)) {
    errors.push('responsePatcher must consume `reasoning_details`')
  }
  if (!/additional_kwargs/.test(src)) {
    errors.push('responsePatcher must populate `additional_kwargs`')
  }
  if (!/reasoning_content/.test(src)) {
    errors.push('responsePatcher must produce `reasoning_content` field')
  }
  if (!/\bexport\s+const\s+responsePatcher\s*=/.test(src)) {
    errors.push('Profile must export a non-undefined `responsePatcher`')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-minimax-reasoning-split-mapping] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-minimax-reasoning-split-mapping] OK')
}

module.exports = { check }
