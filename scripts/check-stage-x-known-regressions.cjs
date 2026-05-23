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
  // `check-sqlite-test-skip-pattern` was dispositioned by Stage Y0.1.1 via
  // path-(a) fix (16 missing_helper test files now import + call
  // skipIfSqliteUnavailable; 2 stale c4Exempt rows removed; deferred test
  // renamed back to .test.cjs and direct invocation re-armed in verify:k).
  // Per Y plan §6.5 "Row went green via path (a)" rule, the row is removed
  // from this list — the live gate in verify:k is the proof. Historical
  // ledger row in
  // docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md
  // remains for provenance; new Y0.1.1 disposition row lives in the Stage Y
  // closeout bundle.
  // `check-stage-r-verify-switch` was dispositioned by Stage Y0.1.2 via
  // path-(a-rewrite) + re-arm (gate rewritten to current flat CLAUDE.md/
  // AGENTS.md §8 plan-file-link structure; .deferred.cjs renamed back to
  // .test.cjs; direct invocation restored in verify:s). Per Y plan §6.5
  // "Row went via path (a) rewrite" rule, the row is removed from this list —
  // the live gate in verify:s is the proof. Historical ledger row in
  // docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md
  // remains for provenance; new Y0.1.2 disposition row lives in the Stage Y
  // closeout bundle.
  // `check-stage-t-verify-switch` was dispositioned by Stage Y0.1.2 via the
  // same path-(a-rewrite) + re-arm pattern as R (gate rewritten; direct
  // invocation restored in verify:t; T never had a .deferred.cjs file per
  // X1.8 ledger row 2 — retired via direct-invocation removal only).
  // `check-testing-conventions-doc` was dispositioned by Stage Y0.1.3 via
  // path-(a) rewrite + re-arm (gate rewritten with content-level + CLAUDE/AGENTS
  // sync enforcement, restored to verify:f). Per Y plan §6.5 "Row went via
  // path (a) rewrite" rule, the row is removed from this list — the rewritten
  // gate is the live proof. Historical ledger row in
  // docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md
  // remains for provenance; new Y0.1.3 disposition row lives in the Stage Y
  // closeout bundle.
  // `check-research-adapter-registered-in-host` was dispositioned by Stage
  // Y0.1.4 via path-(a-reorder) + re-arm in verify:r (per Y plan §6.4,
  // overlap-fixture-first investigation classified the conflict as APPARENT;
  // ResearchDomainAdapter swapped to the first position in
  // `src/main/modules/claude-bridge/direct-chat.ts` domainAdapters[];
  // overlap fixtures at `src/__tests__/research-vs-map-overlap-fixtures.test.ts`
  // prove the swap is behaviorally equivalent for the 4 representative
  // queries). Per Y plan §6.5 "Row went green via path (a)" rule, the row is
  // removed from this list — the live gate in verify:r is the proof.
  // Historical ledger row in
  // docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md
  // remains for provenance; new Y0.1.4 disposition row lives in the Stage Y
  // closeout bundle.
]

// Direct package.json verify:* script bodies (not test wildcards) must
// not reference these literal `node scripts/<name>.cjs` invocations.
const FORBIDDEN_DIRECT_INVOCATIONS = [
  // `scripts/check-sqlite-test-skip-pattern.cjs` removed at Stage Y0.1.1 —
  // path-(a) fix re-armed it in verify:k (16 test files now carry the
  // skipIfSqliteUnavailable helper; 2 stale c4Exempt rows removed).
  // `scripts/check-stage-r-verify-switch.cjs` removed at Stage Y0.1.2 —
  // path-(a-rewrite) re-armed it in verify:s.
  // `scripts/check-stage-t-verify-switch.cjs` removed at Stage Y0.1.2 —
  // path-(a-rewrite) re-armed it in verify:t.
  // `scripts/check-testing-conventions-doc.cjs` removed at Stage Y0.1.3 —
  // path-(a) rewrite re-armed it in verify:f.
  // `scripts/check-research-adapter-registered-in-host.cjs` removed at
  // Stage Y0.1.4 — path-(a-reorder) re-armed it in verify:r.
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

    // Stage Y0.1.1 disposition: test:k:gates listing
    // `check-sqlite-test-skip-pattern.test.cjs` explicitly is REQUIRED now
    // that path-(a) fix re-armed the gate. The previous defensive sweep is
    // removed (Y plan §6.5: row removal upon path-(a) re-arm).
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
