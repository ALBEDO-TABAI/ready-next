#!/usr/bin/env node
'use strict'

const path = require('node:path')
const {
  RELEASE_EVIDENCE_PREFIX,
  readStableRegularFile,
  loadVerifiedStructuralReceipt,
  receiptIdentity,
  safeRelativePath,
} = require('./release-package-identity.cjs')

const ROOT = path.resolve(__dirname, '..')
const EXPECTED_SURFACE_COUNT = 20
const surfaceContracts = Object.fromEntries(
  Array.from({ length: EXPECTED_SURFACE_COUNT }, (_, index) => [index + 1, 'live-observation']),
)
surfaceContracts[9] = 'task-continuation-retired'
surfaceContracts[11] = 'remote-resource-only'
surfaceContracts[14] = 'agent-schedules-retired'
const SURFACE_CONTRACTS = Object.freeze(surfaceContracts)

function currentEvidenceDirectory(receipt) {
  return `${RELEASE_EVIDENCE_PREFIX}${receipt.receiptId}`
}

function identityErrors(candidate, expected, label) {
  const errors = []
  for (const key of [
    'receiptId',
    'appVersion',
    'sourceTreeDigest',
    'runtimeManifestSha256',
    'packageSha256',
  ]) {
    if (candidate?.[key] !== expected[key]) errors.push(`${label}: ${key} does not match the structural package`)
  }
  return errors
}

function proofErrors(surface) {
  const proof = surface?.proof || {}
  if (surface.contract === 'task-continuation-retired') {
    const expected = {
      publicContinuationActions: 0,
      resumeRunCalls: 0,
      respondToInteractionCalls: 0,
      startDetachedTaskCalls: 0,
      childCancelAvailable: true,
      detachedCancelAvailable: true,
      historyReadOnly: true,
    }
    return Object.entries(expected)
      .filter(([key, value]) => proof[key] !== value)
      .map(([key, value]) => `surface 9: proof.${key} must equal ${value}`)
  }
  if (surface.contract === 'remote-resource-only') {
    const expected = {
      agentTriggeredRuns: 0,
      typingEvents: 0,
      automaticReplies: 0,
      resourcesPersisted: true,
    }
    return Object.entries(expected)
      .filter(([key, value]) => proof[key] !== value)
      .map(([key, value]) => `surface 11: proof.${key} must equal ${value}`)
  }
  if (surface.contract === 'agent-schedules-retired') {
    const expected = {
      agentScheduleUiActions: 0,
      agentScheduleIpcCalls: 0,
      agentScheduleRuns: 0,
      skillSchedulesAvailable: true,
    }
    return Object.entries(expected)
      .filter(([key, value]) => proof[key] !== value)
      .map(([key, value]) => `surface 14: proof.${key} must equal ${value}`)
  }
  return []
}

function observedArtifactErrors(artifact, surface, receipt) {
  const errors = []
  const expected = receipt?.verification || {}
  const packageReadback = artifact?.packageReadback || {}
  for (const [key, value] of Object.entries({
    appExecutableSha256: expected.appExecutableSha256,
    appAsarSha256: expected.appAsarSha256,
    appVersion: receipt.appVersion,
    packageSha256: receipt.artifact.sha256,
    receiptId: receipt.receiptId,
  })) {
    if (packageReadback[key] !== value) {
      errors.push(`surface ${surface.id}: evidence packageReadback.${key} does not match the inspected package`)
    }
  }
  if (!artifact?.observedOutput?.path || !artifact?.observedOutput?.sha256) {
    errors.push(`surface ${surface.id}: evidence artifact must bind an observed output file`)
  }
  const capture = artifact?.packagedAppCapture || {}
  const captureExpected = {
    kind: 'ready-packaged-live-proof-v1',
    success: true,
    execSha256: expected.appExecutableSha256,
    asarSha256: expected.appAsarSha256,
    sourceManifestDigest: expected.browserSourceManifestDigest,
    appVersion: receipt.appVersion,
    packageSha256: receipt.artifact.sha256,
    receiptId: receipt.receiptId,
  }
  for (const [key, value] of Object.entries(captureExpected)) {
    if (capture[key] !== value) {
      errors.push(`surface ${surface.id}: packaged-app capture.${key} does not match the inspected package`)
    }
  }
  if (!/^[0-9a-f]{32,}$/i.test(String(capture.proofNonce || ''))
    || !Number.isInteger(capture.pid) || capture.pid <= 0
    || typeof capture.bootIncarnationId !== 'string' || !capture.bootIncarnationId) {
    errors.push(`surface ${surface.id}: packaged-app capture is missing live process identity`)
  }
  return errors
}

function evaluateCurrentLiveEvidence({ root, receipt, manifest }) {
  const errors = []
  const identity = receiptIdentity(receipt)
  const receiptTime = Date.parse(receipt.createdAt)
  errors.push(...identityErrors(manifest, identity, 'live evidence manifest'))
  if (manifest?.schemaVersion !== 1 || manifest?.status !== 'LIVE_ACCEPTANCE_PASS') {
    errors.push('live evidence manifest: schemaVersion=1 and status=LIVE_ACCEPTANCE_PASS are required')
  }
  if (!Number.isFinite(Date.parse(String(manifest?.completedAt || '')))
    || Date.parse(manifest.completedAt) < receiptTime) {
    errors.push('live evidence manifest: completedAt must be after the structural receipt')
  }
  const surfaces = Array.isArray(manifest?.surfaces) ? manifest.surfaces : []
  const byId = new Map()
  for (const surface of surfaces) {
    const id = Number(surface?.id)
    if (!Number.isInteger(id) || id < 1 || id > EXPECTED_SURFACE_COUNT) {
      errors.push(`live evidence manifest: invalid surface id ${surface?.id}`)
      continue
    }
    if (byId.has(id)) errors.push(`live evidence manifest: duplicate surface id ${id}`)
    byId.set(id, surface)
  }
  for (let id = 1; id <= EXPECTED_SURFACE_COUNT; id += 1) {
    const surface = byId.get(id)
    if (!surface) {
      errors.push(`live evidence manifest: missing surface id ${id}`)
      continue
    }
    if (surface.status !== 'pass' || surface.contract !== SURFACE_CONTRACTS[id]) {
      errors.push(`surface ${id}: status=pass and contract=${SURFACE_CONTRACTS[id]} are required`)
    }
    errors.push(...identityErrors(surface, identity, `surface ${id}`))
    if (!Number.isFinite(Date.parse(String(surface.observedAt || '')))
      || Date.parse(surface.observedAt) < receiptTime) {
      errors.push(`surface ${id}: observedAt must be after the structural receipt`)
    }
    const evidencePath = String(surface.evidencePath || '')
    let artifact = null
    try {
      const resolved = safeRelativePath(root, evidencePath, {
        prefix: `${currentEvidenceDirectory(receipt)}/`,
      })
      if (resolved.relativePath.endsWith('/live-evidence.json')) {
        throw new Error('surface evidence must be independent from the live manifest')
      }
      const evidenceFile = readStableRegularFile(resolved.absolutePath, root, { includeContent: true })
      if (evidenceFile.sha256 !== surface.evidenceSha256) {
        throw new Error('surface evidence digest does not match')
      }
      artifact = JSON.parse(evidenceFile.content.toString('utf8'))
    } catch (error) {
      errors.push(`surface ${id}: invalid evidence artifact: ${error.message}`)
    }
    if (artifact) {
      if (artifact.surfaceId !== id || artifact.status !== 'pass' || artifact.contract !== surface.contract) {
        errors.push(`surface ${id}: evidence artifact identity or status is invalid`)
      }
      errors.push(...identityErrors(artifact, identity, `surface ${id} evidence artifact`))
      if (artifact.observedAt !== surface.observedAt) {
        errors.push(`surface ${id}: evidence artifact observedAt does not match manifest`)
      }
      errors.push(...observedArtifactErrors(artifact, surface, receipt))
      if (JSON.stringify(artifact.proof || {}) !== JSON.stringify(surface.proof || {})) {
        errors.push(`surface ${id}: evidence artifact proof does not match manifest`)
      }
      try {
        const output = safeRelativePath(root, artifact.observedOutput.path, {
          prefix: `${currentEvidenceDirectory(receipt)}/`,
        })
        if (readStableRegularFile(output.absolutePath, root).sha256 !== artifact.observedOutput.sha256) {
          throw new Error('observed output digest does not match')
        }
      } catch (error) {
        errors.push(`surface ${id}: invalid observed output: ${error.message}`)
      }
    }
    errors.push(...proofErrors(surface))
  }
  errors.push('current-package live acceptance requires the trusted packaged-app evidence recorder, which is intentionally deferred for this structural-only package')
  return { ok: false, errors, passCount: surfaces.filter((surface) => surface?.status === 'pass').length, total: EXPECTED_SURFACE_COUNT }
}

function main({
  root = ROOT,
  packageIdentity = loadVerifiedStructuralReceipt(root),
  reverifyPackage = () => require('./verify-release-structural-package.cjs')
    .verifyExistingStructuralReceipt({ root }),
} = {}) {
  const errors = []
  if (!packageIdentity?.ok || !packageIdentity.receipt) {
    return { ok: false, errors: packageIdentity?.errors || ['structural package receipt is invalid'], passCount: 0, total: EXPECTED_SURFACE_COUNT }
  }
  try {
    reverifyPackage()
  } catch (error) {
    return { ok: false, errors: [`structural package revalidation failed: ${error.message}`], passCount: 0, total: EXPECTED_SURFACE_COUNT }
  }
  const receipt = packageIdentity.receipt
  const manifestRel = `${currentEvidenceDirectory(receipt)}/live-evidence.json`
  let manifest
  try {
    manifest = JSON.parse(readStableRegularFile(path.join(root, manifestRel), root, { includeContent: true }).content.toString('utf8'))
  } catch {
    errors.push(`${manifestRel}: current-package live evidence is missing or invalid`)
    return { ok: false, errors, passCount: 0, total: EXPECTED_SURFACE_COUNT }
  }
  return evaluateCurrentLiveEvidence({ root, receipt, manifest })
}

if (require.main === module) {
  const result = main()
  if (result.ok) {
    console.log('[check-release-live-evidence] CURRENT_PACKAGE_LIVE_PASS')
    console.log(`  surfaces: ${result.passCount}/${result.total}`)
  } else {
    console.error('[check-release-live-evidence] LIVE_ACCEPTANCE_DEFERRED')
    for (const error of result.errors) console.error(`  - ${error}`)
  }
  process.exit(result.ok ? 0 : 1)
}

module.exports = {
  EXPECTED_SURFACE_COUNT,
  SURFACE_CONTRACTS,
  currentEvidenceDirectory,
  evaluateCurrentLiveEvidence,
  identityErrors,
  main,
  observedArtifactErrors,
}
