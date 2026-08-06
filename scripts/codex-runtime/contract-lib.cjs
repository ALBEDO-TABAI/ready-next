const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')
const assetRoot = path.join(repoRoot, 'assets/codex-runtime')
const auditRoot = path.join(repoRoot, 'docs/superpowers/audits')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  )
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function digestJson(value) {
  return sha256(canonicalJson(value))
}

function digestFile(filePath) {
  return sha256(fs.readFileSync(filePath))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function loadSources() {
  return {
    sourceLock: readJson(path.join(assetRoot, 'source-lock.json')),
    contracts: readJson(path.join(assetRoot, 'contracts/runtime-contracts.json')),
    bindingSchema: readJson(path.join(assetRoot, 'contracts/binding-schema.json')),
    experimentContract: readJson(path.join(assetRoot, 'contracts/experiment-contract.json')),
    experimentReportSchema: readJson(
      path.join(assetRoot, 'contracts/experiment-report.schema.json')
    ),
    exitMatrix: readJson(
      path.join(auditRoot, '2026-08-06-codex-runtime-exit-authority-matrix.json')
    )
  }
}

function buildRuntimeManifest() {
  const {
    sourceLock,
    contracts,
    bindingSchema,
    experimentContract,
    experimentReportSchema,
    exitMatrix
  } = loadSources()
  const schemas = sourceLock.schemaGeneration
  return {
    manifestVersion: 1,
    sourceRepo: sourceLock.sourceRepo,
    releaseTag: sourceLock.releaseTag,
    gitCommit: sourceLock.gitCommit,
    codexVersion: sourceLock.codexVersion,
    platform: sourceLock.platform,
    architecture: sourceLock.architecture,
    targetTriple: sourceLock.targetTriple,
    releaseAssetName: sourceLock.releaseAsset.name,
    releaseArchiveSha256: sourceLock.releaseAsset.archiveSha256,
    binarySha256: sourceLock.releaseAsset.binarySha256,
    binarySizeBytes: sourceLock.releaseAsset.binarySizeBytes,
    stableSchemaSha256: schemas.stableBundle.sha256,
    stableV2SchemaSha256: schemas.stableV2Bundle.semanticSha256,
    experimentalSchemaSha256: schemas.experimentalBundle.sha256,
    experimentalV2SchemaSha256: schemas.experimentalV2Bundle.semanticSha256,
    agentMessageFinalSelectionContractDigest: digestJson(
      contracts.agentMessageFinalSelectionContract
    ),
    historyPublicationParityContractDigest: digestJson(
      contracts.historyPublicationParityContract
    ),
    turnInputUnionContractDigest: digestJson(contracts.turnInputUnionContract),
    turnClientIdentityExtractionContractDigest: digestJson(
      contracts.turnClientIdentityExtractionContract
    ),
    nonUserSuccessorIdentityContractDigest: digestJson(
      contracts.nonUserSuccessorIdentityContract
    ),
    startIdentityRegistryCapacity: contracts.startIdentityRegistryCapacity,
    startDeliveryResolutionContractDigest: digestJson(
      contracts.startDeliveryResolutionContract
    ),
    hostFailureCloseoutContractDigest: digestJson(contracts.hostFailureCloseoutContract),
    processLeaseContractDigest: digestJson(contracts.processLeaseContract),
    childEnvAllowlistDigest: digestJson(contracts.childEnvAllowlist),
    nativeIsolationConfigContractDigest: digestJson(contracts.nativeIsolationConfigContract),
    resourceAdditionalContextContractDigest: digestJson(
      contracts.resourceAdditionalContextContract
    ),
    outboundRpcContractDigest: digestJson(contracts.outboundRpcContract),
    bindingSchemaDigest: digestJson(bindingSchema),
    experimentContractDigest: digestJson(experimentContract),
    experimentReportSchemaDigest: digestJson(experimentReportSchema),
    exitAuthorityMatrixDigest: digestJson(exitMatrix),
    licenseDigest: sourceLock.license.sha256,
    thirdPartyNoticeDigest: sourceLock.thirdPartyNotice.sha256
  }
}

module.exports = {
  assert,
  assetRoot,
  auditRoot,
  buildRuntimeManifest,
  canonicalJson,
  digestFile,
  digestJson,
  loadSources,
  readJson,
  repoRoot,
  sha256,
  sortJson
}
