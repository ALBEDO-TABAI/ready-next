// Turns one continuity probe run (scripts/probe-codex-runtime-continuity.mjs, run on isolated copies of real Ready
// histories) into the runtime-continuity assets for the current pinned runtime: one transition proof per source and
// operation, the transition list, the target manifest copy and its source record. Re-run after any manifest change.
const fs = require('node:fs')
const path = require('node:path')
const { assert, assetRoot, digestJson, readJson, repoRoot } = require('./contract-lib.cjs')

const OPERATIONS = ['ordinary_continuation', 'fork_from_accepted_prefix', 'reseed_uncommitted_tail', 'manual_compaction']
const continuityRoot = path.join(repoRoot, 'assets/runtime-continuity')

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function operationProbe(operation, result) {
  if (operation === 'ordinary_continuation') {
    return {
      priorNativeContextObservedByProvider: result.priorNativeContextObservedByProvider === true,
      requestToolsDerivedFromFrozenSurface: result.requestToolsDerivedFromFrozenSurface === true,
      userInputReadbackHistoryMode: result.userInputReadbackHistoryMode,
      inputCardinality: result.ordinaryContinuationInputCardinality,
      turnCountBefore: result.historyTurnCountBefore,
      turnCountAfter: result.historyTurnCountAfter,
    }
  }
  if (operation === 'fork_from_accepted_prefix') {
    return {
      forkAccepted: result.forkFromAcceptedPrefixAccepted === true,
      priorNativeContextObservedByProvider: result.forkPriorContextObservedByProvider === true,
      requestToolsDerivedFromFrozenSurface: result.requestToolsDerivedFromFrozenSurface === true,
      userInputReadbackHistoryMode: result.forkUserInputReadbackHistoryMode,
      inputCardinality: result.forkInputCardinality,
    }
  }
  if (operation === 'reseed_uncommitted_tail') {
    return {
      reseedAccepted: result.reseedUncommittedTailAccepted === true,
      inputCardinality: result.reseedInputCardinality,
      tailProviderCardinality: result.reseedTailProviderCardinality,
      currentInputProviderCardinality: result.reseedCurrentInputProviderCardinality,
      restartPassed: result.reseedRestartPassed === true,
      tailAfterRestartCardinality: result.reseedTailAfterRestartCardinality,
      firstInputAfterRestartCardinality: result.reseedFirstInputAfterRestartCardinality,
      secondInputCardinality: result.reseedSecondInputCardinality,
    }
  }
  return {
    manualCompactionAccepted: result.manualCompactionAccepted === true,
    requestToolsDerivedFromFrozenSurface: result.requestToolsDerivedFromFrozenSurface === true,
    contextCompactionItemCount: result.manualCompactionItemCount,
    successorTurnInputCardinality: result.postCompactionTurnInputCardinality,
  }
}

function main() {
  const probePath = process.argv[2]
  assert(probePath, 'Usage: node scripts/codex-runtime/write-runtime-continuity-evidence.cjs <probe-output.json>')
  const probe = readJson(path.resolve(probePath))
  const manifestPath = path.join(assetRoot, 'runtime-manifest.json')
  const manifest = readJson(manifestPath)
  const targetManifestDigest = digestJson(manifest)
  assert(probe.contract === 'ready_runtime_continuity_native_probe_v2', 'probe_contract_invalid')
  assert(probe.targetBinarySha256 === manifest.binarySha256, 'probe_binary_not_pinned_runtime')
  assert(probe.targetRuntimeVersion === `codex-cli ${manifest.codexVersion}`, 'probe_version_not_pinned_runtime')
  assert(probe.isolatedCopy === true && probe.providerKind === 'local_fixture', 'probe_isolation_invalid')
  assert(/^[a-f0-9]{64}$/.test(probe.currentInstructionContractDigest), 'probe_instruction_contract_missing')
  assert(Array.isArray(probe.results) && probe.results.length > 0, 'probe_results_missing')
  assert(probe.results.every((result) => result.requestToolsDerivedFromFrozenSurface === true),
    'probe_request_tools_unverified')
  assert(probe.results.every((result) => ['legacy', 'paginated'].includes(result.userInputReadbackHistoryMode)
    && ['legacy', 'paginated'].includes(result.forkUserInputReadbackHistoryMode)), 'probe_readback_unverified')

  const inventoryPath = path.join(continuityRoot, 'runtime-sources.json')
  const inventory = readJson(inventoryPath)
  const known = new Map(inventory.sources.map((source) => [source.manifestDigest, source]))
  const transitions = []
  for (const result of probe.results) {
    const source = known.get(result.sourceManifestDigest)
    assert(source && source.classification !== 'published_source_manifest_unrecoverable'
      && source.classification !== 'retired_audit_source', `probe_source_not_supported:${result.sourceManifestDigest}`)
    assert(result.sourceManifestDigest !== targetManifestDigest, 'probe_source_is_target')
    assert(result.instructionContract?.targetDigest === probe.currentInstructionContractDigest,
      'probe_instruction_contract_target_mismatch')
    assert(/^[a-f0-9]{64}$/.test(result.instructionContract?.sourceDigest || ''), 'probe_lineage_contract_missing')
    for (const operation of OPERATIONS) {
      const evidence = {
        contract: 'ready_runtime_transition_proof_v1',
        sourceManifestDigest: result.sourceManifestDigest,
        targetManifestDigest,
        operation,
        result: 'compatible',
        instructionContract: result.instructionContract,
        probe: {
          targetBinarySha256: probe.targetBinarySha256,
          targetRuntimeVersion: probe.targetRuntimeVersion,
          isolatedCopy: true,
          providerKind: probe.providerKind,
          ...operationProbe(operation, result),
        },
      }
      const file = `evidence/${result.sourceManifestDigest.slice(0, 8)}-${targetManifestDigest.slice(0, 8)}-${operation}.json`
      writeJson(path.join(continuityRoot, file), evidence)
      transitions.push({
        sourceManifestDigest: result.sourceManifestDigest,
        targetManifestDigest,
        operation,
        result: 'compatible',
        proofDigest: digestJson(evidence),
        instructionContract: result.instructionContract,
        evidenceFile: file,
      })
    }
  }
  writeJson(path.join(continuityRoot, 'runtime-continuity-transitions.json'), {
    contract: 'ready_runtime_continuity_transitions_v1',
    targetManifestDigest,
    transitions,
  })

  const prefix = `${manifest.codexVersion}-${targetManifestDigest.slice(0, 8)}`
  const manifestFile = `manifests/${prefix}.json`
  fs.copyFileSync(manifestPath, path.join(continuityRoot, manifestFile))
  const evidenceFile = `evidence/${prefix}-target.json`
  writeJson(path.join(continuityRoot, evidenceFile), {
    contract: 'ready_runtime_source_evidence_v1',
    sourceManifestDigest: targetManifestDigest,
    evidenceKind: 'current_verified_runtime',
    runtimeVersion: manifest.codexVersion,
    binarySha256: manifest.binarySha256,
  })
  if (!known.has(targetManifestDigest)) {
    inventory.sources.push({
      manifestDigest: targetManifestDigest,
      classification: 'observed_active_source',
      manifestFile,
      evidenceFiles: [evidenceFile],
    })
    writeJson(inventoryPath, inventory)
  }
  console.log(`Runtime continuity evidence: ${transitions.length} transitions to ${targetManifestDigest.slice(0, 12)}.`)
}

main()
