#!/usr/bin/env node
/**
 * Stage S W8.2 — llm-resilience retry status code gate.
 *
 * Asserts the canonical retry status code tuple in
 * `src/main/modules/claude-bridge/llm-resilience.ts` contains exactly
 * the 8 expected literals: 408, 409, 425, 429, 500, 502, 503, 504.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const SOURCE_REL = 'src/main/modules/claude-bridge/llm-resilience.ts'
const EXPECTED_CODES = [408, 409, 425, 429, 500, 502, 503, 504]

function check({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const abs = path.join(root, SOURCE_REL)
  if (!fs.existsSync(abs)) {
    errors.push(`Missing ${SOURCE_REL}`)
    return { ok: false, errors }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const m = src.match(/RETRY_STATUS_CODES\s*=\s*\[([^\]]*)\]\s*as\s+const/)
  if (!m) {
    errors.push('Missing `export const RETRY_STATUS_CODES = [...] as const`')
    return { ok: false, errors }
  }
  const parsed = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
  for (const code of EXPECTED_CODES) {
    if (!parsed.includes(code)) {
      errors.push(`RETRY_STATUS_CODES missing expected code ${code}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-llm-retry-status-codes] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-llm-retry-status-codes] OK')
}

module.exports = { check, SOURCE_REL, EXPECTED_CODES }
