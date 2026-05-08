#!/usr/bin/env node
/**
 * Stage S W8.1 — L2 layered compactor stub gate.
 *
 * Asserts:
 *   - `src/main/modules/agent-control/layered-compactor-l2-stub.ts` exists
 *     and contains both docstring markers `stub-only` and `not in production path`.
 *   - The production turn-engine (`src/main/modules/agent-control/turn-engine.ts`)
 *     does NOT import the stub. The stub must remain isolated from
 *     production turn flow per §6.15.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const STUB_REL = 'src/main/modules/agent-control/layered-compactor-l2-stub.ts'
const TURN_ENGINE_REL = 'src/main/modules/agent-control/turn-engine.ts'

function check({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const stubAbs = path.join(root, STUB_REL)
  if (!fs.existsSync(stubAbs)) {
    errors.push(`Missing ${STUB_REL}`)
  } else {
    const src = fs.readFileSync(stubAbs, 'utf8')
    if (!/stub-only/i.test(src)) {
      errors.push(`${STUB_REL} must contain docstring marker "stub-only"`)
    }
    if (!/not in production path/i.test(src)) {
      errors.push(`${STUB_REL} must contain docstring marker "not in production path"`)
    }
  }

  const turnEngineAbs = path.join(root, TURN_ENGINE_REL)
  if (fs.existsSync(turnEngineAbs)) {
    const src = fs.readFileSync(turnEngineAbs, 'utf8')
    // grep production code does NOT import the stub
    if (/layered-compactor-l2-stub/.test(src)) {
      errors.push(
        `${TURN_ENGINE_REL} must NOT reference layered-compactor-l2-stub (stub is non-production)`,
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-l2-stub-not-in-production-path] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-l2-stub-not-in-production-path] OK')
}

module.exports = { check, STUB_REL, TURN_ENGINE_REL }
