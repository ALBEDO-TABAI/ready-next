#!/usr/bin/env node
/**
 * Stage S (PR-S8 / W5.3) — token attribution dimensions registry is
 * a fixed 6-element tuple in a stable order.
 *
 * `TOKEN_ATTRIBUTION_DIMENSIONS` must be exported as:
 *
 *   ['search', 'fetch', 'subagent', 'present', 'clarification', 'todo']
 *
 * Downstream consumers (task projection step rollups, dashboard
 * aggregation) rely on this exact set. Adding or removing a dimension
 * must be a deliberate registry change, not a quiet edit.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const SOURCE_REL = 'src/main/modules/agent-control/token-attribution-dimensions.ts'
const EXPECTED_DIMENSIONS = [
  'search',
  'fetch',
  'subagent',
  'present',
  'clarification',
  'todo',
]

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, SOURCE_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing source: ${SOURCE_REL}`] }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  const declRe =
    /export\s+const\s+TOKEN_ATTRIBUTION_DIMENSIONS\s*=\s*\[([\s\S]*?)\]\s*as\s+const/
  const m = src.match(declRe)
  if (!m) {
    errors.push(
      `${SOURCE_REL}: missing \`export const TOKEN_ATTRIBUTION_DIMENSIONS = [...] as const\``,
    )
    return { ok: false, errors }
  }

  const body = m[1]
  const literals = []
  const litRe = /'([^']+)'|"([^"]+)"/g
  let lm
  while ((lm = litRe.exec(body)) !== null) {
    literals.push(lm[1] ?? lm[2])
  }
  if (literals.length !== EXPECTED_DIMENSIONS.length) {
    errors.push(
      `${SOURCE_REL}: TOKEN_ATTRIBUTION_DIMENSIONS must contain exactly ${EXPECTED_DIMENSIONS.length} elements, got ${literals.length} (${literals.join(', ')})`,
    )
  } else {
    for (let i = 0; i < EXPECTED_DIMENSIONS.length; i++) {
      if (literals[i] !== EXPECTED_DIMENSIONS[i]) {
        errors.push(
          `${SOURCE_REL}: TOKEN_ATTRIBUTION_DIMENSIONS[${i}] must be '${EXPECTED_DIMENSIONS[i]}', got '${literals[i]}'`,
        )
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-token-attribution-dimensions-registered] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-token-attribution-dimensions-registered] OK')
}

module.exports = { check, SOURCE_REL, EXPECTED_DIMENSIONS }
