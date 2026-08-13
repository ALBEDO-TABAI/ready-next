#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { main: checkLiveEvidence, currentEvidenceDirectory, identityErrors } = require('./check-release-live-evidence.cjs')
const { loadVerifiedStructuralReceipt, readStableRegularFile, receiptIdentity, safeRelativePath } = require('./release-package-identity.cjs')

const ROOT = path.resolve(__dirname, '..')
const REQUIRED_PROOFS = Object.freeze([
  'manualChecklist',
  'macPackageSmoke',
  'branchProtection',
  'platformParity',
])

function evaluateStageZ({ root, receipt, manifest, liveManifestSha256 }) {
  const errors = []
  const identity = receiptIdentity(receipt)
  const receiptTime = Date.parse(receipt.createdAt)
  errors.push(...identityErrors(manifest, identity, 'Stage Z manifest'))
  if (receipt.distributionEligible !== true || receipt.signingIdentity === 'ad-hoc-local') {
    errors.push('Stage Z requires a distribution-signed package; this structural package is local-only')
  }
  if (manifest?.schemaVersion !== 1 || manifest?.status !== 'RELEASE_ACCEPTANCE_PASS') {
    errors.push('Stage Z manifest: schemaVersion=1 and status=RELEASE_ACCEPTANCE_PASS are required')
  }
  if (manifest?.liveEvidenceSha256 !== liveManifestSha256) {
    errors.push('Stage Z manifest: liveEvidenceSha256 does not match current-package live evidence')
  }
  if (!Number.isFinite(Date.parse(String(manifest?.completedAt || '')))
    || Date.parse(manifest.completedAt) < receiptTime) {
    errors.push('Stage Z manifest: completedAt must be after the structural receipt')
  }
  for (const key of REQUIRED_PROOFS) {
    const proof = manifest?.proofs?.[key]
    if (proof?.status !== 'pass') {
      errors.push(`Stage Z proof ${key}: status=pass is required`)
      continue
    }
    errors.push(...identityErrors(proof, identity, `Stage Z proof ${key}`))
    if (!Number.isFinite(Date.parse(String(proof.observedAt || '')))
      || Date.parse(proof.observedAt) < receiptTime) {
      errors.push(`Stage Z proof ${key}: observedAt must be after the structural receipt`)
    }
    try {
      const resolved = safeRelativePath(root, proof.evidencePath, {
        prefix: `${currentEvidenceDirectory(receipt)}/`,
      })
      const evidenceFile = readStableRegularFile(resolved.absolutePath, root, { includeContent: true })
      if (evidenceFile.sha256 !== proof.evidenceSha256) {
        throw new Error('digest does not match')
      }
      const artifact = JSON.parse(evidenceFile.content.toString('utf8'))
      errors.push(...identityErrors(artifact, identity, `Stage Z proof ${key} artifact`))
      if (artifact.status !== 'pass' || artifact.observedAt !== proof.observedAt) {
        errors.push(`Stage Z proof ${key}: artifact status or observedAt is invalid`)
      }
    } catch (error) {
      errors.push(`Stage Z proof ${key}: invalid evidence artifact: ${error.message}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

function main({ root = ROOT, packageIdentity = loadVerifiedStructuralReceipt(root), liveResult } = {}) {
  if (!packageIdentity?.ok || !packageIdentity.receipt) {
    return { ok: false, errors: packageIdentity?.errors || ['structural package receipt is invalid'], notes: [] }
  }
  const receipt = packageIdentity.receipt
  const currentLive = liveResult || checkLiveEvidence({ root, packageIdentity })
  if (!currentLive.ok) return { ok: false, errors: ['current-package live evidence is incomplete', ...currentLive.errors], notes: [] }
  const evidenceDir = currentEvidenceDirectory(receipt)
  const liveManifestPath = path.join(root, evidenceDir, 'live-evidence.json')
  const stagePath = path.join(root, evidenceDir, 'stage-z-evidence.json')
  let manifest
  try {
    manifest = JSON.parse(readStableRegularFile(stagePath, root, { includeContent: true }).content.toString('utf8'))
  } catch {
    return { ok: false, errors: [`${evidenceDir}/stage-z-evidence.json: missing or invalid`], notes: [] }
  }
  const result = evaluateStageZ({
    root,
    receipt,
    manifest,
    liveManifestSha256: readStableRegularFile(liveManifestPath, root).sha256,
  })
  return { ...result, notes: result.ok ? ['same-package live and Stage Z evidence verified'] : [] }
}

if (require.main === module) {
  const result = main()
  if (result.ok) console.log('[check-release-stage-z-readiness] RELEASE_CANDIDATE_PASS')
  else {
    console.error('[check-release-stage-z-readiness] RELEASE_ACCEPTANCE_DEFERRED')
    for (const error of result.errors) console.error(`  - ${error}`)
  }
  process.exit(result.ok ? 0 : 1)
}

module.exports = { REQUIRED_PROOFS, evaluateStageZ, main }
