'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { REQUIRED_PROOFS, evaluateStageZ, main } = require('../check-release-stage-z-readiness.cjs')

const receipt = {
  receiptId: '12345678-1234-1234-1234-123456789abc',
  appVersion: '0.7.9-a',
  createdAt: '2026-08-12T10:00:00.000Z',
  source: { digest: 'source' },
  runtimeManifestSha256: 'runtime',
  artifact: { sha256: 'package' },
  distributionEligible: true,
  signingIdentity: 'Developer ID',
}
const identity = {
  receiptId: receipt.receiptId,
  appVersion: receipt.appVersion,
  sourceTreeDigest: 'source',
  runtimeManifestSha256: 'runtime',
  packageSha256: 'package',
}
const observedAt = '2026-08-12T10:01:00.000Z'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-stage-z-'))
  const directory = `exports/release-evidence/${receipt.receiptId}`
  const proofs = {}
  for (const key of REQUIRED_PROOFS) {
    const evidencePath = `${directory}/${key}.json`
    const absolute = path.join(root, evidencePath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, `${JSON.stringify({ ...identity, status: 'pass', observedAt })}\n`)
    proofs[key] = {
      ...identity,
      status: 'pass',
      observedAt,
      evidencePath,
      evidenceSha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    }
  }
  return {
    root,
    manifest: {
      ...identity,
      schemaVersion: 1,
      status: 'RELEASE_ACCEPTANCE_PASS',
      completedAt: observedAt,
      liveEvidenceSha256: 'live',
      proofs,
    },
  }
}

test('accepts Stage Z only when every proof binds the same package after build', () => {
  const { root, manifest } = fixture()
  assert.equal(evaluateStageZ({ root, receipt, manifest, liveManifestSha256: 'live' }).ok, true)
})

test('local ad-hoc structural package cannot claim distribution readiness', () => {
  const { root, manifest } = fixture()
  const localReceipt = { ...receipt, distributionEligible: false, signingIdentity: 'ad-hoc-local' }
  const result = evaluateStageZ({ root, receipt: localReceipt, manifest, liveManifestSha256: 'live' })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /distribution-signed package/)
})

test('rejects stale manual proof and a different live-evidence manifest', () => {
  const { root, manifest } = fixture()
  manifest.liveEvidenceSha256 = 'other-live'
  manifest.proofs.manualChecklist.observedAt = '2026-05-24T00:00:00.000Z'
  const result = evaluateStageZ({ root, receipt, manifest, liveManifestSha256: 'live' })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /liveEvidenceSha256/)
  assert.match(result.errors.join('\n'), /observedAt must be after/)
})

test('Stage Z remains deferred when current-package live evidence is missing', () => {
  const result = main({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'ready-stage-z-missing-')),
    packageIdentity: { ok: true, receipt },
    liveResult: { ok: false, errors: ['manual deferred'] },
  })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /current-package live evidence is incomplete/)
})
