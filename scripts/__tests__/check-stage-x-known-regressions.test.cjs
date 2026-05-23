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

test('ledger breakage: removing a retired-gate ledger row must fail the gate (stage-r-verify-switch)', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const ledgerAbs = path.join(fakeRoot, LEDGER_REL)
    const original = fs.readFileSync(ledgerAbs, 'utf8')
    // Strip the table row containing the still-retired stage-r-verify-switch
    // ledger key. (The sqlite row was previously the sentinel here but Stage
    // Y0.1.1 path-(a) re-armed the sqlite gate; the live verify:k invocation
    // is now its proof, so it no longer appears in the RETIRED_SUBGATES list.)
    const stripped = original
      .split(/\r?\n/)
      .filter((line) => !(line.startsWith('|') && line.includes('check-stage-r-verify-switch')))
      .join('\n')
    fs.writeFileSync(ledgerAbs, stripped, 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('check-stage-r-verify-switch')),
      `expected an error mentioning the missing stage-r-verify-switch entry; got: ${result.errors.join('; ')}`,
    )
  } finally {
    rmFakeRoot(fakeRoot)
  }
})

test('chain re-entry: adding check-stage-r-verify-switch back into verify:r must fail the gate', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const pkgAbs = path.join(fakeRoot, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf8'))
    pkg.scripts['verify:r'] =
      (pkg.scripts['verify:r'] || '') + ' && node scripts/check-stage-r-verify-switch.cjs'
    fs.writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2), 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('check-stage-r-verify-switch.cjs')),
      `expected an error about the re-added sub-gate; got: ${result.errors.join('; ')}`,
    )
  } finally {
    rmFakeRoot(fakeRoot)
  }
})

// Note: the X1.8 retirement of `check-sqlite-test-skip-pattern` was reverted
// at Stage Y0.1.1 via path-(a) fix (16 test files gained the
// skipIfSqliteUnavailable helper; 2 stale c4Exempt rows removed; gate
// re-armed in verify:k). The X1.8 "transitive verify:k chain re-entry must
// fail" + "legacy .test.cjs re-introduction must fail" tests have been
// removed because the gate is now legitimately back in verify:k and its
// .test.cjs file is intentionally restored. See
// `docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report.md`
// §Rows[0] for the disposition record.

test('legacy .test.cjs re-introduction: recreating a still-retired test file must fail the gate (stage-r-verify-switch)', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const legacy = path.join(fakeRoot, 'scripts/__tests__/check-stage-r-verify-switch.test.cjs')
    fs.writeFileSync(legacy, '// re-added legacy\n', 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('check-stage-r-verify-switch.test.cjs')),
      `expected an error about the legacy test file re-introduction; got: ${result.errors.join('; ')}`,
    )
  } finally {
    rmFakeRoot(fakeRoot)
  }
})

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
