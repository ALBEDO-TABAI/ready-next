/**
 * Stage X1.5 — behavior tests for the verify-script-paths meta-gate.
 *
 * Verifies:
 *   (a) the gate passes on the live repo (the only acceptable green for the
 *       initial X1 landing);
 *   (b) the gate FAILS when a fixture verify script cites a missing src/...
 *       path that is not in the allowlist;
 *   (c) the gate PASSES when the same missing path is added to a valid
 *       allowlist entry;
 *   (d) the loader REJECTS allowlist entries missing any of the five
 *       required fields (path, reason, owner, expiresAt, addedBy);
 *   (e) the loader REJECTS allowlist entries with expiresAt in the past;
 *   (f) the gate prints each active allowlist entry at start of run.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-verify-script-paths-current.cjs')

function makeFixture({ verifyScript, srcFiles = {}, allowlist }) {
  const root = mkdtempSync(join(tmpdir(), 'ready-meta-paths-gate-'))
  const scriptsDir = join(root, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })

  // Copy the gate + its helpers (it lives alongside other scripts and uses
  // its own __dirname for VERIFY_SCRIPTS_DIR / ALLOWLIST_PATH, so we need it
  // present inside the fixture's scripts/ directory).
  cpSync(SCRIPT, join(scriptsDir, 'check-verify-script-paths-current.cjs'))

  // Write the fixture verify script under test.
  if (verifyScript) {
    writeFileSync(join(scriptsDir, verifyScript.name), verifyScript.body)
  }

  // Write any src/ files the fixture references.
  for (const [rel, body] of Object.entries(srcFiles)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }

  // Write the allowlist (or leave absent for default empty-list behavior).
  if (allowlist !== undefined) {
    writeFileSync(
      join(scriptsDir, 'check-verify-script-paths-allowlist.json'),
      JSON.stringify(allowlist, null, 2),
    )
  }

  return { root, scriptsDir }
}

function runFixture(scriptsDir) {
  return spawnSync(
    process.execPath,
    [join(scriptsDir, 'check-verify-script-paths-current.cjs')],
    { encoding: 'utf8', cwd: scriptsDir + '/..' },
  )
}

test('positive: live repo passes the meta-gate', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
  assert.match(r.stdout, /\[check-verify-script-paths-current\] OK/)
})

test('negative: missing src/... path in a verify script fails the gate', () => {
  const { root, scriptsDir } = makeFixture({
    verifyScript: {
      name: 'check-fixture-stale.cjs',
      body: "const f = 'src/main/modules/agent-control/imaginary-removed.ts'\nconsole.log(f)\n",
    },
  })
  try {
    const r = runFixture(scriptsDir)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /STALE PATHS/)
    assert.match(r.stderr, /imaginary-removed\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: missing path passes when present in allowlist', () => {
  const { root, scriptsDir } = makeFixture({
    verifyScript: {
      name: 'check-fixture-allowed.cjs',
      body: "const f = 'src/main/modules/agent-control/fixture-only.ts'\nconsole.log(f)\n",
    },
    allowlist: {
      $schema: 'test-allowlist',
      entries: [
        {
          path: 'src/main/modules/agent-control/fixture-only.ts',
          reason: 'Intentional fixture path that is generated lazily by another gate; never live on disk.',
          owner: 'meta-gate test fixture',
          expiresAt: '2099-12-31',
          addedBy: 'X1.5 test fixture',
        },
      ],
    },
  })
  try {
    const r = runFixture(scriptsDir)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
    assert.match(r.stdout, /ALLOWLIST: src\/main\/modules\/agent-control\/fixture-only\.ts/)
    assert.match(r.stdout, /\[check-verify-script-paths-current\] OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: allowlist entry missing reason exits 2 (loader rejection)', () => {
  const { root, scriptsDir } = makeFixture({
    verifyScript: {
      name: 'check-fixture-bad-entry.cjs',
      body: "const f = 'src/main/modules/agent-control/fixture-only.ts'\nconsole.log(f)\n",
    },
    allowlist: {
      entries: [
        {
          path: 'src/main/modules/agent-control/fixture-only.ts',
          // reason intentionally omitted
          owner: 'tester',
          expiresAt: '2099-12-31',
          addedBy: 'X1.5 test fixture',
        },
      ],
    },
  })
  try {
    const r = runFixture(scriptsDir)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ALLOWLIST INVALID/)
    assert.match(r.stderr, /reason/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: allowlist entry missing addedBy exits 2 (loader rejection)', () => {
  const { root, scriptsDir } = makeFixture({
    verifyScript: {
      name: 'check-fixture-bad-entry.cjs',
      body: "const f = 'src/main/modules/agent-control/fixture-only.ts'\nconsole.log(f)\n",
    },
    allowlist: {
      entries: [
        {
          path: 'src/main/modules/agent-control/fixture-only.ts',
          reason: 'sufficient reason',
          owner: 'tester',
          expiresAt: '2099-12-31',
          // addedBy intentionally omitted
        },
      ],
    },
  })
  try {
    const r = runFixture(scriptsDir)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ALLOWLIST INVALID/)
    assert.match(r.stderr, /addedBy/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: allowlist entry with past expiresAt exits 2 (allowlist rot)', () => {
  const { root, scriptsDir } = makeFixture({
    verifyScript: {
      name: 'check-fixture-rotten.cjs',
      body: "const f = 'src/main/modules/agent-control/fixture-only.ts'\nconsole.log(f)\n",
    },
    allowlist: {
      entries: [
        {
          path: 'src/main/modules/agent-control/fixture-only.ts',
          reason: 'expired entry that should fail to load',
          owner: 'tester',
          expiresAt: '2000-01-01',
          addedBy: 'X1.5 test fixture',
        },
      ],
    },
  })
  try {
    const r = runFixture(scriptsDir)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /ALLOWLIST EXPIRED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: existing src/ path is not flagged', () => {
  const { root, scriptsDir } = makeFixture({
    verifyScript: {
      name: 'check-fixture-green.cjs',
      body: "const f = 'src/main/modules/something/exists.ts'\nconsole.log(f)\n",
    },
    srcFiles: {
      'src/main/modules/something/exists.ts': '// fixture file present on disk\n',
    },
  })
  try {
    const r = runFixture(scriptsDir)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
    assert.match(r.stdout, /\[check-verify-script-paths-current\] OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: non-source paths (no recognized extension) are ignored', () => {
  // The gate only catches paths with .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts.
  // A literal like 'src/assets/foo.svg' or 'src/foo' (no extension) is
  // intentionally not flagged because verify scripts don't typically
  // hard-code asset paths.
  const { root, scriptsDir } = makeFixture({
    verifyScript: {
      name: 'check-fixture-assets.cjs',
      body: [
        "const a = 'src/assets/nonexistent.svg'",
        "const b = 'src/some-directory'",
        "console.log(a, b)",
        '',
      ].join('\n'),
    },
  })
  try {
    const r = runFixture(scriptsDir)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
    assert.match(r.stdout, /\[check-verify-script-paths-current\] OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
