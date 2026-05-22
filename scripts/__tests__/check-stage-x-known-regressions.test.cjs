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

test('ledger breakage: removing the sqlite ledger row must fail the gate', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const ledgerAbs = path.join(fakeRoot, LEDGER_REL)
    const original = fs.readFileSync(ledgerAbs, 'utf8')
    // Strip the table row containing the sqlite gate ledger key.
    const stripped = original
      .split(/\r?\n/)
      .filter((line) => !(line.startsWith('|') && line.includes('check-sqlite-test-skip-pattern')))
      .join('\n')
    fs.writeFileSync(ledgerAbs, stripped, 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('check-sqlite-test-skip-pattern')),
      `expected an error mentioning the missing sqlite gate entry; got: ${result.errors.join('; ')}`,
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

test('chain re-entry via verify:k transitive expansion: re-adding sqlite gate to verify:k must fail the gate', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const pkgAbs = path.join(fakeRoot, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf8'))
    pkg.scripts['verify:k'] =
      (pkg.scripts['verify:k'] || '') + ' && node scripts/check-sqlite-test-skip-pattern.cjs'
    fs.writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2), 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('check-sqlite-test-skip-pattern.cjs')),
      `expected an error about the re-added sqlite sub-gate; got: ${result.errors.join('; ')}`,
    )
  } finally {
    rmFakeRoot(fakeRoot)
  }
})

test('legacy .test.cjs re-introduction: recreating the file must fail the gate', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const legacy = path.join(fakeRoot, 'scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs')
    fs.writeFileSync(legacy, '// re-added legacy\n', 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('check-sqlite-test-skip-pattern.test.cjs')),
      `expected an error about the legacy test file re-introduction; got: ${result.errors.join('; ')}`,
    )
  } finally {
    rmFakeRoot(fakeRoot)
  }
})

test('chain re-entry: re-adding check-testing-conventions-doc to verify:f must fail the gate', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const pkgAbs = path.join(fakeRoot, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf8'))
    pkg.scripts['verify:f'] =
      (pkg.scripts['verify:f'] || '') + ' && node scripts/check-testing-conventions-doc.cjs'
    fs.writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2), 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('check-testing-conventions-doc.cjs')),
      `expected an error about the re-added testing-conventions-doc invocation; got: ${result.errors.join('; ')}`,
    )
  } finally {
    rmFakeRoot(fakeRoot)
  }
})

test('test:k:gates explicit listing: re-listing sqlite test file in test:k:gates must fail', () => {
  const fakeRoot = mkFakeRoot()
  try {
    const pkgAbs = path.join(fakeRoot, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgAbs, 'utf8'))
    pkg.scripts['test:k:gates'] =
      (pkg.scripts['test:k:gates'] || '') + ' scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs'
    fs.writeFileSync(pkgAbs, JSON.stringify(pkg, null, 2), 'utf8')

    const result = main({ root: fakeRoot })
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('test:k:gates')),
      `expected an error about the re-listed sqlite test in test:k:gates; got: ${result.errors.join('; ')}`,
    )
  } finally {
    rmFakeRoot(fakeRoot)
  }
})

// --- helpers -----------------------------------------------------------------

function mkFakeRoot() {
  // Mirror the minimum set of files the gate inspects: package.json,
  // ledger, deferred + legacy test path markers.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-x-known-regressions-'))
  copyFile(REPO_ROOT, tmp, 'package.json')
  copyFile(REPO_ROOT, tmp, LEDGER_REL)
  // Ensure the deferred markers exist in the fake root (so the "deferred
  // file missing" guard doesn't trip in tests that don't touch them).
  ensureFile(
    path.join(tmp, 'scripts/__tests__/check-sqlite-test-skip-pattern.deferred.cjs'),
    '// fixture\n',
  )
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
