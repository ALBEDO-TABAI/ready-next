'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const identity = require('../release-package-identity.cjs')
const { buildWithSourceIdentity } = require('../build-with-source-identity.cjs')
const hook = require('../write-release-receipt.cjs').default

test('release build and artifact owners are wired into the production commands', () => {
  const root = path.resolve(__dirname, '../..')
  assert.match(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts['build:dist'], /node scripts\/build-with-source-identity\.cjs && electron-builder/)
  assert.match(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'), /^afterAllArtifactBuild: scripts\/write-release-receipt\.cjs$/m)
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-release-receipt-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'ready@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Ready'], { cwd: root })
  const write = (name, content) => {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    return target
  }
  write('package.json', '{"version":"1.0.0"}')
  write('source.js', 'original source')
  write('assets/codex-runtime/runtime-manifest.json', '{"runtime":"fixture"}')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' })
  const compile = () => {
    for (const file of ['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html']) {
      write(file, 'compiled from original source')
    }
  }
  const dmg = write('exports/Ready-1.0.0-arm64.dmg', 'dmg-bytes')
  return { root, write, compile, dmg }
}

test('build captures source before compilation; artifact hook consumes that identity', (t) => {
  const f = fixture(t)
  buildWithSourceIdentity(f.root, f.compile)
  f.write('exports/clean-package-manifest.json', '{"stale":true}')
  hook({ artifactPaths: [f.dmg, path.join(f.root, 'latest-mac.yml')] }, f.root)
  const receipt = identity.readVerifiedReleasePackageReceipt(f.dmg)
  assert.equal(receipt.buildIdentity.source.digest, identity.buildReleaseSourceManifest(f.root).digest)
  assert.equal(receipt.buildIdentity.source.dirty, false, 'generated output is not source dirtiness')
  assert.equal(receipt.cleanPackageManifest, null)
  assert.equal(Object.hasOwn(receipt, 'source'), false, 'the receipt does not create a second source authority')
  assert.match(receipt.buildIdentity.outputDigest, /^[0-9a-f]{64}$/)
})

for (const kind of ['modified', 'staged', 'untracked', 'deleted']) {
  test(`build truthfully records ${kind} source without pretending HEAD alone describes it`, (t) => {
    const f = fixture(t)
    if (kind === 'deleted') fs.unlinkSync(path.join(f.root, 'source.js'))
    else f.write(kind === 'untracked' ? 'new-source.js' : 'source.js', 'changed source')
    if (kind === 'staged') execFileSync('git', ['add', 'source.js'], { cwd: f.root })
    const build = buildWithSourceIdentity(f.root, f.compile)
    assert.equal(build.source.dirty, true)
    identity.writeReleasePackageReceipt(f.dmg, { root: f.root })
    assert.deepEqual(identity.readVerifiedReleasePackageReceipt(f.dmg).buildIdentity, build)
  })
}

test('source changed during compilation cannot acquire a successful build identity', (t) => {
  const f = fixture(t)
  assert.throws(() => buildWithSourceIdentity(f.root, () => {
    f.compile()
    f.write('source.js', 'later source')
  }), /source changed/)
  assert.throws(() => identity.writeReleasePackageReceipt(f.dmg, { root: f.root }), /build identity/)
})

test('source or compiled output changed after build cannot be receipted', (t) => {
  const f = fixture(t)
  buildWithSourceIdentity(f.root, f.compile)
  f.write('source.js', 'later source')
  assert.throws(() => identity.writeReleasePackageReceipt(f.dmg, { root: f.root }), /source changed/)
  f.write('source.js', 'original source')
  f.write('out/main/index.js', 'different compilation')
  assert.throws(() => identity.writeReleasePackageReceipt(f.dmg, { root: f.root }), /output changed/)
})

test('a failed rebuild removes the previous build identity', (t) => {
  const f = fixture(t)
  buildWithSourceIdentity(f.root, f.compile)
  assert.throws(() => buildWithSourceIdentity(f.root, () => { throw new Error('compile failed') }), /compile failed/)
  assert.throws(() => identity.writeReleasePackageReceipt(f.dmg, { root: f.root }), /build identity/)
})

test('Packer forwards the original source identity even if the checkout changes later', (t) => {
  const f = fixture(t)
  buildWithSourceIdentity(f.root, f.compile)
  identity.writeReleasePackageReceipt(f.dmg, { root: f.root })
  const original = identity.readVerifiedReleasePackageReceipt(f.dmg)
  f.write('source.js', 'next work in progress')
  const copy = f.write('exports/renamed.dmg', fs.readFileSync(f.dmg))
  identity.forwardReleasePackageReceipt(f.dmg, copy)
  assert.deepEqual(identity.readVerifiedReleasePackageReceipt(copy), { ...original, artifact: 'renamed.dmg' })
})

test('installed acceptance rejects missing, old, or contradictory receipts', (t) => {
  const f = fixture(t)
  assert.throws(() => identity.readVerifiedReleasePackageReceipt(f.dmg), /receipt/)
  buildWithSourceIdentity(f.root, f.compile)
  identity.writeReleasePackageReceipt(f.dmg, { root: f.root })
  const receipt = identity.readVerifiedReleasePackageReceipt(f.dmg)
  f.write('exports/Ready-1.0.0-arm64.dmg', 'another package')
  assert.throws(() => identity.readVerifiedReleasePackageReceipt(f.dmg), /digest/)
  f.write('exports/Ready-1.0.0-arm64.dmg', 'dmg-bytes')
  f.write('exports/Ready-1.0.0-arm64.dmg.receipt.json', JSON.stringify({
    ...receipt, buildIdentity: { ...receipt.buildIdentity, source: { ...receipt.buildIdentity.source, digest: 'f'.repeat(64) } },
  }))
  assert.throws(() => identity.assertPackagedReleaseBuildIdentity(
    identity.readVerifiedReleasePackageReceipt(f.dmg), receipt.buildIdentity,
    receipt.buildIdentity.source.runtimeManifestDigest,
  ), /build identity/)
})

test('full package refresh requires its manifest and retains the original build identity', (t) => {
  const f = fixture(t)
  buildWithSourceIdentity(f.root, f.compile)
  const cleanPackageManifestPath = path.join(f.root, 'exports/clean-package-manifest.json')
  assert.throws(() => identity.writeReleasePackageReceipt(f.dmg, { root: f.root, cleanPackageManifestPath }), /ENOENT/)
  identity.writeReleasePackageReceipt(f.dmg, { root: f.root })
  const first = identity.readVerifiedReleasePackageReceipt(f.dmg)
  f.write('exports/Ready-1.0.0-arm64.dmg', 'final reconstructed package')
  f.write('exports/clean-package-manifest.json', '{"verified":true}')
  identity.writeReleasePackageReceipt(f.dmg, { root: f.root, cleanPackageManifestPath })
  const final = identity.readVerifiedReleasePackageReceipt(f.dmg)
  assert.notEqual(final.dmgSha256, first.dmgSha256)
  assert.deepEqual(final.buildIdentity, first.buildIdentity)
  assert.deepEqual(final.cleanPackageManifest, { verified: true })
})
