'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  EXPECTED_SURFACE_COUNT,
  SURFACE_CONTRACTS,
  currentEvidenceDirectory,
  evaluateCurrentLiveEvidence,
  main,
} = require('../check-release-live-evidence.cjs')

const fixturePaths = []
const tempFixture = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fixturePaths.push(root)
  return root
}
test.after(() => {
  for (const target of fixturePaths) fs.rmSync(target, { recursive: true, force: true })
})

const createdAt = '2026-08-12T10:00:00.000Z'
const observedAt = '2026-08-12T10:01:00.000Z'
const receipt = {
  receiptId: '12345678-1234-1234-1234-123456789abc',
  appVersion: '0.7.9-a',
  createdAt,
  source: { digest: 'source' },
  runtimeManifestSha256: 'runtime',
  artifact: { sha256: 'package' },
  verification: { appExecutableSha256: 'app-exec', appAsarSha256: 'asar' },
}
const identity = {
  receiptId: receipt.receiptId,
  appVersion: receipt.appVersion,
  sourceTreeDigest: 'source',
  runtimeManifestSha256: 'runtime',
  packageSha256: 'package',
}

function proofFor(id) {
  if (id === 9) return {
    publicContinuationActions: 0, resumeRunCalls: 0, respondToInteractionCalls: 0,
    startDetachedTaskCalls: 0, childCancelAvailable: true, detachedCancelAvailable: true,
    historyReadOnly: true,
  }
  if (id === 11) return { agentTriggeredRuns: 0, typingEvents: 0, automaticReplies: 0, resourcesPersisted: true }
  if (id === 14) return { agentScheduleUiActions: 0, agentScheduleIpcCalls: 0, agentScheduleRuns: 0, skillSchedulesAvailable: true }
  return {}
}

function fixture() {
  const root = tempFixture('ready-release-live-')
  const directory = currentEvidenceDirectory(receipt)
  const surfaces = []
  for (let id = 1; id <= EXPECTED_SURFACE_COUNT; id += 1) {
    const contract = SURFACE_CONTRACTS[id]
    const evidencePath = `${directory}/surface-${String(id).padStart(2, '0')}.json`
    const outputPath = `${directory}/surface-${String(id).padStart(2, '0')}.txt`
    const outputAbsolute = path.join(root, outputPath)
    fs.mkdirSync(path.dirname(outputAbsolute), { recursive: true })
    fs.writeFileSync(outputAbsolute, `observed ${id}\n`)
    const proof = proofFor(id)
    const artifact = {
      ...identity,
      surfaceId: id,
      status: 'pass',
      contract,
      observedAt,
      proof,
      packageReadback: {
        appExecutableSha256: 'app-exec',
        appAsarSha256: 'asar',
        appVersion: receipt.appVersion,
        packageSha256: receipt.artifact.sha256,
        receiptId: receipt.receiptId,
      },
      packagedAppCapture: {
        kind: 'ready-packaged-live-proof-v1',
        success: true,
        proofNonce: 'a'.repeat(32),
        pid: 1234,
        bootIncarnationId: 'boot-1',
        execSha256: 'app-exec',
        asarSha256: 'asar',
        sourceManifestDigest: undefined,
        appVersion: receipt.appVersion,
        packageSha256: receipt.artifact.sha256,
        receiptId: receipt.receiptId,
      },
      observedOutput: {
        path: outputPath,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(outputAbsolute)).digest('hex'),
      },
    }
    const absolute = path.join(root, evidencePath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, `${JSON.stringify(artifact)}\n`)
    surfaces.push({
      ...identity,
      id,
      status: 'pass',
      contract,
      observedAt,
      evidencePath,
      evidenceSha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      proof,
    })
  }
  return {
    root,
    manifest: { ...identity, schemaVersion: 1, status: 'LIVE_ACCEPTANCE_PASS', completedAt: observedAt, surfaces },
  }
}

test('keeps structural-only package evidence deferred until a trusted packaged-app recorder exists', () => {
  const { root, manifest } = fixture()
  const result = evaluateCurrentLiveEvidence({ root, receipt, manifest })
  assert.equal(result.ok, false)
  assert.equal(result.passCount, 20)
  assert.match(result.errors.join('\n'), /trusted packaged-app evidence recorder/)
})

test('rejects old-package evidence and positive retired continuation claims', () => {
  const { root, manifest } = fixture()
  manifest.surfaces[0].packageSha256 = 'old-package'
  manifest.surfaces[8].proof.resumeRunCalls = 1
  const result = evaluateCurrentLiveEvidence({ root, receipt, manifest })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /packageSha256 does not match/)
  assert.match(result.errors.join('\n'), /proof\.resumeRunCalls must equal 0/)
})

test('rejects copied evidence older than the structural package', () => {
  const { root, manifest } = fixture()
  manifest.surfaces[0].observedAt = '2026-05-24T00:00:00.000Z'
  const result = evaluateCurrentLiveEvidence({ root, receipt, manifest })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /observedAt must be after/)
})

test('standalone gate stays deferred when current-package evidence is absent', () => {
  const root = tempFixture('ready-release-live-missing-')
  const result = main({
    root,
    packageIdentity: { ok: true, receipt },
    reverifyPackage: () => receipt,
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /current-package live evidence is missing/)
})

test('rejects hand-authored evidence without a packaged-app live capture', () => {
  const { root, manifest } = fixture()
  const artifactPath = path.join(root, manifest.surfaces[0].evidencePath)
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
  delete artifact.packagedAppCapture
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`)
  manifest.surfaces[0].evidenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex')
  const result = evaluateCurrentLiveEvidence({ root, receipt, manifest })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /packaged-app capture/)
})

test('rejects symlinked surface evidence and observed output', () => {
  const { root, manifest } = fixture()
  const surface = manifest.surfaces[0]
  const artifactPath = path.join(root, surface.evidencePath)
  const outside = path.join(os.tmpdir(), `ready-live-evidence-${Date.now()}.json`)
  fixturePaths.push(outside)
  fs.renameSync(artifactPath, outside)
  fs.symlinkSync(outside, artifactPath)
  const result = evaluateCurrentLiveEvidence({ root, receipt, manifest })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /invalid evidence artifact/)
})
