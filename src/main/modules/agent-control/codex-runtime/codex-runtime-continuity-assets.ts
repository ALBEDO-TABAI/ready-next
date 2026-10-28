import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { digestCanonicalJson } from './codex-model-gateway-contract'
import type {
  RuntimeContinuityCatalog,
  RuntimeContinuityTransition,
  RuntimeOperation,
  RuntimeUnsupportedReason,
} from './codex-runtime-compatibility'

type SourceClass =
  | 'published_support_source'
  | 'published_source_manifest_unrecoverable'
  | 'observed_active_source'
  | 'retired_audit_source'

type RuntimeSourceRecord = {
  manifestDigest: string
  classification: SourceClass
  manifestFile: string | null
  evidenceFiles: string[]
  reason?: 'source_evidence_unrecoverable' | 'source_manifest_unrecoverable'
}

type RuntimeSourceInventory = {
  contract: 'ready_runtime_source_inventory_v1'
  sources: RuntimeSourceRecord[]
}

type RuntimeTransitionFile = {
  contract: 'ready_runtime_continuity_transitions_v1'
  targetManifestDigest: string
  transitions: Array<RuntimeContinuityTransition & { evidenceFile: string }>
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function digest(value: unknown): string {
  return digestCanonicalJson(value)
}

function safeRelativePath(value: unknown): string {
  const path = typeof value === 'string' ? value.trim() : ''
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error('runtime_continuity_asset_path_invalid')
  }
  return path
}

function parseInventory(value: unknown): RuntimeSourceInventory {
  if (!record(value) || value.contract !== 'ready_runtime_source_inventory_v1'
    || !Array.isArray(value.sources)) throw new Error('runtime_source_inventory_invalid')
  const sources = value.sources.map((source): RuntimeSourceRecord => {
    if (!record(source)
      || typeof source.manifestDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(source.manifestDigest)
      || !['published_support_source', 'published_source_manifest_unrecoverable',
        'observed_active_source', 'retired_audit_source']
        .includes(String(source.classification))
      || !Array.isArray(source.evidenceFiles)) {
      throw new Error('runtime_source_record_invalid')
    }
    const manifestFile = source.manifestFile === null
      ? null
      : safeRelativePath(source.manifestFile)
    // A supported source must be identity-verifiable: it always carries its own
    // manifest. A published source whose manifest is genuinely unrecoverable is
    // its own class, never silently downgraded into the supported one.
    if (source.classification === 'published_support_source' && !manifestFile) {
      throw new Error('runtime_source_supported_manifest_missing')
    }
    if (source.classification === 'published_source_manifest_unrecoverable'
      && (manifestFile
        || source.reason !== 'source_manifest_unrecoverable'
        || source.evidenceFiles.length === 0)) {
      throw new Error('runtime_source_unrecoverable_record_invalid')
    }
    if (!manifestFile && source.reason !== 'source_evidence_unrecoverable'
      && source.reason !== 'source_manifest_unrecoverable') {
      throw new Error('runtime_source_manifest_reason_missing')
    }
    return {
      manifestDigest: source.manifestDigest,
      classification: source.classification as SourceClass,
      manifestFile,
      evidenceFiles: source.evidenceFiles.map(safeRelativePath),
      ...(source.reason === 'source_evidence_unrecoverable'
        || source.reason === 'source_manifest_unrecoverable'
        ? { reason: source.reason }
        : {}),
    }
  })
  if (new Set(sources.map((source) => source.manifestDigest)).size !== sources.length) {
    throw new Error('runtime_source_record_duplicate')
  }
  return { contract: 'ready_runtime_source_inventory_v1', sources }
}

function parseInstructionContract(value: unknown): { sourceDigest: string; targetDigest: string } {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'sourceDigest,targetDigest'
    || typeof value.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
    || typeof value.targetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.targetDigest)) {
    throw new Error('runtime_continuity_instruction_contract_invalid')
  }
  return { sourceDigest: value.sourceDigest, targetDigest: value.targetDigest }
}

function parseTransitions(value: unknown): RuntimeTransitionFile {
  if (!record(value) || value.contract !== 'ready_runtime_continuity_transitions_v1'
    || typeof value.targetManifestDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.targetManifestDigest)
    || !Array.isArray(value.transitions)) {
    throw new Error('runtime_continuity_transitions_invalid')
  }
  const transitions = value.transitions.map((transition) => {
    if (!record(transition)
      || typeof transition.sourceManifestDigest !== 'string'
      || typeof transition.targetManifestDigest !== 'string'
      || typeof transition.operation !== 'string'
      || !['ordinary_continuation', 'fork_from_accepted_prefix',
        'reseed_uncommitted_tail', 'manual_compaction'].includes(transition.operation)
      || !['compatible', 'unsupported'].includes(String(transition.result))
      || typeof transition.proofDigest !== 'string') {
      throw new Error('runtime_continuity_transition_invalid')
    }
    return {
      sourceManifestDigest: transition.sourceManifestDigest,
      targetManifestDigest: transition.targetManifestDigest,
      operation: transition.operation as RuntimeOperation,
      result: transition.result as 'compatible' | 'unsupported',
      proofDigest: transition.proofDigest,
      ...(typeof transition.reason === 'string'
        ? { reason: transition.reason as RuntimeUnsupportedReason }
        : {}),
      ...(transition.instructionContract !== undefined
        ? { instructionContract: parseInstructionContract(transition.instructionContract) }
        : {}),
      evidenceFile: safeRelativePath(transition.evidenceFile),
    }
  })
  return {
    contract: 'ready_runtime_continuity_transitions_v1',
    targetManifestDigest: value.targetManifestDigest,
    transitions,
  }
}

export function loadRuntimeContinuityAssets(input: {
  assetRoot: string
  targetManifestDigest: string
}): {
  catalog: RuntimeContinuityCatalog
} {
  const assetRoot = resolve(input.assetRoot)
  if (!isAbsolute(assetRoot)) throw new Error('runtime_continuity_asset_root_invalid')
  const inventory = parseInventory(readJson(join(assetRoot, 'runtime-sources.json')))
  const transitionFile = parseTransitions(readJson(join(
    assetRoot,
    'runtime-continuity-transitions.json',
  )))
  if (transitionFile.targetManifestDigest !== input.targetManifestDigest) {
    throw new Error('runtime_continuity_target_manifest_stale')
  }
  for (const source of inventory.sources) {
    if (source.manifestFile) {
      const manifest = readJson(join(assetRoot, source.manifestFile))
      if (digest(manifest) !== source.manifestDigest) {
        throw new Error('runtime_source_manifest_digest_mismatch')
      }
    }
    for (const evidenceFile of source.evidenceFiles) {
      const evidence = readJson(join(assetRoot, evidenceFile))
      if (!record(evidence)
        || (evidence.sourceManifestDigest !== source.manifestDigest
          && !(Array.isArray(evidence.sourceManifestDigests)
            && evidence.sourceManifestDigests.includes(source.manifestDigest)))) {
        throw new Error('runtime_source_evidence_identity_mismatch')
      }
    }
  }
  const supported = new Set(inventory.sources
    .filter((source) => source.classification !== 'retired_audit_source'
      && source.classification !== 'published_source_manifest_unrecoverable')
    .map((source) => source.manifestDigest))
  const transitions: RuntimeContinuityTransition[] = transitionFile.transitions.map((transition) => {
    if (!supported.has(transition.sourceManifestDigest)
      || transition.targetManifestDigest !== input.targetManifestDigest) {
      throw new Error('runtime_continuity_transition_scope_invalid')
    }
    const evidence = readJson(join(assetRoot, transition.evidenceFile))
    if (digest(evidence) !== transition.proofDigest
      || !record(evidence)
      || evidence.contract !== 'ready_runtime_transition_proof_v1'
      || evidence.sourceManifestDigest !== transition.sourceManifestDigest
      || evidence.targetManifestDigest !== transition.targetManifestDigest
      || evidence.operation !== transition.operation
      || evidence.result !== transition.result
      // The measured instruction-contract mapping is part of the proof, never added beside it.
      || digest(evidence.instructionContract ?? null) !== digest(transition.instructionContract ?? null)) {
      throw new Error('runtime_continuity_transition_evidence_mismatch')
    }
    const { evidenceFile: _, ...catalogTransition } = transition
    return catalogTransition
  })
  const transitionIdentities = transitions.map((transition) => [
    transition.sourceManifestDigest,
    transition.targetManifestDigest,
    transition.operation,
  ].join('\0'))
  if (new Set(transitionIdentities).size !== transitionIdentities.length) {
    throw new Error('runtime_continuity_transition_duplicate')
  }
  const publishedOperations: RuntimeOperation[] = [
    'ordinary_continuation',
    'fork_from_accepted_prefix',
    'reseed_uncommitted_tail',
  ]
  for (const source of inventory.sources) {
    if (source.classification === 'published_source_manifest_unrecoverable') {
      // No verifiable identity means no operation may be declared for it. The
      // runtime therefore resolves such a source as unverified and routes the
      // conversation to explicit recovery instead of guessing compatibility.
      if (transitions.some((candidate) => (
        candidate.sourceManifestDigest === source.manifestDigest
      ))) throw new Error('runtime_continuity_unrecoverable_source_declared')
      continue
    }
    if (source.classification === 'retired_audit_source'
      || source.manifestDigest === input.targetManifestDigest) continue
    const requiredOperations = source.classification === 'published_support_source'
      ? publishedOperations
      : ['ordinary_continuation'] as RuntimeOperation[]
    for (const operation of requiredOperations) {
      const transition = transitions.find((candidate) => (
        candidate.sourceManifestDigest === source.manifestDigest
        && candidate.operation === operation
      ))
      if (!transition) throw new Error('runtime_continuity_support_edge_missing')
      if (operation === 'ordinary_continuation' && transition.result !== 'compatible') {
        throw new Error('runtime_continuity_ordinary_support_regressed')
      }
    }
  }
  return {
    catalog: {
      contract: 'ready_runtime_continuity_catalog_v1',
      targetManifestDigest: input.targetManifestDigest,
      transitions,
    },
  }
}
