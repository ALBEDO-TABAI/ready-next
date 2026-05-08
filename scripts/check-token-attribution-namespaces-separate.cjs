#!/usr/bin/env node
/**
 * Stage S (PR-S8 / W5.2) — token attribution namespaces are decoupled
 * from the tool-error metrics registry.
 *
 * Two contracts are enforced:
 *
 *   1. `token-usage-middleware.ts` must NOT import from
 *      `tool-error-metrics` (or any path ending in
 *      `tool-error-metrics`). Token attribution is observability, not
 *      tool-error reporting; mixing them would dilute the §6.11
 *      `TOOL_ERROR_METRICS` contract.
 *
 *   2. `TOKEN_ATTRIBUTION_NAMESPACES` is a fixed 2-element tuple:
 *      ['model_call', 'task_card_step']. This is the contract every
 *      downstream consumer (task-projection-sync, span emit, dashboard)
 *      will rely on; if it grows or shrinks the consumers must opt in
 *      explicitly via a separate PR.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const SOURCE_REL = 'src/main/modules/agent-control/token-usage-middleware.ts'
const EXPECTED_NAMESPACES = ['model_call', 'task_card_step']

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, SOURCE_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing source: ${SOURCE_REL}`] }
  }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  // (1) Must NOT import from tool-error-metrics.
  // Match `from '...tool-error-metrics'` (any quote, any prefix).
  const importRe = /from\s+['"][^'"\n]*tool-error-metrics['"]/
  if (importRe.test(src)) {
    errors.push(
      `${SOURCE_REL}: must not import from tool-error-metrics (token attribution is observability, not a tool-error metric)`,
    )
  }
  // Also forbid bare reference to the registry symbol.
  if (/\bTOOL_ERROR_METRICS\b/.test(src)) {
    errors.push(
      `${SOURCE_REL}: must not reference TOOL_ERROR_METRICS (per §6.11, token attribution lives in its own registry)`,
    )
  }

  // (2) TOKEN_ATTRIBUTION_NAMESPACES must be a fixed 2-element tuple.
  const declRe =
    /export\s+const\s+TOKEN_ATTRIBUTION_NAMESPACES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/
  const m = src.match(declRe)
  if (!m) {
    errors.push(
      `${SOURCE_REL}: missing \`export const TOKEN_ATTRIBUTION_NAMESPACES = [...] as const\``,
    )
  } else {
    const body = m[1]
    const literals = []
    const litRe = /'([^']+)'|"([^"]+)"/g
    let lm
    while ((lm = litRe.exec(body)) !== null) {
      literals.push(lm[1] ?? lm[2])
    }
    if (literals.length !== EXPECTED_NAMESPACES.length) {
      errors.push(
        `${SOURCE_REL}: TOKEN_ATTRIBUTION_NAMESPACES must contain exactly ${EXPECTED_NAMESPACES.length} elements, got ${literals.length} (${literals.join(', ')})`,
      )
    } else {
      for (let i = 0; i < EXPECTED_NAMESPACES.length; i++) {
        if (literals[i] !== EXPECTED_NAMESPACES[i]) {
          errors.push(
            `${SOURCE_REL}: TOKEN_ATTRIBUTION_NAMESPACES[${i}] must be '${EXPECTED_NAMESPACES[i]}', got '${literals[i]}'`,
          )
        }
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-token-attribution-namespaces-separate] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-token-attribution-namespaces-separate] OK')
}

module.exports = { check, SOURCE_REL, EXPECTED_NAMESPACES }
