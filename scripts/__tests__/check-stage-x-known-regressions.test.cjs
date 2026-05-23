/**
 * Stage X1.8 — meta-test for check-stage-x-known-regressions.cjs.
 *
 * Covers:
 *   1. Happy path: real repo passes.
 *   2. Ledger breakage: drop a row → must fail.
 *   3. Chain re-entry: add a retired sub-gate back into a verify:* script
 *      body → must fail.
 *   4. Legacy test file re-introduction: must fail.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { main } = require('../check-stage-x-known-regressions.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const LEDGER_REL = 'docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md'

test('happy path: real repo passes the X1.8 regression-retirement gate', () => {
  const result = main({ root: REPO_ROOT })
  assert.equal(result.ok, true, `errors:\n  - ${result.errors.join('\n  - ')}`)
})

// Note: the X1.8 retirement of `check-stage-r-verify-switch` AND
// `check-stage-t-verify-switch` was reverted at Stage Y0.1.2 via
// path-(a-rewrite) (both gates rewritten to current flat CLAUDE.md/
// AGENTS.md §8 plan-file-link structure; R's `.deferred.cjs` renamed
// back to `.test.cjs` and direct invocation restored in `verify:s`;
// T's direct invocation restored in `verify:t`). The X1.8
// "ledger row removal must fail" + "chain re-entry must fail" +
// "legacy .test.cjs re-introduction must fail" tests have been
// removed for the R/T pair because both gates are now legitimately
// back in their verify chains and R's `.test.cjs` is intentionally
// restored. See `docs/superpowers/audits/2026-05-23-stage-y-closeout/
// y0-1-2-stage-r-t-charter-decision.md` for the disposition record.

// Note: the X1.8 retirement of `check-sqlite-test-skip-pattern` was reverted
// at Stage Y0.1.1 via path-(a) fix (16 test files gained the
// skipIfSqliteUnavailable helper; 2 stale c4Exempt rows removed; gate
// re-armed in verify:k). The X1.8 "transitive verify:k chain re-entry must
// fail" + "legacy .test.cjs re-introduction must fail" tests have been
// removed because the gate is now legitimately back in verify:k and its
// .test.cjs file is intentionally restored. See
// `docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report.md`
// §Rows[0] for the disposition record.

// (legacy .test.cjs re-introduction test for stage-r-verify-switch was
// removed at Stage Y0.1.5 — see Y0.1.2 disposition above. The `.test.cjs`
// file is now intentionally present on disk per the re-arm action.)

// Note: the X1.8 retirement of `check-testing-conventions-doc` was
// reverted at Stage Y0.1.3 via path-(a) rewrite (gate rewritten with
// content-level + CLAUDE/AGENTS sync enforcement, restored to verify:f).
// The corresponding "must fail when re-added" test from X1.8 has been
// removed because the gate is now legitimately back in verify:f. See
// `docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report.md`
// §Rows[2] for the disposition record.

// Note: the X1.8 "test:k:gates explicit listing of sqlite test must fail"
// invariant was reverted at Stage Y0.1.1 via path-(a) re-arm; the explicit
// listing is now REQUIRED (the gate is back in verify:k via test:k:gates).
// The corresponding "must fail when re-listed" test has been removed. See
// `docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report.md`
// §Rows[0] for the disposition record.

// --- helpers -----------------------------------------------------------------

function mkFakeRoot() {
  // Mirror the minimum set of files the gate inspects: package.json,
  // ledger, deferred + legacy test path markers.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-x-known-regressions-'))
  copyFile(REPO_ROOT, tmp, 'package.json')
  copyFile(REPO_ROOT, tmp, LEDGER_REL)
  // Ensure the deferred markers exist in the fake root (so the "deferred
  // file missing" guard doesn't trip in tests that don't touch them). Only
  // sub-gates still listed in RETIRED_SUBGATES need this; the sqlite gate's
  // deferred marker was removed at Stage Y0.1.1 (path-(a) re-arm).
  ensureFile(
    path.join(tmp, 'scripts/__tests__/check-stage-r-verify-switch.deferred.cjs'),
    '// fixture\n',
  )
  return tmp
}

function rmFakeRoot(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function copyFile(srcRoot, dstRoot, rel) {
  const src = path.join(srcRoot, rel)
  const dst = path.join(dstRoot, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

function ensureFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  if (!fs.existsSync(absPath)) fs.writeFileSync(absPath, content, 'utf8')
}
