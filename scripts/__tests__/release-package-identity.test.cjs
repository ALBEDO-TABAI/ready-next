'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  buildReleaseSourceManifest,
  loadVerifiedStructuralReceipt,
  packagingContract,
} = require('../release-package-identity.cjs')

const fixtureRoots = []
const tempFixture = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fixtureRoots.push(root)
  return root
}
test.after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true })
})

function gitFixture() {
  const root = tempFixture('ready-release-source-id-')
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'ready@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Ready'], { cwd: root })
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}\n')
  fs.writeFileSync(path.join(root, 'source.js'), 'one\n', { mode: 0o755 })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' })
  return root
}

test('release source identity changes with executable mode and handles tracked deletion', () => {
  const root = gitFixture()
  const before = buildReleaseSourceManifest(root)
  fs.chmodSync(path.join(root, 'source.js'), 0o644)
  const modeChanged = buildReleaseSourceManifest(root)
  assert.notEqual(modeChanged.digest, before.digest)
  fs.rmSync(path.join(root, 'source.js'))
  const deleted = buildReleaseSourceManifest(root)
  assert.notEqual(deleted.digest, modeChanged.digest)
  assert.equal(deleted.files.some((file) => file.path === 'source.js'), false)
})

test('release source identity rejects broken or escaping symlinks', () => {
  const root = gitFixture()
  fs.symlinkSync('missing', path.join(root, 'broken-link'))
  assert.throws(() => buildReleaseSourceManifest(root), /symlink is not allowed/)
})

test('release source identity includes packaged database-shaped files', () => {
  const root = gitFixture()
  fs.mkdirSync(path.join(root, 'assets/embedded-skills/demo'), { recursive: true })
  fs.writeFileSync(path.join(root, 'assets/embedded-skills/demo/ready.db'), 'private-state')
  const manifest = buildReleaseSourceManifest(root)
  assert.equal(manifest.files.some((file) => file.path === 'assets/embedded-skills/demo/ready.db'), true)
})

test('packaging contract derives one exact arm64 DMG path', () => {
  const root = tempFixture('ready-release-contract-')
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n')
  fs.writeFileSync(path.join(root, 'electron-builder.yml'), [
    'productName: Ready',
    'directories:',
    '  output: exports',
    'mac:',
    '  target:',
    '    - target: dmg',
    '      arch: [arm64]',
    '  artifactName: "${productName}-${version}-${arch}.${ext}"',
    '',
  ].join('\n'))
  assert.equal(packagingContract(root).artifactRel, 'exports/Ready-1.2.3-arm64.dmg')
})

test('packaging keeps dependency runtime directories named doc', () => {
  const builder = fs.readFileSync(path.join(__dirname, '../../electron-builder.yml'), 'utf8')
  assert.doesNotMatch(builder, /!node_modules\/\*\*\/doc\/\*\*/)
})

test('packaging contract rejects multiple DMG targets', () => {
  const root = tempFixture('ready-release-contract-many-')
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n')
  fs.writeFileSync(path.join(root, 'electron-builder.yml'), [
    'productName: Ready', 'directories:', '  output: exports', 'mac:', '  target:',
    '    - target: dmg', '      arch: [arm64]', '    - target: dmg', '      arch: [x64]',
    '  artifactName: "${productName}-${version}-${arch}.${ext}"', '',
  ].join('\n'))
  assert.throws(() => packagingContract(root), /exactly one DMG target/)
})

test('packaging contract rejects package inputs outside the release source root', () => {
  const root = tempFixture('ready-release-contract-external-')
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n')
  fs.writeFileSync(path.join(root, 'electron-builder.yml'), [
    'productName: Ready', 'directories:', '  output: exports',
    'files:', '  - out/**/*', 'extraResources:', '  - from: ../external-payload', '    to: payload',
    'mac:', '  target:', '    - target: dmg', '      arch: [arm64]',
    '  artifactName: "${productName}-${version}-${arch}.${ext}"', '',
  ].join('\n'))
  assert.throws(() => packagingContract(root), /must stay inside the release source root/)
})

test('receipt loader rejects a symlinked receipt', () => {
  const root = tempFixture('ready-release-receipt-link-')
  fs.mkdirSync(path.join(root, 'exports/release-structural-receipts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'exports/Ready-1.0.0-arm64.dmg'), 'dmg')
  const sha = require('../release-package-identity.cjs').sha256File(path.join(root, 'exports/Ready-1.0.0-arm64.dmg'))
  const outside = path.join(os.tmpdir(), `ready-receipt-${Date.now()}.json`)
  fixtureRoots.push(outside)
  fs.writeFileSync(outside, '{}')
  fs.symlinkSync(outside, path.join(root, `exports/release-structural-receipts/${sha}.json`))
  const result = loadVerifiedStructuralReceipt(root, {
    sourceManifest: () => ({ digest: 'x', head: 'h', appVersion: '1.0.0' }),
    contractFactory: () => ({ appVersion: '1.0.0', arch: 'arm64', artifactRel: 'exports/Ready-1.0.0-arm64.dmg' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing or invalid structural package receipt/)
})

test('receipt loader rejects arbitrary old artifact and missing verification fields', () => {
  const root = tempFixture('ready-release-receipt-')
  fs.mkdirSync(path.join(root, 'exports'), { recursive: true })
  fs.writeFileSync(path.join(root, 'exports/old.dmg'), 'old')
  fs.writeFileSync(path.join(root, 'exports/new.dmg'), 'new')
  const sha = require('../release-package-identity.cjs').sha256File(path.join(root, 'exports/new.dmg'))
  const receiptPath = path.join(root, `exports/release-structural-receipts/${sha}.json`)
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 2,
    receiptId: '12345678-1234-1234-1234-123456789abc',
    status: 'STRUCTURAL_PACKAGE_PASS',
    liveAcceptance: 'DEFERRED',
    createdAt: new Date().toISOString(),
    appVersion: '1.0.0',
    source: { digest: 'x', head: 'h', branch: 'old', fileCount: 0, manifestVersion: 2 },
    artifact: { path: 'exports/old.dmg' },
  }))
  const result = loadVerifiedStructuralReceipt(root, {
    sourceManifest: () => ({ version: 2, digest: 'x', head: 'h', branch: 'new', files: [], appVersion: '1.0.0' }),
    contractFactory: () => ({ appVersion: '1.0.0', arch: 'arm64', artifactRel: 'exports/new.dmg' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /artifact path is not the current packaging-contract DMG/)
  assert.match(result.errors.join('\n'), /verification\.appAsarSha256 is required/)
  assert.match(result.errors.join('\n'), /source branch does not match/)
})
