#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.5) — vLLM patch profile must exclude the three
 * official providers (`openai`, `anthropic`, `gemini`) by config.id
 * regardless of baseUrl / model.
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

  // Must reject by config.id for the three official providers.
  for (const id of ['openai', 'anthropic', 'gemini']) {
    const pattern = new RegExp(`['"]${id}['"]`)
    if (!pattern.test(src)) {
      errors.push(`matchPredicate must reject config.id === '${id}'`)
    }
  }

  // Must early-return false on the official provider check (negative-form).
  if (!/return\s+false/.test(src)) {
    errors.push('matchPredicate must `return false` early on official-provider rejection')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-vllm-excludes-official-providers] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-vllm-excludes-official-providers] OK')
}

module.exports = { check }
