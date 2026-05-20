const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const test = require('node:test')

const { checkVerifyNativeTrigger } = require('../check-verify-native-trigger.cjs')

const CI = { CI: 'true' }

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ready-verify-native-trigger-'))
  const run = (...a) => execFileSync('git', a, { cwd: root })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'gate@example.com')
  run('config', 'user.name', 'Gate Bot')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }))
  run('add', '.')
  run('commit', '-q', '-m', 'seed')
  mkdirSync(join(root, 'test-results'), { recursive: true })
  return root
}

function head(root) {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function writeArtifact(root, ageMs) {
  const sha = head(root)
  const p = join(root, 'test-results', `verify-native-${sha}.json`)
  writeFileSync(p, JSON.stringify({ ok: true }))
  const t = new Date(Date.now() - ageMs)
  utimesSync(p, t, t)
  return p
}

function withRepo(fn) {
  const root = makeRepo()
  try { fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('case 1: diff without trigger files -> ok (no verify required)', () => {
  withRepo((root) => {
    const r = checkVerifyNativeTrigger({ cwd: root, env: CI, filesOverride: ['src/renderer/App.tsx', 'docs/foo.md'] })
    assert.equal(r.ok, true)
    assert.equal(r.triggered, false)
  })
})

test('case 2: trigger file + READY_VERIFY_NATIVE_OK=1 -> ok', () => {
  withRepo((root) => {
    const r = checkVerifyNativeTrigger({
      cwd: root,
      env: { ...CI, READY_VERIFY_NATIVE_OK: '1' },
      filesOverride: ['src/main/modules/database.ts'],
    })
    assert.equal(r.ok, true)
    assert.equal(r.triggered, true)
    assert.match(r.notes.join('\n'), /READY_VERIFY_NATIVE_OK/)
  })
})

test('case 3: trigger file + no evidence -> fail with actionable error', () => {
  withRepo((root) => {
    const r = checkVerifyNativeTrigger({
      cwd: root,
      env: CI,
      filesOverride: ['src/main/modules/repositories/foo.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.triggered, true)
    assert.ok(r.missing.length > 0)
    assert.match(r.missing.join('\n'), /READY_VERIFY_NATIVE_OK/)
    assert.match(r.missing.join('\n'), /verify-native-/)
  })
})

test('case 4: trigger file + fresh artifact at current sha -> ok', () => {
  withRepo((root) => {
    writeArtifact(root, 0)
    const r = checkVerifyNativeTrigger({
      cwd: root,
      env: CI,
      filesOverride: ['src/main/modules/migrations.ts'],
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.match(r.notes.join('\n'), /verify-native-/)
  })
})

test('case 5: trigger file + stale artifact (>24h) -> fail', () => {
  withRepo((root) => {
    writeArtifact(root, 25 * 60 * 60 * 1000)
    const r = checkVerifyNativeTrigger({
      cwd: root,
      env: CI,
      filesOverride: ['src/main/modules/settings-engine/runtime.ts'],
    })
    assert.equal(r.ok, false)
    assert.match(r.missing.join('\n'), /stale artifact/)
  })
})

test('bonus: non-CI defaults quiet even when triggered', () => {
  withRepo((root) => {
    const r = checkVerifyNativeTrigger({ cwd: root, env: {}, filesOverride: ['src/main/modules/database.ts'] })
    assert.equal(r.ok, true)
    assert.equal(r.triggered, true)
    assert.match(r.notes.join('\n'), /non-CI/)
  })
})
