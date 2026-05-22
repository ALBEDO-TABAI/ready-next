#!/usr/bin/env node
/**
 * Stage X1.8 — replacement gate for sub-gates retired from verify:c/r/s/t
 * during the X1 stale-path repair closeout.
 *
 * Enforces two invariants on every run:
 *
 *   (a) Ledger integrity:
 *       docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md
 *       contains an entry for each retired sub-gate. The entry row must
 *       reference all required fields:
 *         - source-stage: X1
 *         - successor-stage: Stage Y (or Stage Y P1)
 *         - tracking-link: the X plan §11 path
 *
 *   (b) Chain composition retirement:
 *       package.json verify:c / verify:r / verify:s / verify:t scripts
 *       (and their transitive test:*:gates / verify:k composition) must
 *       NOT call `node scripts/check-sqlite-test-skip-pattern.cjs` and
 *       must NOT call `node scripts/check-stage-r-verify-switch.cjs` /
 *       `node scripts/check-stage-t-verify-switch.cjs`. The associated
 *       `.test.cjs` files must have been renamed off the `.test.cjs`
 *       wildcard surface (now `.deferred.cjs`).
 *
 * NOT wired into verify:c/r/s/t itself. Intended to be run by Stage X
 * closeout verification and Stage Y handoff.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const LEDGER_REL = 'docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md'
const TRACKING_LINK_REQUIRED =
  'docs/superpowers/plans/2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md#11-stage-y-seed-items'

const RETIRED_SUBGATES = [
  {
    name: 'check-sqlite-test-skip-pattern',
    ledgerKey: 'check-sqlite-test-skip-pattern',
    scriptPath: 'scripts/check-sqlite-test-skip-pattern.cjs',
    deferredTestPath: 'scripts/__tests__/check-sqlite-test-skip-pattern.deferred.cjs',
    legacyTestPath: 'scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs',
  },
  {
    name: 'check-stage-r-verify-switch',
    ledgerKey: 'check-stage-r-verify-switch',
    scriptPath: 'scripts/check-stage-r-verify-switch.cjs',
    deferredTestPath: 'scripts/__tests__/check-stage-r-verify-switch.deferred.cjs',
    legacyTestPath: 'scripts/__tests__/check-stage-r-verify-switch.test.cjs',
  },
  {
    name: 'check-testing-conventions-doc',
    ledgerKey: 'check-testing-conventions-doc',
    scriptPath: 'scripts/check-testing-conventions-doc.cjs',
    // The .test.cjs file passes against fixtures (no live-repo assertion),
    // so it stays as `.test.cjs` and is not renamed.
    deferredTestPath: null,
    legacyTestPath: null,
  },
  {
    name: 'check-research-adapter-registered-in-host',
    ledgerKey: 'check-research-adapter-registered-in-host',
    scriptPath: 'scripts/check-research-adapter-registered-in-host.cjs',
    deferredTestPath: null,
    legacyTestPath: null,
  },
]

// Direct package.json verify:* script bodies (not test wildcards) must
// not reference these literal `node scripts/<name>.cjs` invocations.
const FORBIDDEN_DIRECT_INVOCATIONS = [
  'scripts/check-sqlite-test-skip-pattern.cjs',
  'scripts/check-stage-r-verify-switch.cjs',
  'scripts/check-stage-t-verify-switch.cjs',
  'scripts/check-testing-conventions-doc.cjs',
  'scripts/check-research-adapter-registered-in-host.cjs',
]

// All verify:* scripts that can transitively embed a retired sub-gate.
// We seed with the four chains the X1.8 invariant covers (c/r/s/t) plus
// every intermediate verify:* that one of them descends into, so the
// transitive `npm run` expansion catches retired-sub-gate re-introductions
// at any level of the chain.
const VERIFY_SCRIPT_NAMES = [
  'verify:c',
  'verify:r',
  'verify:s',
  'verify:t',
  'verify:d',
  'verify:e',
  'verify:f',
  'verify:g',
  'verify:h',
  'verify:i',
  'verify:i1',
  'verify:j',
  'verify:k',
  'verify:l',
  'verify:m',
  'verify:n',
  'verify:o',
  'verify:p',
  'verify:q',
]

function main({ root = ROOT } = {}) {
  const errors = []

  // (a) Ledger integrity
  const ledgerAbs = path.join(root, LEDGER_REL)
  if (!fs.existsSync(ledgerAbs)) {
    errors.push(`ledger missing: ${LEDGER_REL}`)
  } else {
    const ledger = fs.readFileSync(ledgerAbs, 'utf8')
    for (const gate of RETIRED_SUBGATES) {
      if (!ledger.includes(gate.ledgerKey)) {
        errors.push(`ledger missing entry for retired sub-gate "${gate.ledgerKey}"`)
        continue
      }
      // Extract the row containing the gate name and assert required fields.
      const rowMatch = findLedgerRow(ledger, gate.ledgerKey)
      if (!rowMatch) {
        errors.push(`ledger entry for "${gate.ledgerKey}" exists but is not in a recognizable table row`)
        continue
      }
      const row = rowMatch
      if (!/source-stage/i.test(ledger) || !/\|\s*X1\s*\|/.test(row)) {
        errors.push(`ledger row for "${gate.ledgerKey}" missing source-stage=X1 column`)
      }
      if (!/Stage\s*Y/i.test(row)) {
        errors.push(`ledger row for "${gate.ledgerKey}" missing successor-stage referencing Stage Y`)
      }
      if (!row.includes(TRACKING_LINK_REQUIRED)) {
        errors.push(
          `ledger row for "${gate.ledgerKey}" missing tracking-link to "${TRACKING_LINK_REQUIRED}"`,
        )
      }
    }
  }

  // (b) Chain composition retirement
  const pkgAbs = path.join(root, 'package.json')
  if (!fs.existsSync(pkgAbs)) {
    errors.push('package.json missing')
  } else {
    const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf8'))
    const scripts = pkg.scripts || {}

    // Direct invocation sweep across every verify:* script body and any
    // script body they transitively `npm run` (we resolve one level by
    // expanding `npm run <name>` references, then re-checking).
    const expanded = expandScripts(scripts, VERIFY_SCRIPT_NAMES)
    for (const { name, body } of expanded) {
      for (const forbidden of FORBIDDEN_DIRECT_INVOCATIONS) {
        const literal = `node ${forbidden}`
        if (body.includes(literal)) {
          errors.push(
            `package.json scripts.${name} (or a script it transitively runs) still invokes "${literal}" — retire it per ledger`,
          )
        }
      }
    }

    // The legacy `.test.cjs` files must not be present (would re-enter
    // `scripts/__tests__/*.test.cjs` wildcards picked up by
    // test:r:gates / test:s:gates / test:t:gates).
    for (const gate of RETIRED_SUBGATES) {
      if (gate.legacyTestPath === null || gate.deferredTestPath === null) continue
      const legacyAbs = path.join(root, gate.legacyTestPath)
      if (fs.existsSync(legacyAbs)) {
        errors.push(
          `legacy test file present: ${gate.legacyTestPath} — must remain renamed to ${gate.deferredTestPath} until Stage Y revives it`,
        )
      }
      const deferredAbs = path.join(root, gate.deferredTestPath)
      if (!fs.existsSync(deferredAbs)) {
        errors.push(
          `deferred test file missing: ${gate.deferredTestPath} — retirement record must be preserved on disk`,
        )
      }
    }

    // Defensive: test:k:gates must not list the sqlite skip-pattern test
    // explicitly (orthogonal to the wildcard sweep above; this is the one
    // place X1 directly listed the file).
    const testKGates = scripts['test:k:gates'] || ''
    if (testKGates.includes('check-sqlite-test-skip-pattern.test.cjs')) {
      errors.push(
        'package.json scripts["test:k:gates"] still lists check-sqlite-test-skip-pattern.test.cjs explicitly — remove it per ledger',
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

function findLedgerRow(ledger, needle) {
  // Markdown table rows are single lines starting with `|`. Find the first
  // such line containing the needle.
  for (const line of ledger.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    if (line.includes(needle)) return line
  }
  return null
}

function expandScripts(scripts, seedNames) {
  // BFS over `npm run <name>` references. Output the full unfurled body
  // text per seed script (concatenated). We don't try to parse shell
  // semantics — we only need substring containment for the gate.
  const out = []
  for (const seed of seedNames) {
    const body = scripts[seed]
    if (!body) continue
    const seen = new Set([seed])
    let frontier = [seed]
    let unfurled = body
    while (frontier.length) {
      const next = []
      for (const cur of frontier) {
        const curBody = scripts[cur] || ''
        const re = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g
        let m
        while ((m = re.exec(curBody))) {
          const ref = m[1]
          if (seen.has(ref)) continue
          if (!scripts[ref]) continue
          seen.add(ref)
          next.push(ref)
          unfurled += '\n' + scripts[ref]
        }
      }
      frontier = next
    }
    out.push({ name: seed, body: unfurled })
  }
  return out
}

if (require.main === module) {
  const result = main()
  if (result.ok) {
    console.log('[check-stage-x-known-regressions] OK')
    process.exit(0)
  }
  console.error('[check-stage-x-known-regressions] FAIL:')
  for (const e of result.errors) console.error('  - ' + e)
  process.exit(1)
}

module.exports = { main, _internals: { findLedgerRow, expandScripts } }
