import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildCodexChildEnvironment,
  loadVerifiedCodexRuntime,
  prepareCodexRuntimeState,
  resolveCodexRuntimePaths,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-host'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const canonicalAssetRoot = join(repoRoot, 'assets/codex-runtime')
const canonicalContracts = JSON.parse(
  readFileSync(join(canonicalAssetRoot, 'contracts/runtime-contracts.json'), 'utf8'),
)

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path)
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

function makeRuntimeFixture(): {
  root: string
  assetRoot: string
  binaryPath: string
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'ready-codex-runtime-host-'))
  const assetRoot = join(root, 'assets', 'codex-runtime')
  cpSync(canonicalAssetRoot, assetRoot, { recursive: true })
  const manifestPath = join(assetRoot, 'runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const binaryPath = join(root, 'build/codex/aarch64-apple-darwin/codex')
  mkdirSync(dirname(binaryPath), { recursive: true })
  writeFileSync(binaryPath, '#!/bin/sh\nprintf "codex-cli 0.146.1\\n"\n', { mode: 0o755 })
  manifest.binarySha256 = sha256File(binaryPath)
  manifest.binarySizeBytes = statSync(binaryPath).size
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    root,
    assetRoot,
    binaryPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('runtime paths are manifest-rooted and never resolve through PATH', () => {
  const dev = resolveCodexRuntimePaths({
    appPath: repoRoot,
    resourcesPath: '/Applications/Ready.app/Contents/Resources',
    isPackaged: false,
  })
  assert.equal(dev.assetRoot, join(repoRoot, 'assets/codex-runtime'))
  assert.equal(dev.binaryPath, join(repoRoot, 'build/codex/aarch64-apple-darwin/codex'))

  const fixture = makeRuntimeFixture()
  try {
    const resourcesPath = join(fixture.root, 'assets')
    const packed = resolveCodexRuntimePaths({
      appPath: join(resourcesPath, 'app.asar'),
      resourcesPath,
      isPackaged: true,
    })
    assert.equal(packed.assetRoot, fixture.assetRoot)
    assert.equal(
      packed.binaryPath,
      join(fixture.assetRoot, 'aarch64-apple-darwin/codex'),
    )
  } finally {
    fixture.cleanup()
  }
})

test('Codex-owned tables have one runtime writer outside the schema declaration', () => {
  const mainRoot = join(repoRoot, 'src/main')
  const allowed = new Set([
    join(mainRoot, 'modules/agent-control/codex-runtime/codex-binding-repository.ts'),
    join(mainRoot, 'modules/agent-control/codex-runtime/codex-binding-schema.ts'),
  ])
  const tableName = /\bcodex_(?:thread_bindings|turn_bindings|tool_call_bindings|manual_compaction_bindings|thread_dispatch_fences|sidecar_process_leases)\b/
  const unexpected = listSourceFiles(mainRoot).filter((path) => (
    !allowed.has(path) && tableName.test(readFileSync(path, 'utf8'))
  ))
  assert.deepEqual(unexpected, [])
})

test('runtime verification joins the manifest, machine contracts, binary digest, mode, and version', () => {
  const fixture = makeRuntimeFixture()
  try {
    const verified = loadVerifiedCodexRuntime({
      assetRoot: fixture.assetRoot,
      binaryPath: fixture.binaryPath,
    })
    assert.equal(verified.manifest.releaseTag, 'rust-v0.146.1')
    assert.equal(verified.binaryVersion, 'codex-cli 0.146.1')
    assert.equal(verified.binarySha256, sha256File(fixture.binaryPath))
    assert.equal(verified.contracts.startIdentityRegistryCapacity, 64)
    assert.equal(
      verified.contracts.turnClientIdentityExtractionContract.thread_start.pinnedAppServerSource,
      'vscode',
    )

    chmodSync(fixture.binaryPath, 0o644)
    assert.throws(
      () => loadVerifiedCodexRuntime({
        assetRoot: fixture.assetRoot,
        binaryPath: fixture.binaryPath,
      }),
      /runtime_binary_not_executable/,
    )
  } finally {
    fixture.cleanup()
  }
})

test('runtime verification rejects drift in every checked-in protocol schema bundle', () => {
  const fixtures: Array<[string, string]> = [
    ['schemas/stable/codex_app_server_protocol.schemas.json', 'stable_schema_digest_mismatch'],
    ['schemas/stable/codex_app_server_protocol.v2.schemas.json', 'stable_v2_schema_digest_mismatch'],
    ['schemas/experimental/codex_app_server_protocol.schemas.json', 'experimental_schema_digest_mismatch'],
    ['schemas/experimental/codex_app_server_protocol.v2.schemas.json', 'experimental_v2_schema_digest_mismatch'],
  ]
  for (const [relativePath, expectedCode] of fixtures) {
    const fixture = makeRuntimeFixture()
    try {
      const schemaPath = join(fixture.assetRoot, relativePath)
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>
      schema.readyDriftCanary = relativePath
      writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`)
      assert.throws(
        () => loadVerifiedCodexRuntime({
          assetRoot: fixture.assetRoot,
          binaryPath: fixture.binaryPath,
        }),
        new RegExp(expectedCode),
      )
    } finally {
      fixture.cleanup()
    }
  }
})

test('isolated state and child environment contain only the canonical allowlist', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-codex-state-'))
  const previousCanary = process.env.READY_E2_HOST_SECRET_CANARY
  process.env.READY_E2_HOST_SECRET_CANARY = 'must-not-cross'
  try {
    const state = prepareCodexRuntimeState({
      userDataPath: root,
      gatewayUrl: 'http://127.0.0.1:4317',
      gatewayToken: 'short-lived-token',
      contracts: canonicalContracts,
    })
    const env = buildCodexChildEnvironment({
      state,
      processLeaseId: 'lease-1',
      sidecarSpawnInstanceId: 'spawn-1',
      connectionEpoch: 'epoch-1',
      gatewayUrl: 'http://127.0.0.1:4317',
      gatewayToken: 'short-lived-token',
    })
    const contracts = canonicalContracts as {
      childEnvAllowlist: { allowedKeys: string[]; fixedPath: string; locale: string }
    }
    assert.deepEqual(Object.keys(env), contracts.childEnvAllowlist.allowedKeys)
    assert.equal(env.PATH, contracts.childEnvAllowlist.fixedPath)
    assert.equal(env.LANG, contracts.childEnvAllowlist.locale)
    assert.equal(env.LC_ALL, contracts.childEnvAllowlist.locale)
    assert.equal(env.READY_E2_HOST_SECRET_CANARY, undefined)
    assert.equal(env.HOME, state.homeDir)
    assert.equal(env.CODEX_HOME, state.codexHome)
    assert.equal(env.READY_CODEX_STATE_DIR, state.stateDir)
    assert.equal(statSync(state.stateDir).mode & 0o777, 0o700)
    assert.equal(statSync(state.configPath).mode & 0o777, 0o600)
    const config = readFileSync(state.configPath, 'utf8')
    assert.match(config, /model_provider = "ready_gateway"/)
    assert.match(config, /model = "ready-e0-model"/)
    assert.match(config, /approval_policy = "never"/)
    assert.match(config, /sandbox_mode = "read-only"/)
    assert.match(config, /web_search = "disabled"/)
    assert.match(config, /include_permissions_instructions = false/)
    assert.match(config, /include_apps_instructions = false/)
    assert.match(config, /include_collaboration_mode_instructions = false/)
    assert.match(config, /include_environment_context = false/)
    assert.match(config, /check_for_update_on_startup = false/)
    assert.match(config, /wire_api = "responses"/)
    assert.match(config, /requires_openai_auth = false/)
    assert.match(config, /request_max_retries = 0/)
    assert.match(config, /stream_max_retries = 0/)
    assert.match(config, /supports_websockets = false/)
    assert.match(config, /\[tools\.experimental_request_user_input\]\nenabled = false/)
    assert.match(config, /\[tools\.update_plan\]\nenabled = false/)
    assert.match(config, /\[agents\]\nenabled = false/)
    assert.match(config, /\[skills\]\ninclude_instructions = false/)
    assert.match(config, /\[orchestrator\.skills\]\nenabled = false/)
    assert.match(config, /\[features\][\s\S]*multi_agent = false/)
    assert.match(config, /multi_agent_v2 = false/)
    assert.match(config, /goals = false/)
    assert.match(config, /apps = false/)
    assert.match(config, /plugins = false/)
    assert.match(config, /skill_search = false/)
    assert.doesNotMatch(config, new RegExp(process.env.HOME || 'impossible-home'))
  } finally {
    if (previousCanary === undefined) delete process.env.READY_E2_HOST_SECRET_CANARY
    else process.env.READY_E2_HOST_SECRET_CANARY = previousCanary
    rmSync(root, { recursive: true, force: true })
  }
})

test('external gateways and reused ownership identities fail before spawn environment construction', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-codex-state-invalid-'))
  try {
    assert.throws(
      () => prepareCodexRuntimeState({
        userDataPath: root,
        gatewayUrl: 'https://api.openai.com/v1',
        gatewayToken: 'token',
        contracts: canonicalContracts,
      }),
      /gateway_url_not_loopback/,
    )
    const state = prepareCodexRuntimeState({
      userDataPath: root,
      gatewayUrl: 'http://127.0.0.1:4317',
      gatewayToken: 'token',
      contracts: canonicalContracts,
    })
    assert.throws(
      () => buildCodexChildEnvironment({
        state,
        processLeaseId: 'same-id',
        sidecarSpawnInstanceId: 'same-id',
        connectionEpoch: 'epoch-1',
        gatewayUrl: 'http://127.0.0.1:4317',
        gatewayToken: 'token',
      }),
      /sidecar_identity_reused/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unsupported isolation contract drift fails before state config is written', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-codex-state-contract-drift-'))
  try {
    const drifted = structuredClone(canonicalContracts) as typeof canonicalContracts
    ;(drifted.nativeIsolationConfigContract as {
      topLevel: Record<string, unknown>
    }).topLevel.sandbox_mode = 'workspace-write'
    assert.throws(
      () => prepareCodexRuntimeState({
        userDataPath: root,
        gatewayUrl: 'http://127.0.0.1:4317',
        gatewayToken: 'token',
        contracts: drifted,
      }),
      /native_isolation_contract_unsupported/,
    )
    assert.equal(readFileSync(join(root, 'codex-runtime/codex-home/config.toml'), 'utf8'), '')
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) return
    throw error
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
