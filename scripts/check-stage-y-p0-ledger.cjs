#!/usr/bin/env node
/**
 * Stage Y P0 ledger gate.
 *
 * Implements the machine-checkable side of plan §3.3 exit criteria:
 *
 *   §0.2 every P0 row in §3.1 is either marked `green` with an evidence
 *        path OR appears in `deferred-work-ledger.md` with bucket ∈
 *        {`Stage Z release-candidate`, `blocked-external`}.
 *   §0.3 dogfood matrix 20/20 (cross-validated here against the
 *        `dogfood/` directory file count; the per-file lint is in the
 *        sibling `check-stage-y-dogfood-evidence.cjs`).
 *   §0.7 Y0.7 + Y0.8 are non-deferrable per §3.2 carve-out — the gate
 *        MUST reject if either is marked `deferred-with-owner` /
 *        appears in the ledger at all.
 *
 * Each P0 row in plan §3.1 (Y0.0 through Y0.8 — 9 rows) is enumerated
 * below with an evidence-discovery rule. The gate is exit-criteria-only;
 * it is NOT wired into `verify`, `verify:cloud`, or the CI merge-job
 * step list per plan §5 explicit instruction.
 *
 * Initial state (Y0.0): the ledger is empty by design and most rows
 * have no evidence yet, so this gate is EXPECTED to exit non-zero
 * at Y0.0 with an informative message. It must run without crashing
 * on the empty scaffold.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const STAGE_Y_CLOSEOUT_DIR_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout'
const LEDGER_REL = `${STAGE_Y_CLOSEOUT_DIR_REL}/deferred-work-ledger.md`
const DOGFOOD_DIR_REL = `${STAGE_Y_CLOSEOUT_DIR_REL}/dogfood`
const PLAN_REL =
  'docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md'

// Allowed buckets for §3.2 deferral (P0 rows other than Y0.7/Y0.8).
// Per plan §10.2 step 3 the ledger schema also permits
// `debt-warning-burn` and `retired-with-reason`, but those are NOT
// valid for the §3.2 P0-deferral path — they are only for non-P0
// rows. The §3.2 P0-deferral path admits exactly the two buckets
// below.
const ALLOWED_P0_DEFERRAL_BUCKETS = new Set([
  'Stage Z release-candidate',
  'blocked-external',
])

// Plan §3.1 row enumeration. Each row defines:
//   id           — P0 row ID matching plan §3.1.
//   ledger_key   — substring that must appear in the ledger row if
//                  this P0 is deferred (or "" if no canonical key —
//                  see Y0.0/Y0.5 which have intrinsically-green
//                  acceptance via materialization, not deferral).
//   evidence     — path (relative to repo root) whose existence
//                  counts as green-evidence per plan §3.3.
//   nondeferrable — true iff this row is in the §3.2 carve-out
//                   (Y0.7 + Y0.8 only); if true, ANY ledger entry
//                   matching `ledger_key` is rejected.
//   green_rule   — function (state) => { green: bool, why: string }
//                  consulted before falling back to the ledger.
const P0_ROWS = [
  {
    id: 'Y0.0',
    ledger_key: 'Y0.0 closeout scaffold',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/README.md`,
    nondeferrable: false,
    green_rule: (state) => {
      // Y0.0 is green when the §5 8-deliverable scaffold + 2 lint
      // scripts + package.json wiring exist. We assert the 8
      // deliverables here; the 2 scripts assert themselves by
      // running (this is one of them).
      const required = [
        `${STAGE_Y_CLOSEOUT_DIR_REL}/README.md`,
        `${STAGE_Y_CLOSEOUT_DIR_REL}/y0-entry-truth.md`,
        `${STAGE_Y_CLOSEOUT_DIR_REL}/verification-entry`,
        `${STAGE_Y_CLOSEOUT_DIR_REL}/deferred-work-ledger.md`,
        `${STAGE_Y_CLOSEOUT_DIR_REL}/dogfood`,
        `${STAGE_Y_CLOSEOUT_DIR_REL}/ci-report.md`,
        `${STAGE_Y_CLOSEOUT_DIR_REL}/release-handoff.md`,
        `${STAGE_Y_CLOSEOUT_DIR_REL}/verification-matrix.md`,
      ]
      const missing = required.filter(
        (rel) => !fs.existsSync(path.join(state.root, rel)),
      )
      if (missing.length) {
        return {
          green: false,
          why: `Y0.0 §5 deliverables missing: ${missing.join(', ')}`,
        }
      }
      return { green: true, why: '8 §5 deliverables present' }
    },
  },
  {
    id: 'Y0.1',
    ledger_key: 'check-stage-y-known-regressions',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/y0-1-disposition-report.md`,
    nondeferrable: false,
    green_rule: (state) => {
      // Per plan §6.5 + §3.3 §0.4: Y0.1 green requires (a)
      // disposition report file present, (b) successor gate
      // `scripts/check-stage-y-known-regressions.cjs` exists.
      const reportRel = `${STAGE_Y_CLOSEOUT_DIR_REL}/y0-1-disposition-report.md`
      const successorGateRel = 'scripts/check-stage-y-known-regressions.cjs'
      const reportExists = fs.existsSync(path.join(state.root, reportRel))
      const successorExists = fs.existsSync(
        path.join(state.root, successorGateRel),
      )
      if (!reportExists || !successorExists) {
        return {
          green: false,
          why:
            'Y0.1 green requires both ' +
            reportRel +
            ' and ' +
            successorGateRel +
            ' to exist',
        }
      }
      return { green: true, why: 'disposition report + successor gate present' }
    },
  },
  {
    id: 'Y0.2',
    ledger_key: 'Y0.2 CI',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/ci-report.md`,
    nondeferrable: false,
    green_rule: (state) => {
      // Per plan §3.3 §0.5 the CI report must contain a real
      // https://github.com/.../actions/runs/<id> URL in §3.
      const ciAbs = path.join(state.root, `${STAGE_Y_CLOSEOUT_DIR_REL}/ci-report.md`)
      if (!fs.existsSync(ciAbs)) {
        return { green: false, why: 'ci-report.md missing' }
      }
      const text = fs.readFileSync(ciAbs, 'utf8')
      const runUrlRe = /https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/
      if (!runUrlRe.test(text)) {
        return {
          green: false,
          why: 'ci-report.md §3 missing a real GitHub run URL (https://github.com/.../actions/runs/<id>)',
        }
      }
      return { green: true, why: 'ci-report.md contains a GitHub run URL' }
    },
  },
  {
    id: 'Y0.3',
    ledger_key: 'w5-item-03-live-rerun',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/dogfood/w5-item-03-live-rerun.md`,
    nondeferrable: false,
    green_rule: (state) => {
      const rel = `${STAGE_Y_CLOSEOUT_DIR_REL}/dogfood/w5-item-03-live-rerun.md`
      if (!fs.existsSync(path.join(state.root, rel))) {
        return { green: false, why: `Y0.3 evidence missing: ${rel}` }
      }
      return { green: true, why: 'w5-item-03 live evidence present' }
    },
  },
  {
    id: 'Y0.4',
    ledger_key: 'workbench-shell-live',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/dogfood/workbench-shell-live.md`,
    nondeferrable: false,
    green_rule: (state) => {
      const rel = `${STAGE_Y_CLOSEOUT_DIR_REL}/dogfood/workbench-shell-live.md`
      if (!fs.existsSync(path.join(state.root, rel))) {
        return { green: false, why: `Y0.4 evidence missing: ${rel}` }
      }
      return { green: true, why: 'workbench-shell live evidence present' }
    },
  },
  {
    id: 'Y0.5',
    ledger_key: 'Y0.5 dogfood',
    evidence: DOGFOOD_DIR_REL,
    nondeferrable: false,
    green_rule: (state) => {
      // Per plan §3.3 §0.3: ls .../dogfood/ returns ≥ 20 files
      // (one per §9.1 surface). At Y0.0 the directory has only the
      // .gitkeep placeholder; this rule yields green only at the
      // 20-file state.
      const dirAbs = path.join(state.root, DOGFOOD_DIR_REL)
      if (!fs.existsSync(dirAbs)) {
        return { green: false, why: `${DOGFOOD_DIR_REL}/ missing` }
      }
      const files = fs
        .readdirSync(dirAbs)
        .filter((name) => name.endsWith('.md'))
        .filter((name) => name !== 'REPORT.md')
      if (files.length < 20) {
        return {
          green: false,
          why: `${DOGFOOD_DIR_REL}/ has ${files.length} surface file(s); plan §9.1 requires 20`,
        }
      }
      return { green: true, why: `${files.length} surface files present` }
    },
  },
  {
    id: 'Y0.6',
    ledger_key: 'Y0.6 release-handoff',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/release-handoff.md`,
    nondeferrable: false,
    green_rule: (state) => {
      // Per plan §10.3: release-handoff.md must have sections 1-5
      // populated (not just scaffold). We assert "pending" markers
      // are absent in each section header block.
      const rel = `${STAGE_Y_CLOSEOUT_DIR_REL}/release-handoff.md`
      const abs = path.join(state.root, rel)
      if (!fs.existsSync(abs)) {
        return { green: false, why: `${rel} missing` }
      }
      const text = fs.readFileSync(abs, 'utf8')
      // Crude population check: status frontmatter must NOT say
      // "scaffold" and the body must not still say "_(pending)_".
      const isScaffold = /^status:\s*scaffold/m.test(text)
      const pendingCount = (text.match(/_\(pending[^)]*\)_/g) || []).length
      if (isScaffold || pendingCount > 0) {
        return {
          green: false,
          why: `${rel} still has status: scaffold or ${pendingCount} _(pending)_ markers`,
        }
      }
      return { green: true, why: 'release-handoff.md populated' }
    },
  },
  {
    id: 'Y0.7',
    ledger_key: 'Y0.7',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/release-handoff.md`,
    nondeferrable: true, // §3.2 carve-out + §3.3 §0.7
    green_rule: (state) => {
      // Per plan §11.0b: Y0.7 green when either (a) MCP transport
      // proven end-to-end, OR (b) UI labeling "not shipped" landed.
      // Both branches MUST be documented in `release-handoff.md`
      // §5 "Stage Z MCP carry-over" row.
      const rel = `${STAGE_Y_CLOSEOUT_DIR_REL}/release-handoff.md`
      const abs = path.join(state.root, rel)
      if (!fs.existsSync(abs)) {
        return { green: false, why: `${rel} missing` }
      }
      const text = fs.readFileSync(abs, 'utf8')
      if (!/MCP\s+(transport|carry-over|not\s+shipped|labeling)/i.test(text)) {
        return {
          green: false,
          why: `${rel} missing Y0.7 MCP transport/labeling decision row`,
        }
      }
      // The scaffold mentions both terms in section 5's prose
      // template; require the section to be populated past scaffold
      // state by checking the file's overall scaffold flag.
      if (/^status:\s*scaffold/m.test(text)) {
        return {
          green: false,
          why: `${rel} status: scaffold — Y0.7 decision not yet recorded`,
        }
      }
      return { green: true, why: 'Y0.7 MCP decision recorded' }
    },
  },
  {
    id: 'Y0.8',
    ledger_key: 'Y0.8',
    evidence: `${STAGE_Y_CLOSEOUT_DIR_REL}/release-handoff.md`,
    nondeferrable: true, // §3.2 carve-out + §3.3 §0.7
    green_rule: (state) => {
      const rel = `${STAGE_Y_CLOSEOUT_DIR_REL}/release-handoff.md`
      const abs = path.join(state.root, rel)
      if (!fs.existsSync(abs)) {
        return { green: false, why: `${rel} missing` }
      }
      const text = fs.readFileSync(abs, 'utf8')
      if (
        !/cache\s*quota|cache-quota|configured\s+limit,?\s*not\s+enforced/i.test(
          text,
        )
      ) {
        return {
          green: false,
          why: `${rel} missing Y0.8 cache-quota enforcement/relabel decision row`,
        }
      }
      if (/^status:\s*scaffold/m.test(text)) {
        return {
          green: false,
          why: `${rel} status: scaffold — Y0.8 decision not yet recorded`,
        }
      }
      return { green: true, why: 'Y0.8 cache-quota decision recorded' }
    },
  },
]

function parseLedgerRows(ledgerText) {
  // The ledger schema has 6 columns: item | source-stage | reason |
  // successor-stage | tracking-link | bucket. Each markdown table
  // row starts with `|` and has at least 6 `|` separators (header
  // separator rows like `|---|---|` are filtered out).
  const rows = []
  for (const line of ledgerText.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    if (/^\|\s*-+/.test(line.trim())) continue
    // Header row contains the literal `item` column name.
    if (/\|\s*item\s*\|/i.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 6) continue
    rows.push({
      raw: line,
      item: cells[0],
      source_stage: cells[1],
      reason: cells[2],
      successor_stage: cells[3],
      tracking_link: cells[4],
      bucket: cells[5],
    })
  }
  return rows
}

function main({ root = ROOT } = {}) {
  const state = { root }
  const errors = []
  const notes = []

  // Plan existence sanity check (helps catch a rename of the plan
  // file before anyone investigates this gate's failure).
  if (!fs.existsSync(path.join(root, PLAN_REL))) {
    errors.push(`plan missing: ${PLAN_REL}`)
  }

  // Ledger may legitimately be empty at Y0.0; do not require its
  // existence for the gate to run, but warn if missing entirely.
  const ledgerAbs = path.join(root, LEDGER_REL)
  let ledgerRows = []
  if (!fs.existsSync(ledgerAbs)) {
    errors.push(`ledger missing: ${LEDGER_REL}`)
  } else {
    const ledgerText = fs.readFileSync(ledgerAbs, 'utf8')
    ledgerRows = parseLedgerRows(ledgerText)
  }

  // Per-row evaluation: green_rule first, then ledger fallback.
  for (const row of P0_ROWS) {
    const rule = row.green_rule(state)
    if (rule.green) {
      notes.push(`${row.id} green: ${rule.why}`)
      // Even if green, §0.7 forbids Y0.7/Y0.8 from being marked
      // deferred in the ledger; we still apply that check.
      if (row.nondeferrable) {
        const conflict = ledgerRows.find((lr) =>
          lr.item.includes(row.ledger_key),
        )
        if (conflict) {
          errors.push(
            `§3.2 carve-out violation: ${row.id} is non-deferrable but ledger row found: "${conflict.item}"`,
          )
        }
      }
      continue
    }
    // Green rule failed — check the deferral branch.
    if (row.nondeferrable) {
      errors.push(
        `${row.id} not green (${rule.why}) AND non-deferrable per §3.2 carve-out — must reach a green path before close`,
      )
      continue
    }
    const matchingLedgerRows = ledgerRows.filter((lr) =>
      lr.item.includes(row.ledger_key),
    )
    if (matchingLedgerRows.length === 0) {
      errors.push(
        `${row.id} not green (${rule.why}) AND no deferral row found in ledger with item containing "${row.ledger_key}"`,
      )
      continue
    }
    // Validate the deferral row(s) have an allowed bucket.
    let anyValidDeferral = false
    for (const lr of matchingLedgerRows) {
      if (ALLOWED_P0_DEFERRAL_BUCKETS.has(lr.bucket)) {
        anyValidDeferral = true
        notes.push(
          `${row.id} deferred via ledger: bucket="${lr.bucket}" successor="${lr.successor_stage}"`,
        )
      } else {
        errors.push(
          `${row.id} ledger row has invalid bucket "${lr.bucket}"; allowed (per §3.2): ${[...ALLOWED_P0_DEFERRAL_BUCKETS].join(', ')}`,
        )
      }
    }
    if (!anyValidDeferral) {
      errors.push(
        `${row.id} not green AND no ledger row with an allowed §3.2 bucket`,
      )
    }
  }

  return { ok: errors.length === 0, errors, notes }
}

if (require.main === module) {
  const result = main()
  if (result.ok) {
    console.log('[check-stage-y-p0-ledger] OK')
    for (const n of result.notes) console.log('  ' + n)
    process.exit(0)
  }
  console.error('[check-stage-y-p0-ledger] FAIL:')
  for (const e of result.errors) console.error('  - ' + e)
  if (result.notes.length) {
    console.error('  (informational notes:)')
    for (const n of result.notes) console.error('    ' + n)
  }
  process.exit(1)
}

module.exports = { main, P0_ROWS, ALLOWED_P0_DEFERRAL_BUCKETS, parseLedgerRows }
