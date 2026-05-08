#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.2) — gemini-oai patch profile must preserve
 * `thought_signature` round-trips.
 *
 * Verification strategy:
 *  1. Shape: profile file exists, declares matchPredicate that checks
 *     `generativelanguage.googleapis.com / vertex / aiplatform` (any
 *     of the 3 hostnames) AND `gemini-` model prefix.
 *  2. Behavior: profile carries a `requestPatcher` that walks
 *     `messages[].tool_calls[]` / `input[].tool_calls[]` and explicitly
 *     references `thought_signature` (preservation by no-op, see
 *     comments in profile source).
 *
 * Behavior assertion is structural — the test
 * `provider-patch-profiles.test.ts` covers runtime semantics.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET = 'src/shared/ai-providers/patch-profiles/gemini-oai.ts'

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET)
  if (!fs.existsSync(abs)) return { ok: false, errors: [`Missing ${TARGET}`] }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  if (!/generativelanguage\.googleapis\.com/.test(src)) {
    errors.push('matchPredicate must reference `generativelanguage.googleapis.com`')
  }
  if (!/vertex/.test(src)) errors.push('matchPredicate must reference `vertex`')
  if (!/aiplatform/.test(src)) errors.push('matchPredicate must reference `aiplatform`')
  if (!/gemini-/i.test(src)) errors.push('matchPredicate must check `gemini-` model prefix')

  if (!/thought_signature/.test(src)) {
    errors.push('requestPatcher must reference `thought_signature` (preservation contract)')
  }
  if (!/\bexport\s+const\s+requestPatcher\s*=/.test(src)) {
    errors.push('Profile must export a non-undefined `requestPatcher`')
  }
  if (!/messages\b|\binput\b/.test(src)) {
    errors.push('requestPatcher must walk `messages` and/or `input` arrays')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-gemini-thought-signature-preserved] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-gemini-thought-signature-preserved] OK')
}

module.exports = { check }
