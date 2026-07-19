#!/usr/bin/env node
/**
 * Stage S W8.2 — llm-resilience retry status code gate.
 *
 * Asserts the explicit non-5xx retry status tuple in
 * `src/main/modules/claude-bridge/llm-resilience.ts` contains the three
 * request/rate-limit statuses. The complete 5xx range behavior is covered by
 * the TypeScript behavior test rather than duplicated as a literal list.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const SOURCE_REL = 'src/main/modules/claude-bridge/provider-terminal-error.ts'
const EXPECTED_CODES = [408, 425, 429]
const FORBIDDEN_CODES = [409]

function check({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const abs = path.join(root, SOURCE_REL)
  if (!fs.existsSync(abs)) {
    errors.push(`Missing ${SOURCE_REL}`)
    return { ok: false, errors }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const m = src.match(/PROVIDER_EXPLICIT_RETRY_STATUS_CODES\s*=\s*\[([^\]]*)\]\s*as\s+const/)
  if (!m) {
    errors.push('Missing `export const PROVIDER_EXPLICIT_RETRY_STATUS_CODES = [...] as const`')
    return { ok: false, errors }
  }
  const parsed = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
  for (const code of EXPECTED_CODES) {
    if (!parsed.includes(code)) {
      errors.push(`PROVIDER_EXPLICIT_RETRY_STATUS_CODES missing expected code ${code}`)
    }
  }
  for (const code of FORBIDDEN_CODES) {
    if (parsed.includes(code)) {
      errors.push(`PROVIDER_EXPLICIT_RETRY_STATUS_CODES contains non-retryable code ${code}`)
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

module.exports = { check, SOURCE_REL, EXPECTED_CODES, FORBIDDEN_CODES }
