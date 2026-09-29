import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  resolveRuntimeCompatibilitySet,
  resolveRuntimeOperationCompatibility,
  type RuntimeContinuityCatalog,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-compatibility'
import {
  resolveSameThreadContinuationContract,
  type SameThreadContinuationCandidate,
  type StoredThreadContinuationContract,
} from '../main/modules/agent-control/codex-runtime/codex-same-thread-continuation'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { loadRuntimeContinuityAssets } from '../main/modules/agent-control/codex-runtime/codex-runtime-continuity-assets'
import {
  buildReadyToolSurface,
  compareReadyToolSurfaceCompatibility,
} from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { SessionRecallFacade } from '../main/modules/agent-control/runtime-core/session-recall-facade'
import { sameCodexThreadDirectory } from '../main/modules/agent-control/codex-runtime/codex-thread-directory-identity'
import { buildContinuationProbeInput } from '../main/modules/agent-control/codex-runtime/codex-continuation-probe'
import { isRetryOnlyTurn } from '../main/modules/agent-control/skills/skill-detection-inputs'

const sha = (char: string) => char.repeat(64)
const currentRuntimeManifestDigest = digestCanonicalJson(JSON.parse(readFileSync(
  new URL('../../assets/codex-runtime/runtime-manifest.json', import.meta.url), 'utf8',
)))

test('default continuation probe is a neutral ordinary message', () => {
  const probe = buildContinuationProbeInput('browser')
  assert.equal(isRetryOnlyTurn(probe.requestEnvelope.primaryInstruction), false)
  assert.equal(probe.requestEnvelope.primaryInstruction.includes('/'), false)
})

test('native thread cwd accepts one physical macOS directory through a different path spelling', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-thread-cwd-'))
  try {
    const physical = join(root, 'Ready')
    const alias = join(root, 'ready-alias')
    mkdirSync(physical)
    symlinkSync(physical, alias)
    assert.equal(sameCodexThreadDirectory(physical, physical), true)
    assert.equal(sameCodexThreadDirectory(physical, alias), process.platform === 'darwin')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checked-in runtime continuity assets match their canonical source manifests', () => {
  const loaded = loadRuntimeContinuityAssets({
    assetRoot: fileURLToPath(new URL('../../assets/runtime-continuity', import.meta.url)),
    targetManifestDigest: currentRuntimeManifestDigest,
  })
  assert.equal(loaded.catalog.transitions.every((transition) => (
    transition.targetManifestDigest === loaded.catalog.targetManifestDigest
  )), true)
})

test('release continuity assets reject a missing published operation edge', () => {
  const source = fileURLToPath(new URL('../../assets/runtime-continuity', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'ready-runtime-assets-'))
  try {
    cpSync(source, root, { recursive: true })
    const path = join(root, 'runtime-continuity-transitions.json')
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      transitions: Array<{ sourceManifestDigest: string; operation: string }>
    }
    value.transitions = value.transitions.filter((transition) => !(
      transition.sourceManifestDigest
        === '8b2e1f3f4f80fd9ef28657b49e90290e06c63f004eb35fc198c91d59992f3e0b'
      && transition.operation === 'fork_from_accepted_prefix'
    ))
    writeFileSync(path, JSON.stringify(value, null, 2))
    assert.throws(() => loadRuntimeContinuityAssets({
      assetRoot: root,
      targetManifestDigest: currentRuntimeManifestDigest,
    }), /runtime_continuity_support_edge_missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const catalog: RuntimeContinuityCatalog = {
  contract: 'ready_runtime_continuity_catalog_v1',
  targetManifestDigest: sha('c'),
  transitions: [
    {
      sourceManifestDigest: sha('a'),
      targetManifestDigest: sha('c'),
      operation: 'ordinary_continuation',
      result: 'compatible',
      proofDigest: sha('1'),
    },
    {
      sourceManifestDigest: sha('b'),
      targetManifestDigest: sha('c'),
      operation: 'ordinary_continuation',
      result: 'unsupported',
      reason: 'native_resume_rejected',
      proofDigest: sha('2'),
    },
  ],
}

test('runtime compatibility is exact directional operation-scoped and never inferred from schema', () => {
  assert.equal(resolveRuntimeOperationCompatibility({
    catalog,
    sourceManifestDigest: sha('a'),
    targetManifestDigest: sha('c'),
    operation: 'ordinary_continuation',
  }).kind, 'compatible')
  assert.equal(resolveRuntimeOperationCompatibility({
    catalog,
    sourceManifestDigest: sha('c'),
    targetManifestDigest: sha('a'),
    operation: 'ordinary_continuation',
  }).kind, 'unverified')
  assert.equal(resolveRuntimeOperationCompatibility({
    catalog,
    sourceManifestDigest: sha('a'),
    targetManifestDigest: sha('c'),
    operation: 'fork_from_accepted_prefix',
  }).kind, 'unverified')
  assert.equal(resolveRuntimeOperationCompatibility({
    catalog,
    sourceManifestDigest: sha('c'),
    targetManifestDigest: sha('c'),
    operation: 'ordinary_continuation',
  }).kind, 'compatible')
})

test('a head with multiple runtime writers keeps every source in the decision', () => {
  const result = resolveRuntimeCompatibilitySet({
    catalog,
    sourceManifestDigests: [sha('a'), sha('b')],
    targetManifestDigest: sha('c'),
    operation: 'ordinary_continuation',
  })
  assert.equal(result.kind, 'unsupported')
  assert.deepEqual(result.sources.map((source) => source.sourceManifestDigest), [sha('a'), sha('b')])
})

function definition(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: 'read one thing',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    groupId: 'test',
    domain: 'system' as const,
    kind: 'read' as const,
    concurrency: 'parallel' as const,
    interruptBehavior: 'abortable' as const,
    timeoutProfile: 'default' as const,
    supportsTextBridge: false,
    projectionHint: null,
    executionVisibility: 'model' as const,
    requiresExplicitAllowlist: false,
    resultShape: 'json' as const,
    ...overrides,
  }
}

test('tool compatibility distinguishes additions model contract ready contract and frozen-only entries', () => {
  const frozen = buildReadyToolSurface({
    surfaceId: 'frozen',
    toolDefinitions: [definition('alpha'), definition('old_only')],
  })
  const added = buildReadyToolSurface({
    surfaceId: 'current',
    toolDefinitions: [definition('alpha'), definition('new_tool')],
  })
  assert.equal(compareReadyToolSurfaceCompatibility({ frozen, current: added }).kind,
    'native_tool_surface_extension_required')

  const modelChanged = buildReadyToolSurface({
    surfaceId: 'current',
    toolDefinitions: [definition('alpha', { description: 'changed' })],
  })
  assert.equal(compareReadyToolSurfaceCompatibility({ frozen, current: modelChanged }).kind,
    'native_tool_definition_changed')

  const readyChanged = buildReadyToolSurface({
    surfaceId: 'current',
    toolDefinitions: [definition('alpha', { timeoutProfile: 'fast' })],
  })
  assert.equal(compareReadyToolSurfaceCompatibility({ frozen, current: readyChanged }).kind,
    'ready_tool_execution_contract_changed')

  const reduced = buildReadyToolSurface({
    surfaceId: 'current',
    toolDefinitions: [definition('alpha')],
  })
  const result = compareReadyToolSurfaceCompatibility({ frozen, current: reduced })
  assert.equal(result.kind, 'compatible')
  assert.deepEqual(result.frozenOnlyToolNames, ['old_only'])
})

function stored(overrides: Partial<StoredThreadContinuationContract> = {}): StoredThreadContinuationContract {
  return {
    model: 'model-a',
    threadConfig: { contextWindow: 100 },
    isolatedThreadCwd: '/tmp/thread-a',
    instructionContractDigest: sha('3'),
    readyToolSurface: buildReadyToolSurface({
      surfaceId: 'surface',
      toolDefinitions: [definition('alpha')],
    }),
    ...overrides,
  }
}

function candidate(overrides: Partial<SameThreadContinuationCandidate> = {}): SameThreadContinuationCandidate {
  const base = stored()
  return {
    model: base.model,
    threadConfig: base.threadConfig,
    isolatedThreadCwd: base.isolatedThreadCwd,
    cwdAvailable: true,
    instructionContractDigest: base.instructionContractDigest,
    currentToolSurface: base.readyToolSurface,
    ...overrides,
  }
}

test('same-thread preflight returns one named decision for every strict contract dimension', () => {
  const compatibleRuntime = resolveRuntimeCompatibilitySet({
    catalog,
    sourceManifestDigests: [sha('a')],
    targetManifestDigest: sha('c'),
    operation: 'ordinary_continuation',
  })
  assert.equal(resolveSameThreadContinuationContract({
    stored: stored(), candidate: candidate(), runtime: compatibleRuntime,
  }).kind, 'ready_same_thread')
  assert.equal(resolveSameThreadContinuationContract({
    stored: stored(), candidate: candidate({ model: 'model-b' }), runtime: compatibleRuntime,
  }).reason, 'model_changed')
  assert.equal(resolveSameThreadContinuationContract({
    stored: stored(), candidate: candidate({ cwdAvailable: false }), runtime: compatibleRuntime,
  }).reason, 'cwd_unavailable')
  assert.equal(resolveSameThreadContinuationContract({
    stored: stored(), candidate: candidate({ instructionContractDigest: sha('4') }), runtime: compatibleRuntime,
  }).reason, 'instruction_contract_changed')
})

test('a context boundary blocks automatic recall and capsule hint recovery', () => {
  let autoAttachCalls = 0
  let hintCalls = 0
  const facade = new SessionRecallFacade({
    sessionRecallService: {
      autoAttachOnResume() {
        autoAttachCalls += 1
        return { attached: [{ conversationId: 'old-scope' }] }
      },
    } as never,
    mapConversationRow: (row) => row as never,
    emitConversationEvent() {},
    extractTextFromMessage: (message) => String(message),
    armReferenceHintFromCapsules() { hintCalls += 1 },
    hasContextBoundary: () => true,
  })
  facade.maybeAutoAttachSessionRecallOnResume('scope-1', '继续', 0)
  assert.equal(autoAttachCalls, 0)
  assert.equal(hintCalls, 0)
})
