#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  cpSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  fsyncSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertHandshake,
  assertNoAmbientExecutionInjection,
  assertTrustedBuildProvenance,
  assertTrustedBuildToolchain,
  assertTrustedSidecarVenvPython,
  assertTrustedPublicHttpsEndpoint,
  assertRecordedProcessesExited,
  captureDetachedDescendantProcessGroups,
  captureProcessCensus,
  closeChildProcess,
  computeTreeIdentity,
  copyFrozenDatabaseFamily,
  enableAgentPanelHarness,
  evaluateCdp,
  fingerprintDatabaseFamily,
  freezeChildProcessForOwnershipCapture,
  normalizeHandshake,
  openCdp,
  prepareTrustedBuildToolchain,
  runTrustedNpmBuild,
  sanitizedRuntimeEnvironment,
  seedProviderSettings,
  sha256File,
  sqlQuote,
  sqliteJson,
  trustedSqlite3Path,
  trustedSidecarPythonProvenance,
  trustedSidecarEnvironmentProvenance,
  trustedElectronGypProvenance,
  validatedChildProcessPid,
  waitForStableDatabaseSnapshot,
} from './codex-runtime/live-proof-runtime.mjs'

const require = createRequire(import.meta.url)
const { buildOutputManifest, buildSourceManifest } = require('./browser-live-proof-manifest.cjs')
const {
  assertValidatedE6LiveProofPlan,
  createSafePreflightReport,
  parseE6LiveProofPreflight,
} = require('./codex-runtime/e6-live-proof-preflight.cjs')
const {
  assertE6LiveProofEvidence,
  readE6DatabaseEvidence,
  sha256Canonical,
} = require('./codex-runtime/e6-live-proof-evidence.cjs')
const {
  retainValidatedE6GatewayCapture,
} = require('./codex-runtime/e6-gateway-capture.cjs')
const {
  E6_AUTHORITY_ROOT,
  acquireE6GlobalLease,
  releaseE6GlobalLease,
} = require('./codex-runtime/e6-global-lease.cjs')
const {
  observedEffectCounts,
  safeGatewayCaptureStats,
} = require('./codex-runtime/e6-failure-observation.cjs')

const ROOT = process.cwd()
const TRUSTED_PROVIDER_HOSTS = ['cn-novacode.i0yu.cn']
const TRUSTED_FEISHU_HOSTS = ['open.feishu.cn', 'open.larksuite.com']
const TRUSTED_LARK_CLI = Object.freeze({
  payloadPath: '/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli',
  payloadSha256: '95bdd996ca4a8071ccac14f1542c9509557eb8f7091dd489e51139ef8aa1be80',
  version: 'lark-cli version 1.0.76',
})
const ENV_KEYS = [
  'READY_CODEX_E6_TARGET',
  'READY_CODEX_REAL_DB_PATH',
  'READY_CODEX_E6_CHANNEL_ID',
  'READY_CODEX_E6_DOC_TOKEN',
  'READY_CODEX_E6_DOC_TYPE',
  'READY_CODEX_E6_DOC_REF',
  'READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID',
  'READY_CODEX_E6_FEISHU_RESOURCE_VERSION',
  'READY_CODEX_E6_FEISHU_RESOURCE_DIGEST',
  'READY_CODEX_E6_FEISHU_EXPECTED_ANSWER',
  'READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID',
  'READY_CODEX_E6_LARK_RESOURCE_VERSION',
  'READY_CODEX_E6_LARK_RESOURCE_DIGEST',
  'READY_CODEX_E6_LARK_EXPECTED_ANSWER',
  'READY_CODEX_E6_POLICY_EPOCH',
  'READY_CODEX_E6_ITERATIONS',
]
let activeEmergencyCleanup = async () => {}
let emergencyCleanupStarted = false
let activeGlobalLease = null

async function main() {
  const inputEnv = Object.freeze(Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])))
  const preflight = parseE6LiveProofPreflight(inputEnv)
  if (!preflight.ok) {
    process.stdout.write(`${JSON.stringify(createSafePreflightReport(preflight))}\n`)
    process.exitCode = 2
    return
  }
  assertValidatedE6LiveProofPlan(preflight.plan)
  const repeatedPreflight = parseE6LiveProofPreflight(inputEnv)
  if (!repeatedPreflight.ok
    || repeatedPreflight.plan.validatedPlanDigest !== preflight.plan.validatedPlanDigest) {
    process.stdout.write(`${JSON.stringify(safeFailure('e6_preflight_drift', preflight.plan))}\n`)
    process.exitCode = 2
    return
  }
  assertValidatedE6LiveProofPlan(repeatedPreflight.plan)
  if (preflight.plan.target === 'preflight-only') {
    process.stdout.write(`${JSON.stringify(createSafePreflightReport(preflight))}\n`)
    return
  }
  try {
    assertNoAmbientExecutionInjection(process.env)
  } catch {
    process.stdout.write(`${JSON.stringify(safeFailure(
      'e6_ambient_execution_injection_forbidden', preflight.plan,
    ))}\n`)
    process.exitCode = 2
    return
  }
  const globalLease = await acquireE6GlobalLease()
  if (!globalLease.acquired) {
    process.stdout.write(`${JSON.stringify(safeFailure(
      globalLease.code,
      preflight.plan,
      { processSpawns: null },
      { processSpawnObservationVerified: false },
    ))}\n`)
    process.exitCode = 2
    return
  }
  activeGlobalLease = globalLease
  void globalLease.lost.catch((error) => {
    void emergencyExit(1, 'e6_global_lease_lost', error)
  })
  await cleanupAbandonedSensitiveRoots()

  const inputs = freezeInputs(inputEnv)
  const proofId = randomBytes(20).toString('hex')
  const evidenceRoot = resolve(ROOT, 'outputs/codex-runtime-e6', proofId)
  const sensitiveRunRoot = resolve(E6_AUTHORITY_ROOT, `ready-codex-e6-${proofId}`)
  const sourceSnapshotPath = resolve(sensitiveRunRoot, 'source-ready.db')
  const profilePath = resolve(sensitiveRunRoot, 'profile')
  const tempPath = resolve(sensitiveRunRoot, 'tmp')
  const databasePath = resolve(profilePath, 'ready.db')
  const rawEvidenceDatabasePath = resolve(sensitiveRunRoot, 'e6-raw-evidence.db')
  const pycachePath = resolve(sensitiveRunRoot, 'pycache')
  const isolatedSidecarRuntimePath = resolve(profilePath, 'agent-sidecar-runtime')
  const isolatedSidecarPythonPath = resolve(isolatedSidecarRuntimePath, 'python')
  const buildHomePath = resolve(sensitiveRunRoot, 'build-home')
  const buildToolchainBinPath = resolve(buildHomePath, 'trusted-bin')
  const isolatedElectronGypPath = resolve(buildHomePath, '.electron-gyp/45.3.0')
  const gatewayCapturePath = resolve(profilePath, 'e5-gateway-capture.ndjson')
  const retainedGatewayCapturePath = resolve(evidenceRoot, 'e6-gateway-capture.ndjson')
  const redactedEvidencePath = resolve(evidenceRoot, 'e6-redacted-evidence.json')
  const completionMarkerPath = resolve(evidenceRoot, 'e6-runtime-completion.json')
  const reportPath = resolve(evidenceRoot, 'e6-live-proof-report.json')
  initializeSensitiveRunRoot(sensitiveRunRoot, proofId)
  activeEmergencyCleanup = async () => {
    rmSync(sensitiveRunRoot, { recursive: true, force: true })
  }
  const stopBeforeRuntime = (code, effects = {}, details = {}) => {
    rmSync(sensitiveRunRoot, { recursive: true, force: true })
    process.stdout.write(`${JSON.stringify(safeFailure(code, preflight.plan, effects, {
      processSpawnObservationVerified: false,
      ...details,
    }))}\n`)
    process.exitCode = 2
  }
  let sourceBefore
  try {
    sourceBefore = copyFrozenDatabaseFamily(
      inputs.sourceDatabasePath,
      sourceSnapshotPath,
    ).source
  } catch {
    stopBeforeRuntime('e6_source_database_unstable', {
      sourceDatabaseOpens: 0,
      processSpawns: null,
    })
    return
  }
  let channel
  try {
    channel = readEnabledFeishuChannel(sourceSnapshotPath, inputs.channelId)
  } catch {
    stopBeforeRuntime('e6_source_database_unreadable', {
      sourceDatabaseOpens: 0,
      processSpawns: null,
    })
    return
  }
  if (!channel) {
    stopBeforeRuntime('e6_feishu_channel_unavailable', {
      sourceDatabaseOpens: 0,
      processSpawns: null,
    })
    return
  }
  let feishuEndpoint
  let providerReadiness
  let larkProvenance
  let pythonProvenance
  let sidecarEnvironmentProvenance
  let electronGypProvenance
  try {
    feishuEndpoint = parseTrustedFeishuChannelConfig(channel.configJson)
    await assertTrustedPublicHttpsEndpoint(feishuEndpoint.baseUrl, {
      allowedHosts: TRUSTED_FEISHU_HOSTS,
    })
    providerReadiness = readTrustedProviderReadiness(sourceSnapshotPath)
    const providerEndpoint = await assertTrustedPublicHttpsEndpoint(providerReadiness.baseUrl, {
      allowedHosts: TRUSTED_PROVIDER_HOSTS,
      allowedPathnames: ['/v1'],
    })
    providerReadiness = Object.freeze({
      ...providerReadiness,
      endpointClass: providerEndpoint.endpointClass,
      endpointOriginDigest: sha256Canonical(providerEndpoint.origin),
    })
    larkProvenance = readTrustedLarkCliProvenance()
    pythonProvenance = trustedSidecarPythonProvenance()
    sidecarEnvironmentProvenance = trustedSidecarEnvironmentProvenance(ROOT)
    electronGypProvenance = trustedElectronGypProvenance()
  } catch {
    stopBeforeRuntime('e6_external_identity_untrusted', {
      sourceDatabaseOpens: 0,
      processSpawns: null,
    })
    return
  }
  if (JSON.stringify(fingerprintDatabaseFamily(inputs.sourceDatabasePath)) !== JSON.stringify(sourceBefore)) {
    stopBeforeRuntime('e6_source_database_changed_during_readiness', {
      sourceDatabaseOpens: 0,
      processSpawns: null,
    })
    return
  }

  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  mkdirSync(profilePath, { recursive: true, mode: 0o700 })
  mkdirSync(tempPath, { recursive: true, mode: 0o700 })
  mkdirSync(pycachePath, { recursive: true, mode: 0o700 })
  mkdirSync(isolatedSidecarRuntimePath, { recursive: true, mode: 0o700 })
  mkdirSync(resolve(buildHomePath, '.electron-gyp'), { recursive: true, mode: 0o700 })

  let child = null
  let buildChild = null
  let cdp = null
  let handshake = null
  let sourceManifest = null
  let outputManifest = null
  let stage = 'seed'
  let failure = null
  let processRecords = []
  const ownedProcessGroupIds = new Set()
  let gracefulQuitAccepted = false
  let forcedMainShutdown = false
  let mainExitCode = null
  let mainSignalCode = null
  let forcedTreeCleanup = false
  let cleanupObservationFailed = false
  let leaseTreeZeroConfirmed = false
  let processGroupsZeroConfirmed = false
  let leaseProcessesZeroConfirmed = false
  let sensitiveCleanupConfirmed = false
  let rootProcessRecord = null
  let buildRootProcessRecord = null
  let buildProcessGroupId = null
  let sourceDatabaseOpens = 0
  let buildProvenance = null
  let buildToolchainProvenance = null
  let isolatedSidecarIdentity = null
  let processCensusMonitor = null
  let buildProcessCensusMonitor = null
  let buildProcessRecords = []
  const results = []
  const expectedRuns = buildExpectedRuns(inputs, larkProvenance)
  const spawnIntents = []
  const runtimeManifest = JSON.parse(readFileSync(
    resolve(ROOT, 'assets/codex-runtime/runtime-manifest.json'),
    'utf8',
  ))
  const runtimeExpectation = Object.freeze({
    runtimeManifestDigest: sha256Canonical(runtimeManifest),
    protocolSchemaDigest: runtimeManifest.stableV2SchemaSha256,
    sidecarRuntime: trustedSidecarRuntimeExpectation(runtimeManifest),
  })
  let persistedOwnershipDigest = null
  const persistSpawnIntent = (intent) => {
    spawnIntents.push(Object.freeze({ ...intent }))
    updateSensitiveRootMarker(sensitiveRunRoot, proofId, {
      spawnIntents: spawnIntents.map((entry) => ({ ...entry })),
    })
  }
  const persistSensitiveProcessOwnership = () => {
    const roots = [
      buildRootProcessRecord ? { ...buildRootProcessRecord, kind: 'build' } : null,
      rootProcessRecord ? { ...rootProcessRecord, kind: 'main' } : null,
    ].filter(Boolean)
    for (const groupId of ownedProcessGroupIds) {
      if (roots.some((row) => row.processGroupId === groupId)) continue
      const record = processRecords.find((row) => row.processGroupId === groupId)
      if (record) roots.push({ ...record, kind: 'sidecar' })
    }
    const processRoots = roots.map((row) => ({
      kind: row.kind,
      pid: row.pid,
      processGroupId: row.processGroupId,
      processStartIdentity: row.processStartIdentity,
      command: row.command,
    })).sort((left, right) => left.processGroupId - right.processGroupId)
    const nextDigest = sha256Canonical({ processRoots, runtime: runtimeExpectation.sidecarRuntime })
    if (nextDigest === persistedOwnershipDigest) return
    updateSensitiveRootMarker(sensitiveRunRoot, proofId, {
      processRoots,
      sidecarRuntime: runtimeExpectation.sidecarRuntime,
    })
    persistedOwnershipDigest = nextDigest
  }
  const logs = []
  const runtimeBaseEnv = sanitizedRuntimeEnvironment(process.env)
  let abortPromise = null
  const refreshRuntimeOwnership = () => {
    if (!rootProcessRecord) return
    const census = captureProcessCensus()
    processRecords = mergeProcessRecords(
      processRecords,
      captureVerifiedProofProcesses(rootProcessRecord, census),
    )
    const detachedDescendants = captureDetachedDescendantProcessGroups(
      rootProcessRecord,
      census,
    )
    processRecords = mergeProcessRecords(processRecords, detachedDescendants.records)
    for (const groupId of detachedDescendants.groupIds) ownedProcessGroupIds.add(groupId)
    const leaseState = readSidecarCleanupState(
      databasePath,
      rootProcessRecord,
      runtimeExpectation.sidecarRuntime,
    )
    processRecords = mergeProcessRecords(processRecords, leaseState.processRecords)
    for (const groupId of leaseState.ownedProcessGroupIds) ownedProcessGroupIds.add(groupId)
    persistSensitiveProcessOwnership()
  }
  const triggerProofAbort = (error) => {
    if (!failure) failure = error
    cdp?.close()
    for (const runningChild of [buildChild, child]) {
      try {
        if (runningChild && runningChild.exitCode === null && runningChild.signalCode === null) {
          freezeChildProcessForOwnershipCapture(runningChild)
        }
      } catch {
        // Exact owned process groups are terminated below.
      }
    }
    try {
      refreshRuntimeOwnership()
    } catch {
      cleanupObservationFailed = true
    }
    if (!abortPromise && ownedProcessGroupIds.size > 0) {
      abortPromise = (async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            refreshRuntimeOwnership()
          } catch {
            cleanupObservationFailed = true
          }
          await terminateRecordedProcesses(
            mergeProcessRecords(processRecords, buildProcessRecords),
            new Set(ownedProcessGroupIds),
          )
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
        }
        await assertOwnedProcessGroupsZero(ownedProcessGroupIds, { timeoutMs: 5_000 })
      })().catch((cleanupError) => {
        cleanupObservationFailed = true
        if (!failure) failure = cleanupError
      })
    }
    return abortPromise
  }
  const assertProofActive = async () => {
    if (abortPromise) await abortPromise
    if (failure) throw failure
  }
  const assertProofReadyForEffect = async () => {
    refreshRuntimeOwnership()
    await assertProofActive()
  }
  const confirmSensitiveCleanup = async () => {
    await assertOwnedProcessGroupsZero(ownedProcessGroupIds, { timeoutMs: 15_000 })
    processGroupsZeroConfirmed = true
    if (rootProcessRecord && existsSync(databasePath)) {
      const leaseState = readSidecarCleanupState(
        databasePath,
        rootProcessRecord,
        runtimeExpectation.sidecarRuntime,
      )
      processRecords = mergeProcessRecords(processRecords, leaseState.processRecords)
      for (const groupId of leaseState.ownedProcessGroupIds) ownedProcessGroupIds.add(groupId)
      if (leaseState.processRecords.length > 0) {
        throw new Error('e6_sidecar_lease_processes_not_zero')
      }
      await assertOwnedProcessGroupsZero(ownedProcessGroupIds, { timeoutMs: 15_000 })
    }
    leaseProcessesZeroConfirmed = true
    sensitiveCleanupConfirmed = true
  }
  activeEmergencyCleanup = async () => {
    cdp?.close()
    for (const runningChild of [buildChild, child]) {
      try {
        if (runningChild && runningChild.exitCode === null && runningChild.signalCode === null) {
          freezeChildProcessForOwnershipCapture(runningChild)
        }
      } catch {
        // Cleanup continues from the provisional group and captured identities.
      }
    }
    try {
      refreshRuntimeOwnership()
    } catch {
      // Cleanup continues from the exact identities already captured.
    }
    if (buildChild && buildRootProcessRecord) {
      try {
        buildProcessRecords = mergeProcessRecords(
          buildProcessRecords,
          captureVerifiedProofProcesses(buildRootProcessRecord),
        )
      } catch {
        // Continue with the exact build identities already captured.
      }
      try {
        await closeChildProcess(buildChild, { gracefulSignal: 'SIGTERM', timeoutMs: 5_000 })
      } catch {
        // The verified build group is terminated below.
      }
    }
    if (child && rootProcessRecord) {
      try {
        const liveTree = captureVerifiedProofProcesses(rootProcessRecord)
        processRecords = mergeProcessRecords(processRecords, liveTree)
      } catch {
        // Continue with the identities already captured.
      }
      try {
        const leaseState = readSidecarCleanupState(
          databasePath,
          rootProcessRecord,
          runtimeExpectation.sidecarRuntime,
        )
        processRecords = mergeProcessRecords(processRecords, leaseState.processRecords)
        for (const groupId of leaseState.ownedProcessGroupIds) ownedProcessGroupIds.add(groupId)
      } catch {
        // Continue with the already verified proof process groups.
      }
      try {
        await closeChildProcess(child, { gracefulSignal: 'SIGTERM', timeoutMs: 5_000 })
      } catch {
        // Exact descendant identities are terminated below.
      }
    }
    if (ownedProcessGroupIds.size > 0) {
      await terminateRecordedProcesses(
        mergeProcessRecords(processRecords, buildProcessRecords),
        ownedProcessGroupIds,
      )
    }
    await confirmSensitiveCleanup()
    destroySensitiveRuntimeArtifacts({ profilePath, tempPath, rawEvidenceDatabasePath })
    rmSync(sensitiveRunRoot, { recursive: true, force: true })
  }

  try {
    cpSync(sidecarEnvironmentProvenance.sourceRoot, isolatedSidecarPythonPath, {
      recursive: true,
      verbatimSymlinks: true,
    })
    writeFileSync(resolve(isolatedSidecarRuntimePath, '.install-state.json'), `${JSON.stringify({
      digest: sidecarEnvironmentProvenance.requirementsInstallDigest,
      updatedAt: 'e6-frozen-runtime',
    })}\n`, { mode: 0o600 })
    const copiedSidecarIdentity = computeTreeIdentity(isolatedSidecarPythonPath, {
      excludePythonBytecode: true,
    })
    if (copiedSidecarIdentity.digest !== sidecarEnvironmentProvenance.digest
      || copiedSidecarIdentity.entryCount !== sidecarEnvironmentProvenance.entryCount
      || copiedSidecarIdentity.fileBytes !== sidecarEnvironmentProvenance.fileBytes) {
      throw new Error('e6_isolated_sidecar_environment_mismatch')
    }
    for (const name of ['python', 'python3', 'python3.11']) {
      const linkPath = resolve(isolatedSidecarPythonPath, 'bin', name)
      rmSync(linkPath, { force: true })
      symlinkSync(pythonProvenance.path, linkPath)
    }
    assertTrustedSidecarVenvPython(isolatedSidecarPythonPath)
    isolatedSidecarIdentity = computeTreeIdentity(isolatedSidecarPythonPath, {
      excludePythonBytecode: true,
    })
    cpSync(electronGypProvenance.root, isolatedElectronGypPath, {
      recursive: true,
      verbatimSymlinks: true,
    })
    const isolatedElectronGypIdentity = computeTreeIdentity(isolatedElectronGypPath)
    if (isolatedElectronGypIdentity.digest !== electronGypProvenance.digest
      || isolatedElectronGypIdentity.entryCount !== electronGypProvenance.entryCount
      || isolatedElectronGypIdentity.fileBytes !== electronGypProvenance.fileBytes) {
      throw new Error('e6_isolated_electron_gyp_mismatch')
    }
    buildToolchainProvenance = prepareTrustedBuildToolchain(buildToolchainBinPath)
    seedProviderSettings({ sourceDatabasePath: sourceSnapshotPath, databasePath })
    seedFeishuChannel({
      sourceDatabasePath: sourceSnapshotPath,
      databasePath,
      channelId: inputs.channelId,
    })
    if (JSON.stringify(fingerprintDatabaseFamily(inputs.sourceDatabasePath)) !== JSON.stringify(sourceBefore)) {
      throw new Error('e6_source_database_changed_during_seed')
    }
    stage = 'build'
    sourceManifest = buildSourceManifest(ROOT)
    buildProvenance = assertTrustedBuildProvenance(ROOT)
    const embeddedManifestPath = resolve(ROOT, 'build/browser-live-proof/source-manifest.json')
    mkdirSync(dirname(embeddedManifestPath), { recursive: true })
    writeFileSync(embeddedManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`)
    const buildProcessIdentityArgument = `ready-codex-e6-build-${proofId}`
    persistSpawnIntent({
      kind: 'build',
      executablePath: '/bin/sh',
      identityArgument: buildProcessIdentityArgument,
    })
    try {
      await runTrustedNpmBuild({
        cwd: ROOT,
        detached: true,
        homePath: buildHomePath,
        toolchainBinPath: buildToolchainBinPath,
        processIdentityArgument: buildProcessIdentityArgument,
        onSpawn(spawnedBuild) {
          buildChild = spawnedBuild
          buildProcessGroupId = spawnedBuild.pid
          ownedProcessGroupIds.add(buildProcessGroupId)
          const census = captureProcessCensus()
          buildRootProcessRecord = census.find((row) => row.pid === spawnedBuild.pid) || null
          if (!buildRootProcessRecord || buildRootProcessRecord.processGroupId !== spawnedBuild.pid) {
            throw new Error('e6_build_root_process_identity_unavailable')
          }
          buildProcessRecords = mergeProcessRecords(
            buildProcessRecords,
            captureVerifiedProofProcesses(buildRootProcessRecord, census),
          )
          persistSensitiveProcessOwnership()
          buildProcessCensusMonitor = setInterval(() => {
            try {
              buildProcessRecords = mergeProcessRecords(
                buildProcessRecords,
                captureVerifiedProofProcesses(buildRootProcessRecord),
              )
            } catch (error) {
              void triggerProofAbort(error)
            }
          }, 1_000)
        },
      })
    } finally {
      if (buildProcessCensusMonitor) clearInterval(buildProcessCensusMonitor)
      buildProcessCensusMonitor = null
      if (buildProcessGroupId) {
        if (buildRootProcessRecord) {
          buildProcessRecords = mergeProcessRecords(
            buildProcessRecords,
            captureVerifiedProofProcesses(buildRootProcessRecord),
          )
        }
        let buildTreeForced = false
        try {
          await assertRecordedProcessesExited(buildProcessRecords, { timeoutMs: 10_000 })
          await assertOwnedProcessGroupsZero(new Set([buildProcessGroupId]), { timeoutMs: 10_000 })
        } catch {
          buildTreeForced = true
          await terminateRecordedProcesses(buildProcessRecords, ownedProcessGroupIds)
          await assertOwnedProcessGroupsZero(new Set([buildProcessGroupId]), {
            timeoutMs: 10_000,
          })
        }
        ownedProcessGroupIds.delete(buildProcessGroupId)
        buildChild = null
        buildRootProcessRecord = null
        buildProcessGroupId = null
        if (buildTreeForced && !failure) failure = new Error('e6_build_process_tree_not_zero')
      }
    }
    await assertProofActive()
    if (sha256Canonical(assertTrustedBuildProvenance(ROOT)) !== sha256Canonical(buildProvenance)) {
      throw new Error('e6_build_provenance_changed_during_build')
    }
    const sourceAfterBuild = buildSourceManifest(ROOT)
    if (sourceAfterBuild.digest !== sourceManifest.digest) {
      throw new Error('e6_source_changed_during_build')
    }
    outputManifest = buildOutputManifest(ROOT)
    const executablePath = buildProvenance.electronExecutablePath
    const pythonBeforeLaunch = trustedSidecarPythonProvenance()
    assertTrustedSidecarVenvPython(isolatedSidecarPythonPath)
    if (sha256Canonical(pythonBeforeLaunch) !== sha256Canonical(pythonProvenance)) {
      throw new Error('e6_sidecar_python_changed_before_launch')
    }
    if (readdirSync(pycachePath).length !== 0) throw new Error('e6_python_cache_not_fresh')
    const port = 10_240 + Number.parseInt(proofId.slice(0, 4), 16) % 1_000
    const proofNonce = randomBytes(24).toString('hex')
    stage = 'launch'
    const mainProcessIdentityArgument = `--ready-e6-proof-id=${proofId}`
    persistSpawnIntent({
      kind: 'main',
      executablePath,
      identityArgument: mainProcessIdentityArgument,
    })
    const spawnedChild = spawn(executablePath, [
      ROOT,
      `--remote-debugging-port=${port}`,
      mainProcessIdentityArgument,
    ], {
      cwd: ROOT,
      detached: true,
      env: {
        ...runtimeBaseEnv,
        TMPDIR: tempPath,
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
        READY_CODEX_E5_GATEWAY_CAPTURE: '1',
        READY_CODEX_E5_PROOF_SENTINELS_JSON: JSON.stringify([
          inputs.feishu.expectedAnswer,
          inputs.lark.expectedAnswer,
          inputs.documentRef,
        ]),
        READY_DB_PATH: databasePath,
        READY_SIDECAR_PYTHON: pythonProvenance.path,
        PIP_CONFIG_FILE: '/dev/null',
        PIP_NO_INDEX: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONPYCACHEPREFIX: pycachePath,
        READY_REMOTE_DEBUGGING_PORT: String(port),
        READY_USER_DATA_DIR: profilePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (Number.isSafeInteger(spawnedChild.pid) && spawnedChild.pid > 1) {
      ownedProcessGroupIds.add(spawnedChild.pid)
    }
    spawnedChild.once('error', (error) => {
      void triggerProofAbort(error)
    })
    try {
      validatedChildProcessPid(spawnedChild)
    } catch {
      child = null
      throw new Error('e6_root_process_pid_unavailable')
    }
    child = spawnedChild
    child.stdout.on('data', (chunk) => pushLogs(logs, chunk))
    child.stderr.on('data', (chunk) => pushLogs(logs, chunk))
    const initialCensus = captureProcessCensus()
    rootProcessRecord = initialCensus.find((row) => row.pid === child.pid) || null
    if (!rootProcessRecord || rootProcessRecord.processGroupId !== child.pid) {
      throw new Error('e6_root_process_identity_unavailable')
    }
    ownedProcessGroupIds.add(rootProcessRecord.processGroupId)
    refreshRuntimeOwnership()
    processCensusMonitor = setInterval(() => {
      try {
        refreshRuntimeOwnership()
      } catch (error) {
        cleanupObservationFailed = true
        void triggerProofAbort(error)
      }
    }, 100)
    await assertProofActive()
    stage = 'handshake'
    cdp = await openCdp(port, { timeoutMs: 90_000 })
    handshake = await evaluateCdp(
      cdp,
      `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`,
    )
    assertHandshake(handshake, {
      proofNonce,
      sourceManifestDigest: sourceManifest.digest,
      appPath: ROOT,
      runtimeOutputManifestDigest: outputManifest.digest,
      executablePath,
      executableSha256: buildProvenance.electronExecutableSha256,
      packaged: false,
      userDataPath: profilePath,
      databasePath,
    })
    cdp = await enableAgentPanelHarness(cdp, port, {
      requiredExpression: `Boolean(window.__READY_AGENT_TEST__?.submit
        && window.__READY_AGENT_TEST__?.createVisibleSession
        && window.electronAPI?.agent)`,
    })
    await assertProofActive()
    stage = 'external-reads'
    for (const expected of expectedRuns) {
      await assertProofReadyForEffect()
      const result = await evaluateCdp(
        cdp,
        externalReadProofExpression(expected),
        720_000,
      )
      if (!result?.ok) throw new Error('e6_renderer_iteration_failed')
      await assertProofReadyForEffect()
      expected.scopeId = result.scopeId
      results.push(result)
      processRecords = mergeProcessRecords(
        processRecords,
        captureVerifiedProofProcesses(rootProcessRecord),
      )
      await assertProofReadyForEffect()
    }
    await assertProofActive()
    stage = 'shutdown'
    const quit = await evaluateCdp(
      cdp,
      `window.electronAPI.app.browserLiveProofQuit(${JSON.stringify(proofNonce)})`,
      5_000,
    )
    gracefulQuitAccepted = quit?.success === true
  } catch (error) {
    failure = error
  } finally {
    cdp?.close()
    if (child) {
      const observeCurrentTree = () => {
        const currentTree = captureVerifiedProofProcesses(rootProcessRecord)
        processRecords = mergeProcessRecords(processRecords, currentTree)
      }
      const observeLeaseProcesses = () => {
        const leaseState = readSidecarCleanupState(
          databasePath,
          rootProcessRecord,
          runtimeExpectation.sidecarRuntime,
        )
        for (const groupId of leaseState.ownedProcessGroupIds) ownedProcessGroupIds.add(groupId)
        processRecords = mergeProcessRecords(processRecords, leaseState.processRecords)
        return leaseState
      }
      try {
        observeCurrentTree()
        observeLeaseProcesses()
      } catch (error) {
        cleanupObservationFailed = true
        if (!failure) failure = error
      }
      try {
        const closeout = await closeChildProcess(child, {
          gracefulSignal: gracefulQuitAccepted ? null : 'SIGTERM',
          timeoutMs: 30_000,
        })
        forcedMainShutdown = closeout.forced
        mainExitCode = closeout.exitCode
        mainSignalCode = closeout.signalCode
        if (mainExitCode !== 0 || mainSignalCode !== null) {
          if (!failure) failure = new Error('e6_main_process_abnormal_exit')
        }
      } catch (error) {
        cleanupObservationFailed = true
        forcedMainShutdown = true
        if (!failure) failure = error
      } finally {
        if (processCensusMonitor) clearInterval(processCensusMonitor)
        processCensusMonitor = null
      }
      try {
        observeCurrentTree()
        observeLeaseProcesses()
      } catch (error) {
        cleanupObservationFailed = true
        if (!failure) failure = error
      }
      try {
        await assertRecordedProcessesExited(processRecords, { timeoutMs: 15_000 })
        await assertOwnedProcessGroupsZero(ownedProcessGroupIds, { timeoutMs: 15_000 })
      } catch {
        forcedTreeCleanup = true
        try {
          await terminateRecordedProcesses(processRecords, ownedProcessGroupIds)
        } catch (error) {
          cleanupObservationFailed = true
          if (!failure) failure = error
        }
      }
      try {
        leaseTreeZeroConfirmed = await waitForSidecarLeaseTreeZero(
          databasePath,
          rootProcessRecord,
          runtimeExpectation.sidecarRuntime,
          (records) => {
          processRecords = mergeProcessRecords(processRecords, records)
        }, (groupIds) => {
          for (const groupId of groupIds) ownedProcessGroupIds.add(groupId)
          },
        )
      } catch (error) {
        cleanupObservationFailed = true
        if (!failure) failure = error
      }
      if (!leaseTreeZeroConfirmed) {
        forcedTreeCleanup = true
        try {
          const leaseState = readSidecarCleanupState(
            databasePath,
            rootProcessRecord,
            runtimeExpectation.sidecarRuntime,
          )
          processRecords = mergeProcessRecords(processRecords, leaseState.processRecords)
          for (const groupId of leaseState.ownedProcessGroupIds) ownedProcessGroupIds.add(groupId)
          await terminateRecordedProcesses(processRecords, ownedProcessGroupIds)
        } catch (error) {
          cleanupObservationFailed = true
          if (!failure) failure = error
        }
      }
      try {
        await assertOwnedProcessGroupsZero(ownedProcessGroupIds, { timeoutMs: 15_000 })
      } catch (error) {
        forcedTreeCleanup = true
        try {
          await terminateRecordedProcesses(processRecords, ownedProcessGroupIds)
        } catch (cleanupError) {
          cleanupObservationFailed = true
          if (!failure) failure = cleanupError
        }
        if (!failure) failure = error
      }
    }
    try {
      await confirmSensitiveCleanup()
    } catch (error) {
      cleanupObservationFailed = true
      if (!failure) failure = error
    }
  }

  if (failure || !gracefulQuitAccepted || forcedMainShutdown || forcedTreeCleanup
    || mainExitCode !== 0 || mainSignalCode !== null
    || cleanupObservationFailed || !leaseTreeZeroConfirmed || !sensitiveCleanupConfirmed) {
    const observed = observedEffectCounts(databasePath, sqliteJson)
    const captureStats = safeGatewayCaptureStats(gatewayCapturePath)
    const safe = safeFailure('e6_live_proof_failed', preflight.plan, {
      sourceDatabaseOpens,
      processSpawns: null,
      providerRequests: null,
      feishuReads: null,
      larkReads: null,
    }, {
      stage,
      failureDigest: failure ? sha256Text(failure instanceof Error ? failure.message : String(failure)) : null,
      gracefulQuitAccepted,
      forcedMainShutdown,
      mainExitCode,
      mainSignalCode,
      forcedTreeCleanup,
      cleanupObservationFailed,
      leaseTreeZeroConfirmed,
      processGroupsZeroConfirmed,
      leaseProcessesZeroConfirmed,
      recoveryPending: !sensitiveCleanupConfirmed,
      malformedGatewayCaptureLines: captureStats.malformedLineCount,
      observedProviderGatewayAdmissions: captureStats.validLineCount,
      gatewayCaptureObservationVerified: captureStats.verified,
      confirmedFeishuActionReceipts: observed.feishuReads,
      confirmedLarkActionReceipts: observed.larkReads,
      receiptObservationVerified: observed.verified,
      observedLongLivedProcessIdentities: processRecords.length,
      externalAttemptCountsVerified: false,
      logDigest: sha256Text(logs.join('\n')),
    })
    let reportPersisted = false
    try {
      writeFileSync(reportPath, `${JSON.stringify(safe, null, 2)}\n`)
      reportPersisted = true
    } finally {
      if (sensitiveCleanupConfirmed) {
        destroySensitiveRuntimeArtifacts({ profilePath, tempPath, rawEvidenceDatabasePath })
        rmSync(sensitiveRunRoot, { recursive: true, force: true })
      }
    }
    process.stdout.write(`${JSON.stringify({
      ...safe,
      reportPath: reportPersisted ? reportPath : null,
      reportPersisted,
    })}\n`)
    process.exitCode = 1
    return
  }

  stage = 'offline-verification'
  try {
    const sourceAfter = fingerprintDatabaseFamily(inputs.sourceDatabasePath)
    if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
      throw new Error('e6_source_database_changed_during_proof')
    }
    const finalSourceManifest = buildSourceManifest(ROOT)
    const finalOutputManifest = buildOutputManifest(ROOT)
    const finalBuildProvenance = assertTrustedBuildProvenance(ROOT)
    const finalSidecarRuntimeExpectation = trustedSidecarRuntimeExpectation(runtimeManifest)
    const finalPythonProvenance = trustedSidecarPythonProvenance()
    const finalSidecarEnvironmentProvenance = trustedSidecarEnvironmentProvenance(ROOT)
    const finalElectronGypProvenance = trustedElectronGypProvenance()
    const finalBuildToolchainProvenance = assertTrustedBuildToolchain(buildToolchainBinPath)
    assertTrustedSidecarVenvPython(isolatedSidecarPythonPath)
    const finalIsolatedSidecarIdentity = computeTreeIdentity(isolatedSidecarPythonPath, {
      excludePythonBytecode: true,
    })
    const finalIsolatedElectronGypIdentity = computeTreeIdentity(isolatedElectronGypPath)
    if (readdirSync(pycachePath).length !== 0) throw new Error('e6_python_cache_write_detected')
    if (finalSourceManifest.digest !== sourceManifest.digest
      || finalOutputManifest.digest !== outputManifest.digest
      || sha256Canonical(finalBuildProvenance) !== sha256Canonical(buildProvenance)
      || sha256Canonical(finalSidecarRuntimeExpectation)
        !== sha256Canonical(runtimeExpectation.sidecarRuntime)
      || sha256Canonical(finalPythonProvenance) !== sha256Canonical(pythonProvenance)
      || sha256Canonical(finalSidecarEnvironmentProvenance)
        !== sha256Canonical(sidecarEnvironmentProvenance)
      || finalIsolatedSidecarIdentity.digest !== isolatedSidecarIdentity.digest
      || finalIsolatedSidecarIdentity.entryCount !== isolatedSidecarIdentity.entryCount
      || finalIsolatedSidecarIdentity.fileBytes !== isolatedSidecarIdentity.fileBytes
      || sha256Canonical(finalElectronGypProvenance) !== sha256Canonical(electronGypProvenance)
      || sha256Canonical(finalBuildToolchainProvenance)
        !== sha256Canonical(buildToolchainProvenance)
      || finalIsolatedElectronGypIdentity.digest !== electronGypProvenance.digest
      || finalIsolatedElectronGypIdentity.entryCount !== electronGypProvenance.entryCount
      || finalIsolatedElectronGypIdentity.fileBytes !== electronGypProvenance.fileBytes) {
      throw new Error('e6_source_or_output_changed_during_proof')
    }
    assertIsolatedFeishuEndpoint(databasePath, inputs.channelId, feishuEndpoint)
    scrubRuntimeCredentials(databasePath)
    await waitForStableDatabaseSnapshot(databasePath, rawEvidenceDatabasePath)
    const databaseEvidence = readE6DatabaseEvidence(
      rawEvidenceDatabasePath,
      results.map((result) => result.scopeId),
      sqliteJson,
    )
    const retainedGatewayCapture = retainValidatedE6GatewayCapture({
      sourcePath: gatewayCapturePath,
      targetPath: retainedGatewayCapturePath,
      validate(gatewayCapture) {
        return assertE6LiveProofEvidence({
          results,
          evidence: databaseEvidence,
          gatewayCapture,
          expectedRuns,
          providerExpectation: providerReadiness,
          runtimeExpectation,
          mainProcessExpectation: rootProcessRecord,
        })
      },
    })
    const redactedEvidence = retainedGatewayCapture.validationResult
    writeFileSync(redactedEvidencePath, `${JSON.stringify(redactedEvidence, null, 2)}\n`)
    const rawEvidenceDatabaseSha256 = sha256File(rawEvidenceDatabasePath)
    const gatewayCaptureSha256 = sha256File(retainedGatewayCapturePath)
    const redactedEvidenceSha256 = sha256File(redactedEvidencePath)
    const completionMarker = {
      schemaVersion: 1,
      phase: 'E6',
      proofMode: 'typed-and-cli-3-plus-3',
      proofId,
      completedAt: new Date().toISOString(),
      validatedPlanDigest: preflight.plan.validatedPlanDigest,
      sourceManifestDigest: sourceManifest.digest,
      outputManifestDigest: outputManifest.digest,
      buildProvenance,
      sidecarPythonProvenance: pythonProvenance,
      sidecarEnvironmentProvenance,
      electronGypProvenance,
      buildToolchainProvenance,
      handshake: normalizeHandshake(handshake),
      sourceDatabase: {
        pathDigest: sha256Canonical(inputs.sourceDatabasePath),
        fingerprintBefore: sourceBefore,
        fingerprintAfter: sourceAfter,
        unchanged: true,
      },
      artifacts: {
        rawEvidenceDatabaseSha256,
        rawEvidenceDatabaseRetained: false,
        gatewayCaptureSha256,
        redactedEvidenceSha256,
      },
      shutdown: {
        gracefulQuitAccepted,
        forcedMainShutdown,
        mainExitCode,
        mainSignalCode,
        forcedTreeCleanup,
        cleanupObservationFailed,
        leaseTreeZeroConfirmed,
        processGroupsZeroConfirmed,
        leaseProcessesZeroConfirmed,
        sensitiveCleanupConfirmed,
        recordedProcessCount: processRecords.length,
        recordedProcessIdentityDigest: sha256Canonical(
          processRecords.map((row) => row.processStartIdentity).sort(),
        ),
      },
      credentialSafety: {
        isolatedChannelConfigScrubbed: true,
        rawRuntimeArtifactsDestroyed: true,
        sensitiveFieldsEmitted: [],
      },
    }
    rmSync(rawEvidenceDatabasePath, { force: true })
    destroySensitiveRuntimeArtifacts({ profilePath, tempPath })
    rmSync(sensitiveRunRoot, { recursive: true, force: true })
    writeFileSync(completionMarkerPath, `${JSON.stringify(completionMarker, null, 2)}\n`)
    const completionMarkerSha256 = sha256File(completionMarkerPath)
    const report = {
      ok: true,
      schemaVersion: 1,
      phase: 'E6',
      proofMode: 'typed-and-cli-3-plus-3',
      runtimeMode: 'built-development-app',
      generatedAt: new Date().toISOString(),
      proofId,
      validatedPlanDigest: preflight.plan.validatedPlanDigest,
      sourceManifest,
      handshake: normalizeHandshake(handshake),
      evidence: redactedEvidence,
      sourceDatabaseUnchanged: true,
      shutdown: completionMarker.shutdown,
      credentialSafety: completionMarker.credentialSafety,
      artifacts: {
        completionMarkerPath,
        completionMarkerSha256,
        redactedEvidencePath,
        redactedEvidenceSha256,
        gatewayCapturePath: retainedGatewayCapturePath,
        gatewayCaptureSha256,
        rawEvidenceDatabaseSha256,
        rawEvidenceDatabaseRetained: false,
      },
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      phase: 'E6',
      proofMode: report.proofMode,
      passes: redactedEvidence.runCount,
      reportPath,
      reportSha256: sha256File(reportPath),
    })}\n`)
  } catch (error) {
    const captureStats = safeGatewayCaptureStats(gatewayCapturePath)
    const observed = observedEffectCounts(databasePath, sqliteJson)
    const safe = safeFailure('e6_offline_verification_failed', preflight.plan, {
      sourceDatabaseOpens,
      processSpawns: null,
      providerRequests: null,
      feishuReads: null,
      larkReads: null,
    }, {
      stage,
      failureDigest: sha256Text(error instanceof Error ? error.message : String(error)),
      malformedGatewayCaptureLines: captureStats.malformedLineCount,
      observedProviderGatewayAdmissions: captureStats.validLineCount,
      gatewayCaptureObservationVerified: captureStats.verified,
      confirmedFeishuActionReceipts: observed.feishuReads,
      confirmedLarkActionReceipts: observed.larkReads,
      receiptObservationVerified: observed.verified,
      observedLongLivedProcessIdentities: processRecords.length,
      externalAttemptCountsVerified: false,
    })
    let reportPersisted = false
    try {
      rmSync(retainedGatewayCapturePath, { force: true })
      rmSync(redactedEvidencePath, { force: true })
      rmSync(completionMarkerPath, { force: true })
      writeFileSync(reportPath, `${JSON.stringify(safe, null, 2)}\n`)
      reportPersisted = true
    } finally {
      destroySensitiveRuntimeArtifacts({ profilePath, tempPath, rawEvidenceDatabasePath })
      rmSync(sensitiveRunRoot, { recursive: true, force: true })
    }
    process.stdout.write(`${JSON.stringify({
      ...safe,
      reportPath: reportPersisted ? reportPath : null,
      reportPersisted,
    })}\n`)
    process.exitCode = 1
  }
}

function freezeInputs(env) {
  const value = (key) => String(env[key] || '').trim()
  return Object.freeze({
    sourceDatabasePath: resolve(value('READY_CODEX_REAL_DB_PATH')),
    channelId: value('READY_CODEX_E6_CHANNEL_ID'),
    documentToken: value('READY_CODEX_E6_DOC_TOKEN'),
    documentType: value('READY_CODEX_E6_DOC_TYPE'),
    documentRef: value('READY_CODEX_E6_DOC_REF'),
    policyEpoch: Number(value('READY_CODEX_E6_POLICY_EPOCH')),
    feishu: Object.freeze({
      logicalResourceId: value('READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID'),
      currentVersion: value('READY_CODEX_E6_FEISHU_RESOURCE_VERSION'),
      currentDigest: value('READY_CODEX_E6_FEISHU_RESOURCE_DIGEST'),
      expectedAnswer: value('READY_CODEX_E6_FEISHU_EXPECTED_ANSWER'),
    }),
    lark: Object.freeze({
      logicalResourceId: value('READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID'),
      currentVersion: value('READY_CODEX_E6_LARK_RESOURCE_VERSION'),
      currentDigest: value('READY_CODEX_E6_LARK_RESOURCE_DIGEST'),
      expectedAnswer: value('READY_CODEX_E6_LARK_EXPECTED_ANSWER'),
    }),
  })
}

function readEnabledFeishuChannel(sourceDatabasePath, channelId) {
  const rows = sqliteJson(sourceDatabasePath, `
    SELECT id, type, enabled, config_json AS configJson
      FROM agent_channels
     WHERE id = ${sqlQuote(channelId)} AND type = 'feishu-app' AND enabled = 1;
  `)
  return rows.length === 1 ? rows[0] : null
}

function parseTrustedFeishuChannelConfig(configJson) {
  const config = JSON.parse(configJson)
  if (typeof config.appId !== 'string' || !config.appId.trim()
    || typeof config.appSecret !== 'string' || !config.appSecret.trim()) {
    throw new Error('e6_feishu_channel_credentials_missing')
  }
  const baseUrl = String(config.domain || 'https://open.feishu.cn').replace(/\/+$/, '')
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !TRUSTED_FEISHU_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error('e6_feishu_endpoint_untrusted')
  }
  return Object.freeze({
    baseUrl,
    endpointClass: 'official_feishu_https',
    endpointDigest: sha256Canonical(baseUrl),
  })
}

function readTrustedProviderReadiness(sourceDatabasePath) {
  const rows = sqliteJson(sourceDatabasePath, `
    SELECT value FROM settings WHERE key = 'ai_provider_workspace' LIMIT 1;
  `)
  const workspace = JSON.parse(rows[0]?.value || 'null')
  const profile = Array.isArray(workspace?.profiles)
    ? workspace.profiles.find((candidate) => candidate?.id === workspace.activeProfileId)
    : null
  const config = profile?.config
  const extraHeaders = config?.extraHeaders ?? {}
  if (!profile || !config || typeof config.provider !== 'string' || !config.provider.trim()
    || typeof config.model !== 'string' || !config.model.trim()
    || typeof config.baseUrl !== 'string' || !config.baseUrl.trim()
    || /(?:^|[-_])(?:mock|test|fixture)(?:$|[-_])/i.test(
      `${config.provider}\0${config.model}`,
    )
    || !extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)
    || Object.keys(extraHeaders).length !== 0) {
    throw new Error('e6_provider_identity_untrusted')
  }
  return Object.freeze({
    profileId: profile.id,
    providerId: config.provider,
    model: config.model,
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  })
}

function readTrustedLarkCliProvenance() {
  if (!existsSync(TRUSTED_LARK_CLI.payloadPath)
    || sha256File(TRUSTED_LARK_CLI.payloadPath) !== TRUSTED_LARK_CLI.payloadSha256) {
    throw new Error('e6_lark_cli_untrusted')
  }
  const version = execFileSync(TRUSTED_LARK_CLI.payloadPath, ['--version'], {
    encoding: 'utf8',
    env: sanitizedRuntimeEnvironment(process.env),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  }).trim()
  if (version !== TRUSTED_LARK_CLI.version) throw new Error('e6_lark_cli_untrusted')
  return TRUSTED_LARK_CLI
}

function seedFeishuChannel(input) {
  const sourceDatabaseUri = `${pathToFileURL(input.sourceDatabasePath).href}?mode=ro`
  execFileSync(trustedSqlite3Path(), [input.databasePath, `
    CREATE TABLE agent_channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ATTACH DATABASE ${sqlQuote(sourceDatabaseUri)} AS source_db;
    INSERT INTO agent_channels (
      id, type, name, enabled, config_json, last_error, last_seen_at, created_at, updated_at
    ) SELECT id, type, name, enabled, config_json, NULL, NULL, created_at, updated_at
        FROM source_db.agent_channels
       WHERE id = ${sqlQuote(input.channelId)} AND type = 'feishu-app' AND enabled = 1;
    DETACH DATABASE source_db;
  `], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  const rows = sqliteJson(input.databasePath, 'SELECT id, type, enabled FROM agent_channels;')
  if (rows.length !== 1 || rows[0].id !== input.channelId
    || rows[0].type !== 'feishu-app' || rows[0].enabled !== 1) {
    throw new Error('e6_isolated_channel_seed_failed')
  }
}

function assertIsolatedFeishuEndpoint(databasePath, channelId, expected) {
  const rows = sqliteJson(databasePath, `
    SELECT config_json AS configJson FROM agent_channels
     WHERE id = ${sqlQuote(channelId)} AND type = 'feishu-app' AND enabled = 1;
  `)
  if (rows.length !== 1) throw new Error('e6_isolated_feishu_channel_missing')
  const actual = parseTrustedFeishuChannelConfig(rows[0].configJson)
  if (actual.baseUrl !== expected.baseUrl || actual.endpointDigest !== expected.endpointDigest) {
    throw new Error('e6_isolated_feishu_endpoint_drift')
  }
}

function buildExpectedRuns(inputs, larkProvenance) {
  const runs = []
  for (let index = 1; index <= 3; index += 1) {
    runs.push({
      kind: 'feishu_typed_read',
      index,
      scopeId: null,
      expectedAnswer: inputs.feishu.expectedAnswer,
      logicalResourceId: inputs.feishu.logicalResourceId,
      currentVersion: inputs.feishu.currentVersion,
      currentDigest: inputs.feishu.currentDigest,
      policyEpoch: inputs.policyEpoch,
      allowedToolNames: ['feishu_doc_read'],
      callNames: ['feishu_doc_read'],
      channelId: inputs.channelId,
      documentToken: inputs.documentToken,
      documentType: inputs.documentType,
      slice: {
        kind: 'feishu_typed_read',
        channelId: inputs.channelId,
        docToken: inputs.documentToken,
        docType: inputs.documentType,
        logicalResourceId: inputs.feishu.logicalResourceId,
        currentVersion: inputs.feishu.currentVersion,
        currentDigest: inputs.feishu.currentDigest,
        policyEpoch: inputs.policyEpoch,
      },
    })
  }
  for (let index = 1; index <= 3; index += 1) {
    runs.push({
      kind: 'lark_cli_read',
      index,
      scopeId: null,
      expectedAnswer: inputs.lark.expectedAnswer,
      logicalResourceId: inputs.lark.logicalResourceId,
      currentVersion: inputs.lark.currentVersion,
      currentDigest: inputs.lark.currentDigest,
      policyEpoch: inputs.policyEpoch,
      allowedToolNames: ['skill_read_artifact', 'skill_run_shell'],
      callNames: [
        'skill_read_artifact',
        'skill_read_artifact',
        'skill_read_artifact',
        'skill_run_shell',
      ],
      documentRef: inputs.documentRef,
      larkProvenance,
      slice: {
        kind: 'lark_cli_read',
        docRef: inputs.documentRef,
        logicalResourceId: inputs.lark.logicalResourceId,
        currentVersion: inputs.lark.currentVersion,
        currentDigest: inputs.lark.currentDigest,
        policyEpoch: inputs.policyEpoch,
      },
    })
  }
  return runs
}

function externalReadProofExpression(expected) {
  const prompt = expected.kind === 'feishu_typed_read'
    ? '必须先调用本轮唯一授权的 feishu_doc_read。只依据返回内容，找到 ANSWER= 行，只回复等号后的完整值，不要解释，不要使用网页或其他工具。'
    : [
        '必须使用飞书 CLI 完成。依次完整读取以下三份唯一授权方法资源：',
        'lark-doc/SKILL.md、lark-shared/SKILL.md、lark-doc/references/lark-doc-fetch.md。',
        `目标文档引用是 ${expected.documentRef}。`,
        `然后调用 skill_run_shell 执行固定的 docs +fetch --doc ${expected.documentRef} 方法。`,
        '只依据 CLI JSON 结果 data.document.content 中唯一的 ANSWER= 行，只回复等号后的完整值，不要解释，不要使用网页或其他方法。',
      ].join('')
  return `(async () => {
    let stage = 'bootstrap'
    try {
      const harness = window.__READY_AGENT_TEST__
      if (!harness?.submit || !harness?.createVisibleSession) {
        return { ok: false, stage, error: 'e6_harness_unavailable' }
      }
      stage = 'create-session'
      const created = await harness.createVisibleSession()
      if (!created.ok) return { ok: false, stage, error: 'e6_session_create_failed' }
      const scopeId = harness.sessionSummary().currentScopeId
      harness.clearEvents()
      const traceStart = (await harness.snapshot()).toolTrace.length
      stage = 'submit'
      const submission = await harness.submit(${JSON.stringify(prompt)}, {
        mode: 'store',
        allowStoreFallback: false,
        timeoutMs: 600000,
        pollMs: 200,
        expectedToolNames: ${JSON.stringify(expected.callNames)},
        codexExternalReadSlice: ${JSON.stringify(expected.slice)},
      })
      const calls = submission.after.toolTrace.slice(traceStart)
        .filter((entry) => entry.kind === 'call')
        .map((entry) => String(entry.text || '').match(/^([a-zA-Z0-9_:-]+)/)?.[1] || '')
        .filter(Boolean)
      const finalText = String(submission.after.messages
        .filter((message) => message.type !== 'user').at(-1)?.content || '').trim()
      const diagnostics = submission.diagnostics
        .filter((item) => item.severity === 'error')
        .map((item) => item.id)
      return {
        ok: submission.ok && diagnostics.length === 0
          && finalText === ${JSON.stringify(expected.expectedAnswer)},
        kind: ${JSON.stringify(expected.kind)},
        index: ${expected.index},
        scopeId,
        finalText,
        expectedAnswer: ${JSON.stringify(expected.expectedAnswer)},
        toolCalls: calls,
        diagnostics,
      }
    } catch (error) {
      return { ok: false, stage, error: 'e6_renderer_expression_failed' }
    }
  })()`
}

function scrubRuntimeCredentials(databasePath) {
  execFileSync(trustedSqlite3Path(), [databasePath, `
    PRAGMA journal_mode = DELETE;
    UPDATE agent_channels SET config_json = '{}', last_error = NULL, last_seen_at = NULL;
    VACUUM;
  `], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  const rows = sqliteJson(databasePath, 'SELECT config_json AS configJson FROM agent_channels;')
  if (rows.length !== 1 || rows[0].configJson !== '{}') {
    throw new Error('e6_runtime_credentials_not_scrubbed')
  }
}

function destroySensitiveRuntimeArtifacts(paths) {
  let firstError = null
  for (const path of [paths.rawEvidenceDatabasePath, paths.profilePath, paths.tempPath].filter(Boolean)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (error) {
      if (!firstError) firstError = error
    }
  }
  if (firstError) throw firstError
}

function mergeProcessRecords(current, added) {
  const byIdentity = new Map(current.map((row) => [row.processStartIdentity, row]))
  for (const row of added) byIdentity.set(row.processStartIdentity, row)
  return [...byIdentity.values()]
}

function captureVerifiedProofProcesses(rootProcessRecord, census = captureProcessCensus()) {
  if (!rootProcessRecord || !Number.isSafeInteger(rootProcessRecord.pid)
    || rootProcessRecord.pid <= 1
    || rootProcessRecord.processGroupId !== rootProcessRecord.pid) {
    throw new Error('e6_root_process_identity_unavailable')
  }
  const currentRoot = census.find((row) => row.pid === rootProcessRecord.pid)
  if (currentRoot && (currentRoot.processStartIdentity !== rootProcessRecord.processStartIdentity
    || currentRoot.command !== rootProcessRecord.command
    || currentRoot.processGroupId !== rootProcessRecord.processGroupId)) {
    throw new Error('e6_root_process_identity_changed')
  }
  return census.filter((row) => row.processGroupId === rootProcessRecord.processGroupId)
}

function trustedSidecarRuntimeExpectation(runtimeManifest) {
  const executablePath = resolve(
    ROOT,
    'build/codex',
    String(runtimeManifest.targetTriple || ''),
    'codex',
  )
  const stats = lstatSync(executablePath)
  if (!stats.isFile() || stats.isSymbolicLink()
    || !/^[a-f0-9]{64}$/.test(String(runtimeManifest.binarySha256 || ''))
    || sha256File(executablePath) !== runtimeManifest.binarySha256) {
    throw new Error('e6_sidecar_runtime_identity_mismatch')
  }
  return Object.freeze({
    runtimeManifestDigest: sha256Canonical(runtimeManifest),
    binarySha256: runtimeManifest.binarySha256,
    executablePath,
    fileIdentity: Object.freeze({
      device: String(stats.dev),
      inode: String(stats.ino),
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    }),
  })
}

function assertCurrentSidecarRuntimeIdentity(expectedRuntime) {
  if (!expectedRuntime?.executablePath || !expectedRuntime.fileIdentity) {
    throw new Error('e6_sidecar_runtime_identity_missing')
  }
  const stats = lstatSync(expectedRuntime.executablePath)
  const current = {
    device: String(stats.dev),
    inode: String(stats.ino),
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  }
  if (!stats.isFile() || stats.isSymbolicLink()
    || sha256Canonical(current) !== sha256Canonical(expectedRuntime.fileIdentity)
    || sha256File(expectedRuntime.executablePath) !== expectedRuntime.binarySha256) {
    throw new Error('e6_sidecar_runtime_identity_changed')
  }
}

function processEnvironmentMarker(command, key) {
  const prefix = `${key}=`
  const start = command.indexOf(prefix)
  if (start < 0) return null
  const rest = command.slice(start + prefix.length)
  const boundary = /\s[A-Z_][A-Z0-9_]*=/.exec(rest)
  return (boundary ? rest.slice(0, boundary.index) : rest).trim() || null
}

function processExecutablePath(command) {
  const token = command.match(/^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/)
  return token?.[1] || token?.[2] || token?.[3] || ''
}

function selectMarkedPreCasCandidate(marked, expectedRuntime) {
  const candidates = marked.filter((row) => (
    processExecutablePath(row.command) === expectedRuntime.executablePath
      && row.processGroupId === row.pid
  ))
  if (candidates.length > 1) throw new Error('e6_pre_cas_sidecar_ambiguous')
  const candidate = candidates[0] || null
  if ((marked.length > 0 && !candidate)
    || (candidate && marked.some((row) => row.processGroupId !== candidate.processGroupId))) {
    throw new Error('e6_pre_cas_sidecar_identity_mismatch')
  }
  return candidate ? [candidate] : []
}

function markedPreCasCandidates(lease, expectedRuntime) {
  return selectMarkedPreCasCandidate(
    captureProcessCensus({ includeEnvironment: true }).filter((row) => (
      processHasExactLeaseMarkers(row, lease)
    )),
    expectedRuntime,
  )
}

function processHasExactLeaseMarkers(row, lease) {
  return processEnvironmentMarker(row.command, 'READY_CODEX_PROCESS_LEASE_ID')
      === lease.processLeaseId
    && processEnvironmentMarker(row.command, 'READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID')
      === lease.sidecarSpawnInstanceId
    && processEnvironmentMarker(row.command, 'READY_CODEX_CONNECTION_EPOCH')
      === lease.connectionEpoch
    && processEnvironmentMarker(row.command, 'READY_CODEX_STATE_DIR')
      === lease.isolatedStateDir
}

async function settleAbandonedPreCasSidecarLeases(databasePath, expectedOwnerRoot, expectedRuntime) {
  if (!existsSync(databasePath)) return
  const table = sqliteJson(databasePath, `
    SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'table' AND name = 'codex_sidecar_process_leases';
  `)
  if (Number(table[0]?.count || 0) === 0) return
  const leases = sqliteJson(databasePath, `
    SELECT process_lease_id AS processLeaseId,
           sidecar_spawn_instance_id AS sidecarSpawnInstanceId,
           connection_epoch AS connectionEpoch,
           isolated_state_dir AS isolatedStateDir,
           owner_main_pid AS ownerMainPid,
           owner_main_process_start_identity AS ownerMainProcessStartIdentity,
           runtime_manifest_digest AS runtimeManifestDigest,
           binary_sha256 AS binarySha256,
           executable_path AS executablePath,
           spawn_visibility_deadline_at AS spawnVisibilityDeadlineAt,
           revision
      FROM codex_sidecar_process_leases
     WHERE pid IS NULL AND process_group_id IS NULL
       AND process_start_identity IS NULL AND tree_zero_at IS NULL;
  `)
  for (const lease of leases) {
    if (lease.ownerMainPid !== expectedOwnerRoot.pid
      || lease.ownerMainProcessStartIdentity !== expectedOwnerRoot.processStartIdentity
      || lease.runtimeManifestDigest !== expectedRuntime.runtimeManifestDigest
      || lease.binarySha256 !== expectedRuntime.binarySha256
      || lease.executablePath !== expectedRuntime.executablePath) {
      throw new Error('e6_pre_cas_sidecar_lease_identity_mismatch')
    }
    const visibilityWait = Date.parse(lease.spawnVisibilityDeadlineAt) - Date.now()
    if (!Number.isFinite(visibilityWait) || visibilityWait > 5_000) {
      throw new Error('e6_pre_cas_sidecar_visibility_deadline_invalid')
    }
    if (visibilityWait > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, visibilityWait))
    }
    let candidate = null
    let consecutiveZero = 0
    const transcript = []
    for (let observation = 0; observation < 40; observation += 1) {
      const candidates = markedPreCasCandidates(lease, expectedRuntime)
      transcript.push(candidates.map((row) => row.processStartIdentity).sort())
      if (candidates.length === 1) {
        candidate = candidates[0]
        break
      }
      consecutiveZero += 1
      if (consecutiveZero === 4) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
    if (!candidate && consecutiveZero < 4) {
      throw new Error('e6_pre_cas_sidecar_zero_unproven')
    }
    if (candidate) {
      try { process.kill(candidate.pid, 'SIGSTOP') } catch {
        // The following exact-group zero proof resolves an exit during freeze.
      }
      await terminateRecordedProcesses([candidate], new Set([candidate.processGroupId]))
      await assertOwnedProcessGroupsZero(new Set([candidate.processGroupId]), {
        timeoutMs: 10_000,
      })
    }
    const now = new Date().toISOString()
    const transcriptDigest = sha256Canonical(transcript)
    const evidenceDigest = sha256Canonical({
      processLeaseId: lease.processLeaseId,
      matcherMode: candidate ? 'post_cas' : 'pre_cas',
      transcriptDigest,
      recoveredBy: 'e6_abandoned_runner',
    })
    const ownership = candidate ? `
             pid = ${candidate.pid},
             process_group_id = ${candidate.processGroupId},
             process_start_identity = ${sqlQuote(candidate.processStartIdentity)},
             ownership_confirmed_at = ${sqlQuote(now)},
             closed_at = ${sqlQuote(now)},` : ''
    const raw = execFileSync(trustedSqlite3Path(), ['-json', databasePath, `
      BEGIN IMMEDIATE;
      UPDATE codex_sidecar_process_leases
         SET ${ownership}
             tree_zero_at = ${sqlQuote(now)},
             tree_zero_matcher_mode = ${sqlQuote(candidate ? 'post_cas' : 'pre_cas')},
             stable_zero_sample_transcript_digest = ${sqlQuote(transcriptDigest)},
             tree_zero_evidence_digest = ${sqlQuote(evidenceDigest)},
             revision = revision + 1
       WHERE process_lease_id = ${sqlQuote(lease.processLeaseId)}
         AND revision = ${Number(lease.revision)}
         AND pid IS NULL AND tree_zero_at IS NULL;
      SELECT changes() AS changes;
      COMMIT;
    `], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
    const changes = raw ? JSON.parse(raw) : []
    if (Number(changes[0]?.changes || 0) !== 1) {
      throw new Error('e6_pre_cas_sidecar_recovery_cas_failed')
    }
  }
}

function readSidecarCleanupState(databasePath, expectedOwnerRoot = null, expectedRuntime = null) {
  if (!existsSync(databasePath)) {
    return { leases: [], processRecords: [], ownedProcessGroupIds: [], treeZeroConfirmed: true }
  }
  const table = sqliteJson(databasePath, `
    SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'table' AND name = 'codex_sidecar_process_leases';
  `)
  if (Number(table[0]?.count || 0) === 0) {
    return { leases: [], processRecords: [], ownedProcessGroupIds: [], treeZeroConfirmed: true }
  }
  const leases = sqliteJson(databasePath, `
    SELECT process_lease_id AS processLeaseId,
           sidecar_spawn_instance_id AS sidecarSpawnInstanceId,
           connection_epoch AS connectionEpoch,
           isolated_state_dir AS isolatedStateDir, pid,
           process_group_id AS processGroupId,
           process_start_identity AS processStartIdentity,
           runtime_manifest_digest AS runtimeManifestDigest,
           binary_sha256 AS binarySha256,
           executable_path AS executablePath,
           owner_main_pid AS ownerMainPid,
           owner_main_process_start_identity AS ownerMainProcessStartIdentity,
           closed_at AS closedAt, tree_zero_at AS treeZeroAt,
           tree_zero_evidence_digest AS treeZeroEvidenceDigest
      FROM codex_sidecar_process_leases ORDER BY spawn_intent_at;
  `)
  assertCurrentSidecarRuntimeIdentity(expectedRuntime)
  const census = captureProcessCensus({ includeEnvironment: true })
  const currentByPid = new Map(census.map((row) => [row.pid, row]))
  const processRecords = []
  const ownedProcessGroupIds = new Set()
  for (const lease of leases) {
    if (!expectedOwnerRoot
      || lease.ownerMainPid !== expectedOwnerRoot.pid
      || lease.ownerMainProcessStartIdentity !== expectedOwnerRoot.processStartIdentity) {
      throw new Error('e6_sidecar_lease_owner_mismatch')
    }
    if (!expectedRuntime
      || lease.runtimeManifestDigest !== expectedRuntime.runtimeManifestDigest
      || lease.binarySha256 !== expectedRuntime.binarySha256
      || lease.executablePath !== expectedRuntime.executablePath) {
      throw new Error('e6_sidecar_lease_runtime_mismatch')
    }
    const preCas = lease.pid === null && lease.processGroupId === null
      && lease.processStartIdentity === null
    if (preCas) {
      if (lease.closedAt && lease.treeZeroAt && lease.treeZeroEvidenceDigest) continue
      const detached = captureDetachedDescendantProcessGroups(expectedOwnerRoot, census)
      const matchingGroups = new Set(detached.records.filter((row) => (
        row.command === expectedRuntime.executablePath
          || row.command.startsWith(`${expectedRuntime.executablePath} `)
      )).map((row) => row.processGroupId))
      for (const groupId of matchingGroups) ownedProcessGroupIds.add(groupId)
      processRecords.push(...detached.records.filter(
        (row) => matchingGroups.has(row.processGroupId),
      ))
      continue
    }
    if (!Number.isSafeInteger(lease.pid) || lease.pid <= 1
      || !Number.isSafeInteger(lease.processGroupId) || lease.processGroupId <= 1
      || !lease.processStartIdentity) {
      throw new Error('e6_sidecar_lease_process_identity_missing')
    }
    if (lease.processGroupId !== lease.pid) {
      throw new Error('e6_sidecar_lease_process_group_mismatch')
    }
    const current = currentByPid.get(lease.pid)
    const groupRecords = census.filter((row) => row.processGroupId === lease.processGroupId)
    if (current && (current.processStartIdentity !== lease.processStartIdentity
      || processExecutablePath(current.command) !== lease.executablePath
      || !processHasExactLeaseMarkers(current, lease))) {
      throw new Error('e6_sidecar_lease_process_identity_mismatch')
    }
    if (current && current.processGroupId !== lease.processGroupId) {
      throw new Error('e6_sidecar_lease_process_group_mismatch')
    }
    if (lease.closedAt && lease.treeZeroAt && lease.treeZeroEvidenceDigest) {
      if (groupRecords.length > 0) throw new Error('e6_closed_sidecar_lease_group_not_zero')
      continue
    }
    if (groupRecords.some((row) => !processHasExactLeaseMarkers(row, lease))) {
      throw new Error('e6_sidecar_lease_process_marker_mismatch')
    }
    ownedProcessGroupIds.add(lease.processGroupId)
    if (groupRecords.length > 0) processRecords.push(...groupRecords)
  }
  return {
    leases,
    processRecords: mergeProcessRecords([], processRecords),
    ownedProcessGroupIds: [...ownedProcessGroupIds],
    treeZeroConfirmed: leases.every((lease) => lease.closedAt
      && lease.treeZeroAt && lease.treeZeroEvidenceDigest),
  }
}

async function waitForSidecarLeaseTreeZero(
  databasePath,
  expectedOwnerRoot,
  expectedRuntime,
  onRecords,
  onGroups,
) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const state = readSidecarCleanupState(databasePath, expectedOwnerRoot, expectedRuntime)
    onRecords(state.processRecords)
    onGroups(state.ownedProcessGroupIds)
    if (state.treeZeroConfirmed && state.processRecords.length === 0) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return false
}

async function assertOwnedProcessGroupsZero(ownedProcessGroupIds, options = {}) {
  const ownedGroups = new Set([...ownedProcessGroupIds].filter(
    (groupId) => Number.isSafeInteger(groupId) && groupId > 1,
  ))
  if (ownedGroups.size === 0) return
  const initialCensus = captureProcessCensus()
  const currentByPid = new Map(initialCensus.map((row) => [row.pid, row]))
  const protectedPids = new Set([process.pid])
  let ancestor = currentByPid.get(process.pid)
  while (ancestor && ancestor.parentPid > 1 && !protectedPids.has(ancestor.parentPid)) {
    protectedPids.add(ancestor.parentPid)
    ancestor = currentByPid.get(ancestor.parentPid)
  }
  const protectedGroups = new Set(initialCensus
    .filter((row) => protectedPids.has(row.pid))
    .map((row) => row.processGroupId))
  if ([...ownedGroups].some((groupId) => protectedGroups.has(groupId))) {
    throw new Error('e6_owned_process_group_conflicts_with_runner')
  }
  const deadline = Date.now() + (options.timeoutMs || 10_000)
  let stableZeroSamples = 0
  let remaining = []
  while (Date.now() < deadline) {
    remaining = captureProcessCensus().filter((row) => (
      row.pid > 1 && ownedGroups.has(row.processGroupId)
    ))
    if (remaining.length === 0) {
      stableZeroSamples += 1
      if (stableZeroSamples >= 3) return
    } else {
      stableZeroSamples = 0
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`e6_owned_process_groups_not_zero:${sha256Canonical(
    remaining.map((row) => row.processStartIdentity).sort(),
  )}`)
}

async function terminateRecordedProcesses(records, ownedProcessGroupIds) {
  const ownedGroups = new Set([...ownedProcessGroupIds].filter(
    (groupId) => Number.isSafeInteger(groupId) && groupId > 1,
  ))
  if (ownedGroups.size === 0) throw new Error('e6_cleanup_group_identity_missing')
  const census = captureProcessCensus()
  const currentByPid = new Map(census.map((row) => [row.pid, row]))
  const protectedPids = new Set([process.pid])
  let ancestor = currentByPid.get(process.pid)
  while (ancestor && ancestor.parentPid > 1 && !protectedPids.has(ancestor.parentPid)) {
    protectedPids.add(ancestor.parentPid)
    ancestor = currentByPid.get(ancestor.parentPid)
  }
  let observed = [...records]
  const startedAt = Date.now()
  const deadline = startedAt + 10_000
  while (Date.now() < deadline) {
    const liveOwned = captureProcessCensus().filter((row) => (
      row.pid > 1 && !protectedPids.has(row.pid) && ownedGroups.has(row.processGroupId)
    ))
    if (liveOwned.length === 0) return
    observed = mergeProcessRecords(observed, liveOwned)
    const signal = Date.now() - startedAt >= 1_000 ? 'SIGKILL' : 'SIGTERM'
    for (const row of liveOwned.sort((left, right) => right.pid - left.pid)) {
      try { process.kill(row.pid, signal) } catch {
        // The exact owned process exited between census and signal.
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  const remaining = captureProcessCensus().filter((row) => (
    row.pid > 1 && !protectedPids.has(row.pid) && ownedGroups.has(row.processGroupId)
  ))
  if (remaining.length > 0) {
    throw new Error(`e6_owned_process_groups_not_zero:${sha256Canonical(
      mergeProcessRecords(observed, remaining).map((row) => row.processStartIdentity).sort(),
    )}`)
  }
}

function writeSensitiveRootMarker(rootPath, proofId) {
  const current = captureProcessCensus().find((row) => row.pid === process.pid)
  if (!current || statSync(rootPath).uid !== process.getuid()) {
    throw new Error('e6_sensitive_root_owner_unavailable')
  }
  writeSensitiveMarkerAtomic(rootPath, {
    schemaVersion: 2,
    proofId,
    ownerUid: process.getuid(),
    ownerPid: process.pid,
    ownerProcessStartIdentity: current.processStartIdentity,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processRoots: [],
    spawnIntents: [],
    sidecarRuntime: null,
  })
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function initializeSensitiveRunRoot(rootPath, proofId) {
  const stagingPath = resolve(
    E6_AUTHORITY_ROOT,
    `ready-codex-e6-staging-${proofId}-${process.pid}`,
  )
  if (existsSync(rootPath) || existsSync(stagingPath)) {
    throw new Error('e6_sensitive_root_already_exists')
  }
  mkdirSync(stagingPath, { mode: 0o700 })
  try {
    writeSensitiveRootMarker(stagingPath, proofId)
    renameSync(stagingPath, rootPath)
    fsyncDirectory(E6_AUTHORITY_ROOT)
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true })
    throw error
  }
}

function updateSensitiveRootMarker(rootPath, proofId, update) {
  const markerPath = resolve(rootPath, 'e6-owner.json')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  const current = captureProcessCensus().find((row) => row.pid === process.pid)
  if (marker?.schemaVersion !== 2 || marker.proofId !== proofId
    || marker.ownerUid !== process.getuid() || marker.ownerPid !== process.pid
    || !current || current.processStartIdentity !== marker.ownerProcessStartIdentity) {
    throw new Error('e6_sensitive_root_marker_owner_mismatch')
  }
  writeSensitiveMarkerAtomic(rootPath, {
    ...marker,
    ...update,
    updatedAt: new Date().toISOString(),
  })
}

function writeSensitiveMarkerAtomic(rootPath, value) {
  const markerPath = resolve(rootPath, 'e6-owner.json')
  const temporaryPath = resolve(rootPath, `.e6-owner-${process.pid}.tmp`)
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  const fileDescriptor = openSync(temporaryPath, 'r')
  try { fsyncSync(fileDescriptor) } finally { closeSync(fileDescriptor) }
  renameSync(temporaryPath, markerPath)
  fsyncDirectory(rootPath)
}

function recoverAbandonedSensitiveRootStagingDirectories() {
  const ownerUid = process.getuid()
  const census = captureProcessCensus()
  for (const entry of readdirSync(E6_AUTHORITY_ROOT, { withFileTypes: true })) {
    const match = entry.name.match(/^ready-codex-e6-staging-([a-f0-9]{40})-([1-9]\d*)$/)
    if (!match) continue
    const proofId = match[1]
    const ownerPid = Number(match[2])
    const stagingPath = resolve(E6_AUTHORITY_ROOT, entry.name)
    const finalPath = resolve(E6_AUTHORITY_ROOT, `ready-codex-e6-${proofId}`)
    try {
      const stats = lstatSync(stagingPath)
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== ownerUid
        || (stats.mode & 0o777) !== 0o700) {
        throw new Error('e6_abandoned_staging_root_identity_invalid')
      }
      if (census.some((row) => row.pid === ownerPid)) continue
      const children = readdirSync(stagingPath, { withFileTypes: true })
      const marker = children.find((child) => child.name === 'e6-owner.json')
      if (marker) {
        if (children.length !== 1 || !marker.isFile() || marker.isSymbolicLink()
          || existsSync(finalPath)) {
          throw new Error('e6_abandoned_staging_root_contents_invalid')
        }
        const markerPath = resolve(stagingPath, marker.name)
        const markerStats = lstatSync(markerPath)
        const value = JSON.parse(readFileSync(markerPath, 'utf8'))
        if (!markerStats.isFile() || markerStats.isSymbolicLink()
          || markerStats.uid !== ownerUid || (markerStats.mode & 0o777) !== 0o600
          || value?.schemaVersion !== 2 || value.proofId !== proofId
          || value.ownerUid !== ownerUid || value.ownerPid !== ownerPid
          || typeof value.ownerProcessStartIdentity !== 'string') {
          throw new Error('e6_abandoned_staging_marker_invalid')
        }
        renameSync(stagingPath, finalPath)
        fsyncDirectory(E6_AUTHORITY_ROOT)
        continue
      }
      const temporaryName = `.e6-owner-${ownerPid}.tmp`
      if (children.length > 1
        || (children.length === 1 && children[0].name !== temporaryName)) {
        throw new Error('e6_abandoned_staging_root_contents_invalid')
      }
      if (children.length === 1) {
        const temporaryStats = lstatSync(resolve(stagingPath, temporaryName))
        if (!temporaryStats.isFile() || temporaryStats.isSymbolicLink()
          || temporaryStats.uid !== ownerUid
          || (temporaryStats.mode & 0o777) !== 0o600) {
          throw new Error('e6_abandoned_staging_marker_invalid')
        }
      }
      rmSync(stagingPath, { recursive: true, force: false })
      fsyncDirectory(E6_AUTHORITY_ROOT)
    } catch (error) {
      throw new Error('e6_abandoned_sensitive_root_staging_recovery_failed', { cause: error })
    }
  }
}

function recoverMainRootFromSidecarLeases(databasePath, marker, census) {
  if (!existsSync(databasePath)) return null
  const table = sqliteJson(databasePath, `
    SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'table' AND name = 'codex_sidecar_process_leases';
  `)
  if (Number(table[0]?.count || 0) === 0) return null
  const leases = sqliteJson(databasePath, `
    SELECT DISTINCT owner_main_pid AS ownerMainPid,
           owner_main_process_start_identity AS ownerMainProcessStartIdentity,
           runtime_manifest_digest AS runtimeManifestDigest,
           binary_sha256 AS binarySha256,
           executable_path AS executablePath
      FROM codex_sidecar_process_leases;
  `)
  if (leases.length === 0) return null
  const mainIntent = marker.spawnIntents.find((intent) => intent.kind === 'main')
  if (!mainIntent || !marker.sidecarRuntime || leases.length !== 1) {
    throw new Error('e6_abandoned_main_lease_identity_missing')
  }
  assertCurrentSidecarRuntimeIdentity(marker.sidecarRuntime)
  const lease = leases[0]
  if (!Number.isSafeInteger(lease.ownerMainPid) || lease.ownerMainPid <= 1
    || typeof lease.ownerMainProcessStartIdentity !== 'string'
    || lease.runtimeManifestDigest !== marker.sidecarRuntime.runtimeManifestDigest
    || lease.binarySha256 !== marker.sidecarRuntime.binarySha256
    || lease.executablePath !== marker.sidecarRuntime.executablePath) {
    throw new Error('e6_abandoned_main_lease_identity_invalid')
  }
  const currentOwner = census.find((row) => row.pid === lease.ownerMainPid)
  if (currentOwner?.processStartIdentity === lease.ownerMainProcessStartIdentity) {
    throw new Error('e6_abandoned_main_lease_owner_still_live')
  }
  return {
    kind: 'main',
    pid: lease.ownerMainPid,
    processGroupId: lease.ownerMainPid,
    processStartIdentity: lease.ownerMainProcessStartIdentity,
    command: `${mainIntent.executablePath} ${mainIntent.identityArgument}`,
  }
}

function assertSensitiveSpawnIntents(marker) {
  if (!Array.isArray(marker.spawnIntents)) {
    throw new Error('e6_abandoned_spawn_intents_missing')
  }
  const seenKinds = new Set()
  for (const intent of marker.spawnIntents) {
    const expectedArgument = intent?.kind === 'build'
      ? `ready-codex-e6-build-${marker.proofId}`
      : `--ready-e6-proof-id=${marker.proofId}`
    if (!['build', 'main'].includes(intent?.kind)
      || seenKinds.has(intent.kind)
      || typeof intent.executablePath !== 'string' || !isAbsolute(intent.executablePath)
      || intent.identityArgument !== expectedArgument) {
      throw new Error('e6_abandoned_spawn_intent_invalid')
    }
    seenKinds.add(intent.kind)
  }
  return marker.spawnIntents
}

function commandContainsExactArgument(command, argument) {
  const escaped = argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(command)
}

async function captureSpawnIntentRoots(marker) {
  const intents = assertSensitiveSpawnIntents(marker)
  const roots = new Map()
  let census = []
  for (let sample = 0; sample < 3; sample += 1) {
    census = captureProcessCensus()
    for (const intent of intents) {
      const candidates = census.filter((row) => (
        row.pid > 1
        && row.processGroupId === row.pid
        && (row.command === intent.executablePath
          || row.command.startsWith(`${intent.executablePath} `))
        && commandContainsExactArgument(row.command, intent.identityArgument)
      ))
      if (candidates.length > 1) throw new Error('e6_abandoned_spawn_intent_ambiguous')
      if (candidates.length === 1) {
        const row = candidates[0]
        roots.set(row.pid, { ...row, kind: intent.kind })
        try { process.kill(row.pid, 'SIGSTOP') } catch {
          // A process that exits during capture is verified absent by the next sample.
        }
      }
    }
    if (sample < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return { census: captureProcessCensus(), roots: [...roots.values()] }
}

async function cleanupAbandonedSensitiveRoots(options = {}) {
  const preserveRoot = typeof options.preserveRoot === 'function'
    ? options.preserveRoot
    : () => false
  const prefix = 'ready-codex-e6-'
  const ownerUid = process.getuid()
  recoverAbandonedSensitiveRootStagingDirectories()
  for (const entry of readdirSync(E6_AUTHORITY_ROOT, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !/^[a-f0-9]{40}$/.test(entry.name.slice(prefix.length))) continue
    const rootPath = resolve(E6_AUTHORITY_ROOT, entry.name)
    const markerPath = resolve(rootPath, 'e6-owner.json')
    try {
      const rootStats = lstatSync(rootPath)
      const markerStats = lstatSync(markerPath)
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || rootStats.uid !== ownerUid
        || !markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.uid !== ownerUid) {
        throw new Error('e6_abandoned_sensitive_root_identity_invalid')
      }
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      if (marker?.schemaVersion !== 2 || marker.ownerUid !== ownerUid
        || marker.proofId !== entry.name.slice(prefix.length)
        || !Number.isSafeInteger(marker.ownerPid)
        || typeof marker.ownerProcessStartIdentity !== 'string'
        || !Array.isArray(marker.processRoots)) {
        throw new Error('e6_abandoned_sensitive_root_marker_invalid')
      }
      assertSensitiveSpawnIntents(marker)
      let initialCensus = captureProcessCensus()
      const live = initialCensus.find((row) => row.pid === marker.ownerPid)
      if (live?.processStartIdentity === marker.ownerProcessStartIdentity) continue
      const intentCapture = await captureSpawnIntentRoots(marker)
      initialCensus = intentCapture.census
      const recordedRoots = [...marker.processRoots]
      for (const intentRoot of intentCapture.roots) {
        if (!recordedRoots.some((row) => row.pid === intentRoot.pid)) recordedRoots.push(intentRoot)
      }
      const databasePath = resolve(rootPath, 'profile/ready.db')
      if (!recordedRoots.some((recorded) => recorded.kind === 'main')) {
        const recoveredMainRoot = recoverMainRootFromSidecarLeases(
          databasePath,
          marker,
          initialCensus,
        )
        if (recoveredMainRoot) recordedRoots.push(recoveredMainRoot)
      }
      if (recordedRoots.length === 0) {
        if (!preserveRoot(marker, rootPath)) rmSync(rootPath, { recursive: true, force: true })
        continue
      }
      if (recordedRoots.some((row) => row.kind !== 'build') && !marker.sidecarRuntime) {
        throw new Error('e6_abandoned_sensitive_root_runtime_missing')
      }
      if (marker.sidecarRuntime) assertCurrentSidecarRuntimeIdentity(marker.sidecarRuntime)
      const ownedGroups = new Set()
      let processRecords = []
      let mainWasLive = false
      for (const recorded of recordedRoots) {
        if (!['build', 'main', 'sidecar'].includes(recorded?.kind)
          || !Number.isSafeInteger(recorded.pid) || recorded.pid <= 1
          || !Number.isSafeInteger(recorded.processGroupId) || recorded.processGroupId <= 1
          || typeof recorded.processStartIdentity !== 'string'
          || typeof recorded.command !== 'string') {
          throw new Error('e6_abandoned_process_root_invalid')
        }
        const current = initialCensus.find((row) => row.pid === recorded.pid)
        if (!current) continue
        if (current.processStartIdentity !== recorded.processStartIdentity
          || current.processGroupId !== recorded.processGroupId
          || current.command !== recorded.command) {
          throw new Error('e6_abandoned_process_root_reused')
        }
        process.kill(recorded.pid, 'SIGSTOP')
        if (recorded.kind === 'main') mainWasLive = true
        ownedGroups.add(recorded.processGroupId)
      }
      const frozenCensus = captureProcessCensus()
      const mainRoot = recordedRoots.find((recorded) => recorded.kind === 'main') || null
      if (mainRoot && frozenCensus.some((row) => row.pid === mainRoot.pid
        && row.processStartIdentity === mainRoot.processStartIdentity)) {
        const detached = captureDetachedDescendantProcessGroups(mainRoot, frozenCensus)
        for (const groupId of detached.groupIds) ownedGroups.add(groupId)
        processRecords = mergeProcessRecords(processRecords, detached.records)
      }
      processRecords = mergeProcessRecords(processRecords, frozenCensus.filter(
        (row) => ownedGroups.has(row.processGroupId),
      ))
      let leaseState = null
      try {
        if (mainRoot && existsSync(databasePath)) {
          await settleAbandonedPreCasSidecarLeases(
            databasePath,
            mainRoot,
            marker.sidecarRuntime,
          )
          leaseState = readSidecarCleanupState(databasePath, mainRoot, marker.sidecarRuntime)
          processRecords = mergeProcessRecords(processRecords, leaseState.processRecords)
          for (const groupId of leaseState.ownedProcessGroupIds) ownedGroups.add(groupId)
        }
      } catch (error) {
        if (!mainWasLive) throw error
      }
      if (!mainWasLive && leaseState?.leases.some((lease) => (
        lease.pid === null && !lease.treeZeroAt
      ))) {
        throw new Error('e6_abandoned_pre_cas_process_unresolved')
      }
      if (ownedGroups.size > 0) {
        await terminateRecordedProcesses(processRecords, ownedGroups)
        await assertOwnedProcessGroupsZero(ownedGroups, { timeoutMs: 10_000 })
      }
      if (!preserveRoot(marker, rootPath)) rmSync(rootPath, { recursive: true, force: true })
    } catch (error) {
      throw new Error('e6_abandoned_sensitive_root_recovery_failed', { cause: error })
    }
  }
}

function safeFailure(code, plan, effects = {}, details = {}) {
  return {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: 'typed-and-cli-3-plus-3',
    ok: false,
    code,
    validatedPlanDigest: plan.validatedPlanDigest,
    effects: {
      providerRequests: 0,
      feishuReads: 0,
      larkReads: 0,
      sourceDatabaseOpens: 0,
      sourceDatabaseWrites: 0,
      processSpawns: 0,
      ...effects,
    },
    details,
    credentialSafety: {
      opaqueValuesEmitted: false,
      sensitiveFieldsEmitted: [],
    },
  }
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function pushLogs(target, chunk) {
  target.push(...String(chunk).split(/\r?\n/).filter(Boolean))
  if (target.length > 500) target.splice(0, target.length - 500)
}

async function emergencyExit(code, reason, error = null) {
  if (emergencyCleanupStarted) return
  emergencyCleanupStarted = true
  let cleanupError = null
  try { await activeEmergencyCleanup() } catch (caught) {
    cleanupError = caught
  }
  if (error || cleanupError) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      phase: 'E6',
      code: reason,
      failureDigest: sha256Text(
        (error || cleanupError) instanceof Error
          ? (error || cleanupError).message
          : String(error || cleanupError),
      ),
      failureCauseDigest: (error || cleanupError)?.cause instanceof Error
        ? sha256Text((error || cleanupError).cause.message)
        : null,
      recoveryPending: cleanupError !== null,
    })}\n`)
  }
  process.exit(code)
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  process.once('SIGINT', () => { void emergencyExit(130, 'e6_interrupted') })
  process.once('SIGTERM', () => { void emergencyExit(143, 'e6_terminated') })
  process.once('uncaughtException', (error) => { void emergencyExit(1, 'e6_uncaught_exception', error) })
  process.once('unhandledRejection', (error) => { void emergencyExit(1, 'e6_unhandled_rejection', error) })
  try {
    await main()
  } catch (error) {
    await emergencyExit(1, 'e6_unhandled_main_failure', error)
  } finally {
    try { await releaseE6GlobalLease(activeGlobalLease) } catch {
      // Closing the parent process also closes the helper pipe and releases the kernel lease.
    }
  }
}

export {
  TRUSTED_PROVIDER_HOSTS,
  assertOwnedProcessGroupsZero,
  cleanupAbandonedSensitiveRoots,
  initializeSensitiveRunRoot,
  readSidecarCleanupState,
  readTrustedProviderReadiness,
  selectMarkedPreCasCandidate,
  terminateRecordedProcesses,
  trustedSidecarRuntimeExpectation,
  updateSensitiveRootMarker,
}
