const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  assert,
  assetRoot,
  buildRuntimeManifest,
  digestFile,
  digestJson,
  readJson,
  repoRoot
} = require('./contract-lib.cjs')

const requiredManifestFields = [
  'sourceRepo',
  'releaseTag',
  'gitCommit',
  'codexVersion',
  'platform',
  'architecture',
  'binarySha256',
  'stableSchemaSha256',
  'stableV2SchemaSha256',
  'experimentalSchemaSha256',
  'experimentalV2SchemaSha256',
  'agentMessageFinalSelectionContractDigest',
  'historyPublicationParityContractDigest',
  'turnInputUnionContractDigest',
  'turnClientIdentityExtractionContractDigest',
  'nonUserSuccessorIdentityContractDigest',
  'startIdentityRegistryCapacity',
  'startDeliveryResolutionContractDigest',
  'hostFailureCloseoutContractDigest',
  'processLeaseContractDigest',
  'childEnvAllowlistDigest',
  'nativeIsolationConfigContractDigest',
  'resourceAdditionalContextContractDigest',
  'modelGatewayContractDigest',
  'toolBridgeContractDigest',
  'externalReadSliceContractDigest',
  'outboundRpcContractDigest',
  'bindingSchemaDigest',
  'experimentContractDigest',
  'experimentReportSchemaDigest',
  'exitAuthorityMatrixDigest',
  'licenseDigest',
  'thirdPartyNoticeDigest'
]

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8' })
  assert(result.status === 0, `${args.join(' ')} failed: ${String(result.stderr).trim()}`)
  return String(result.stdout || '').trim()
}

function main() {
  const sourceLock = readJson(path.join(assetRoot, 'source-lock.json'))
  const manifest = readJson(path.join(assetRoot, 'runtime-manifest.json'))
  assert(
    JSON.stringify(manifest) === JSON.stringify(buildRuntimeManifest()),
    'runtime-manifest.json is not generated from the current contracts'
  )
  for (const field of requiredManifestFields) {
    assert(manifest[field] !== undefined && manifest[field] !== null, `Missing manifest field: ${field}`)
  }
  assert(Number.isInteger(manifest.startIdentityRegistryCapacity), 'Registry capacity must be an integer')
  assert(manifest.startIdentityRegistryCapacity > 0, 'Registry capacity must be positive')
  assert(digestFile(path.join(assetRoot, sourceLock.license.path)) === manifest.licenseDigest, 'License digest mismatch')
  assert(
    digestFile(path.join(assetRoot, sourceLock.thirdPartyNotice.path)) === manifest.thirdPartyNoticeDigest,
    'NOTICE digest mismatch'
  )
  const schemaLock = sourceLock.schemaGeneration
  assert(
    digestFile(path.join(assetRoot, schemaLock.stableBundle.path)) === schemaLock.stableBundle.sha256,
    'Checked-in stable schema digest mismatch'
  )
  assert(
    digestFile(path.join(assetRoot, schemaLock.experimentalBundle.path)) === schemaLock.experimentalBundle.sha256,
    'Checked-in experimental schema digest mismatch'
  )
  for (const bundle of [schemaLock.stableV2Bundle, schemaLock.experimentalV2Bundle]) {
    const filePath = path.join(assetRoot, bundle.path)
    assert(digestFile(filePath) === bundle.checkedInSha256, `Checked-in schema digest mismatch: ${bundle.path}`)
    assert(digestJson(readJson(filePath)) === bundle.semanticSha256, `Checked-in schema semantic drift: ${bundle.path}`)
  }

  const binary = path.join(repoRoot, 'build/codex', sourceLock.targetTriple, 'codex')
  assert(fs.existsSync(binary), `Pinned development binary missing: ${binary}`)
  assert(digestFile(binary) === manifest.binarySha256, 'Pinned development binary digest mismatch')
  assert(run(binary, ['--version']) === `codex-cli ${manifest.codexVersion}`, 'Binary version mismatch')

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-codex-schema-'))
  try {
    const stableDir = path.join(tempDir, 'stable')
    const experimentalDir = path.join(tempDir, 'experimental')
    fs.mkdirSync(stableDir)
    fs.mkdirSync(experimentalDir)
    run(binary, ['app-server', 'generate-json-schema', '--out', stableDir])
    run(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', experimentalDir])
    const checks = [
      [path.join(stableDir, 'codex_app_server_protocol.schemas.json'), manifest.stableSchemaSha256],
      [path.join(stableDir, 'codex_app_server_protocol.v2.schemas.json'), manifest.stableV2SchemaSha256, true],
      [path.join(experimentalDir, 'codex_app_server_protocol.schemas.json'), manifest.experimentalSchemaSha256],
      [path.join(experimentalDir, 'codex_app_server_protocol.v2.schemas.json'), manifest.experimentalV2SchemaSha256, true]
    ]
    for (const [filePath, digest, semantic] of checks) {
      const actual = semantic ? digestJson(readJson(filePath)) : digestFile(filePath)
      assert(actual === digest, `Generated schema drift: ${path.basename(filePath)}`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  console.log(`Codex runtime source PASS (${manifest.releaseTag}, ${manifest.binarySha256.slice(0, 12)}).`)
}

main()
