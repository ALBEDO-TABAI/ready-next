import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

type JsonObject = Record<string, unknown>

export type CodexRuntimeManifest = {
  manifestVersion: number
  releaseTag: string
  codexVersion: string
  platform: string
  architecture: string
  targetTriple: string
  binarySha256: string
  binarySizeBytes: number
  stableSchemaSha256: string
  stableV2SchemaSha256: string
  experimentalSchemaSha256: string
  experimentalV2SchemaSha256: string
  agentMessageFinalSelectionContractDigest: string
  historyPublicationParityContractDigest: string
  turnInputUnionContractDigest: string
  turnClientIdentityExtractionContractDigest: string
  nonUserSuccessorIdentityContractDigest: string
  startIdentityRegistryCapacity: number
  startDeliveryResolutionContractDigest: string
  hostFailureCloseoutContractDigest: string
  processLeaseContractDigest: string
  childEnvAllowlistDigest: string
  nativeIsolationConfigContractDigest: string
  resourceAdditionalContextContractDigest: string
  outboundRpcContractDigest: string
  bindingSchemaDigest: string
  experimentContractDigest: string
  experimentReportSchemaDigest: string
  licenseDigest: string
  thirdPartyNoticeDigest: string
}

export type CodexRuntimeContracts = {
  contractVersion: number
  pinnedCodexVersion: string
  startIdentityRegistryCapacity: number
  agentMessageFinalSelectionContract: JsonObject
  historyPublicationParityContract: JsonObject
  turnInputUnionContract: JsonObject
  turnClientIdentityExtractionContract: {
    thread_start: {
      pinnedAppServerSource: string
      threadListSourceKinds: string[]
    }
  }
  nonUserSuccessorIdentityContract: JsonObject
  startDeliveryResolutionContract: JsonObject
  hostFailureCloseoutContract: JsonObject
  processLeaseContract: JsonObject
  childEnvAllowlist: {
    allowedKeys: string[]
    fixedPath: string
    locale: string
    ownershipMarkers: Record<string, string>
    inheritProcessEnv: false
  }
  nativeIsolationConfigContract: {
    launchArgv: string[]
    topLevel: Record<string, unknown>
    disabledTools: string[]
    disabledFeatureKeys: string[]
    provider: Record<string, unknown>
    instructionOverrides: Record<string, unknown>
    providerToolSurface: Record<string, unknown>
  }
  resourceAdditionalContextContract: JsonObject
  outboundRpcContract: JsonObject
}

export type VerifiedCodexRuntime = {
  assetRoot: string
  binaryPath: string
  binarySha256: string
  binaryVersion: string
  manifestDigest: string
  manifest: CodexRuntimeManifest
  contracts: CodexRuntimeContracts
}

export type PreparedCodexRuntimeState = {
  stateDir: string
  homeDir: string
  codexHome: string
  threadCwdRoot: string
  tmpDir: string
  configPath: string
  configDigest: string
  gatewayUrl: string
  gatewayTokenDigest: string
}

export class CodexRuntimeHostError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexRuntimeHostError'
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readJson(path: string): JsonObject {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed)) throw new CodexRuntimeHostError('runtime_json_not_object')
  return parsed
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  )
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function digestJson(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)))
}

function digestFile(path: string): string {
  return sha256(readFileSync(path))
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CodexRuntimeHostError(code)
  return value
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new CodexRuntimeHostError(code)
  return value as number
}

function parseManifest(value: JsonObject): CodexRuntimeManifest {
  const manifest = value as Partial<CodexRuntimeManifest>
  const stringFields: Array<keyof CodexRuntimeManifest> = [
    'releaseTag',
    'codexVersion',
    'platform',
    'architecture',
    'targetTriple',
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
    'startDeliveryResolutionContractDigest',
    'hostFailureCloseoutContractDigest',
    'processLeaseContractDigest',
    'childEnvAllowlistDigest',
    'nativeIsolationConfigContractDigest',
    'resourceAdditionalContextContractDigest',
    'outboundRpcContractDigest',
    'bindingSchemaDigest',
    'experimentContractDigest',
    'experimentReportSchemaDigest',
    'licenseDigest',
    'thirdPartyNoticeDigest',
  ]
  for (const field of stringFields) nonEmptyString(manifest[field], `runtime_manifest_${field}_invalid`)
  positiveInteger(manifest.manifestVersion, 'runtime_manifest_version_invalid')
  positiveInteger(manifest.binarySizeBytes, 'runtime_manifest_binary_size_invalid')
  positiveInteger(
    manifest.startIdentityRegistryCapacity,
    'runtime_manifest_registry_capacity_invalid',
  )
  return manifest as CodexRuntimeManifest
}

function parseContracts(value: JsonObject): CodexRuntimeContracts {
  const contracts = value as Partial<CodexRuntimeContracts>
  positiveInteger(contracts.contractVersion, 'runtime_contract_version_invalid')
  nonEmptyString(contracts.pinnedCodexVersion, 'runtime_contract_codex_version_invalid')
  positiveInteger(
    contracts.startIdentityRegistryCapacity,
    'runtime_contract_registry_capacity_invalid',
  )
  if (
    !isRecord(contracts.turnClientIdentityExtractionContract)
    || !isRecord(contracts.turnClientIdentityExtractionContract.thread_start)
    || typeof contracts.turnClientIdentityExtractionContract.thread_start.pinnedAppServerSource !== 'string'
    || !Array.isArray(
      contracts.turnClientIdentityExtractionContract.thread_start.threadListSourceKinds,
    )
  ) throw new CodexRuntimeHostError('runtime_contract_thread_source_invalid')
  if (
    !isRecord(contracts.childEnvAllowlist)
    || !Array.isArray(contracts.childEnvAllowlist.allowedKeys)
    || contracts.childEnvAllowlist.inheritProcessEnv !== false
  ) throw new CodexRuntimeHostError('runtime_contract_child_env_invalid')
  if (
    !isRecord(contracts.nativeIsolationConfigContract)
    || !Array.isArray(contracts.nativeIsolationConfigContract.launchArgv)
  ) throw new CodexRuntimeHostError('runtime_contract_isolation_invalid')
  return contracts as CodexRuntimeContracts
}

function assertDigest(actual: string, expected: string, code: string): void {
  if (actual !== expected) throw new CodexRuntimeHostError(code)
}

function verifyContractDigests(input: {
  assetRoot: string
  manifest: CodexRuntimeManifest
  contracts: CodexRuntimeContracts
}): void {
  const { assetRoot, manifest, contracts } = input
  const mappings: Array<[unknown, string, string]> = [
    [
      contracts.agentMessageFinalSelectionContract,
      manifest.agentMessageFinalSelectionContractDigest,
      'agent_message_contract_digest_mismatch',
    ],
    [
      contracts.historyPublicationParityContract,
      manifest.historyPublicationParityContractDigest,
      'history_parity_contract_digest_mismatch',
    ],
    [contracts.turnInputUnionContract, manifest.turnInputUnionContractDigest, 'turn_input_contract_digest_mismatch'],
    [
      contracts.turnClientIdentityExtractionContract,
      manifest.turnClientIdentityExtractionContractDigest,
      'turn_identity_contract_digest_mismatch',
    ],
    [
      contracts.nonUserSuccessorIdentityContract,
      manifest.nonUserSuccessorIdentityContractDigest,
      'successor_identity_contract_digest_mismatch',
    ],
    [
      contracts.startDeliveryResolutionContract,
      manifest.startDeliveryResolutionContractDigest,
      'start_resolution_contract_digest_mismatch',
    ],
    [
      contracts.hostFailureCloseoutContract,
      manifest.hostFailureCloseoutContractDigest,
      'host_failure_contract_digest_mismatch',
    ],
    [contracts.processLeaseContract, manifest.processLeaseContractDigest, 'process_lease_contract_digest_mismatch'],
    [contracts.childEnvAllowlist, manifest.childEnvAllowlistDigest, 'child_env_contract_digest_mismatch'],
    [
      contracts.nativeIsolationConfigContract,
      manifest.nativeIsolationConfigContractDigest,
      'native_isolation_contract_digest_mismatch',
    ],
    [
      contracts.resourceAdditionalContextContract,
      manifest.resourceAdditionalContextContractDigest,
      'resource_context_contract_digest_mismatch',
    ],
    [contracts.outboundRpcContract, manifest.outboundRpcContractDigest, 'outbound_rpc_contract_digest_mismatch'],
  ]
  for (const [value, expected, code] of mappings) assertDigest(digestJson(value), expected, code)
  assertDigest(
    digestFile(join(assetRoot, 'schemas/stable/codex_app_server_protocol.schemas.json')),
    manifest.stableSchemaSha256,
    'stable_schema_digest_mismatch',
  )
  assertDigest(
    digestJson(readJson(join(
      assetRoot,
      'schemas/stable/codex_app_server_protocol.v2.schemas.json',
    ))),
    manifest.stableV2SchemaSha256,
    'stable_v2_schema_digest_mismatch',
  )
  assertDigest(
    digestFile(join(assetRoot, 'schemas/experimental/codex_app_server_protocol.schemas.json')),
    manifest.experimentalSchemaSha256,
    'experimental_schema_digest_mismatch',
  )
  assertDigest(
    digestJson(readJson(join(
      assetRoot,
      'schemas/experimental/codex_app_server_protocol.v2.schemas.json',
    ))),
    manifest.experimentalV2SchemaSha256,
    'experimental_v2_schema_digest_mismatch',
  )
  assertDigest(
    digestJson(readJson(join(assetRoot, 'contracts/binding-schema.json'))),
    manifest.bindingSchemaDigest,
    'binding_schema_digest_mismatch',
  )
  assertDigest(
    digestJson(readJson(join(assetRoot, 'contracts/experiment-contract.json'))),
    manifest.experimentContractDigest,
    'experiment_contract_digest_mismatch',
  )
  assertDigest(
    digestJson(readJson(join(assetRoot, 'contracts/experiment-report.schema.json'))),
    manifest.experimentReportSchemaDigest,
    'experiment_report_schema_digest_mismatch',
  )
  assertDigest(digestFile(join(assetRoot, 'LICENSE')), manifest.licenseDigest, 'runtime_license_digest_mismatch')
  assertDigest(digestFile(join(assetRoot, 'NOTICE')), manifest.thirdPartyNoticeDigest, 'runtime_notice_digest_mismatch')
}

export function resolveCodexRuntimePaths(input: {
  appPath: string
  resourcesPath: string
  isPackaged: boolean
}): { assetRoot: string; binaryPath: string } {
  const assetRoot = resolve(input.isPackaged
    ? join(input.resourcesPath, 'codex-runtime')
    : join(input.appPath, 'assets/codex-runtime'))
  const manifest = parseManifest(readJson(join(assetRoot, 'runtime-manifest.json')))
  if (!/^[a-z0-9_-]+$/i.test(manifest.targetTriple)) {
    throw new CodexRuntimeHostError('runtime_target_triple_invalid')
  }
  const binaryPath = resolve(input.isPackaged
    ? join(assetRoot, manifest.targetTriple, 'codex')
    : join(input.appPath, 'build/codex', manifest.targetTriple, 'codex'))
  return { assetRoot, binaryPath }
}

export function loadVerifiedCodexRuntime(input: {
  assetRoot: string
  binaryPath: string
}): VerifiedCodexRuntime {
  if (!isAbsolute(input.assetRoot) || !isAbsolute(input.binaryPath)) {
    throw new CodexRuntimeHostError('runtime_path_not_absolute')
  }
  const manifestRaw = readJson(join(input.assetRoot, 'runtime-manifest.json'))
  const manifest = parseManifest(manifestRaw)
  const contracts = parseContracts(
    readJson(join(input.assetRoot, 'contracts/runtime-contracts.json')),
  )
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) {
    throw new CodexRuntimeHostError('runtime_platform_mismatch')
  }
  if (
    contracts.pinnedCodexVersion !== manifest.codexVersion
    || contracts.startIdentityRegistryCapacity !== manifest.startIdentityRegistryCapacity
  ) throw new CodexRuntimeHostError('runtime_manifest_contract_mismatch')
  verifyContractDigests({ assetRoot: input.assetRoot, manifest, contracts })

  const binary = statSync(input.binaryPath)
  if (!binary.isFile()) throw new CodexRuntimeHostError('runtime_binary_not_file')
  if (binary.size !== manifest.binarySizeBytes) {
    throw new CodexRuntimeHostError('runtime_binary_size_mismatch')
  }
  try {
    accessSync(input.binaryPath, constants.X_OK)
  } catch {
    throw new CodexRuntimeHostError('runtime_binary_not_executable')
  }
  const binarySha256 = digestFile(input.binaryPath)
  assertDigest(binarySha256, manifest.binarySha256, 'runtime_binary_digest_mismatch')
  let binaryVersion = ''
  try {
    binaryVersion = execFileSync(input.binaryPath, ['--version'], {
      encoding: 'utf8',
      env: { PATH: contracts.childEnvAllowlist.fixedPath },
      timeout: 10_000,
    }).trim()
  } catch {
    throw new CodexRuntimeHostError('runtime_binary_version_read_failed')
  }
  if (binaryVersion !== `codex-cli ${manifest.codexVersion}`) {
    throw new CodexRuntimeHostError('runtime_binary_version_mismatch')
  }
  return {
    assetRoot: resolve(input.assetRoot),
    binaryPath: resolve(input.binaryPath),
    binarySha256,
    binaryVersion,
    manifestDigest: digestJson(manifestRaw),
    manifest,
    contracts,
  }
}

function validateGateway(gatewayUrl: string, gatewayToken: string): URL {
  let parsed: URL
  try {
    parsed = new URL(gatewayUrl)
  } catch {
    throw new CodexRuntimeHostError('gateway_url_invalid')
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.username
    || parsed.password
  ) throw new CodexRuntimeHostError('gateway_url_not_loopback')
  if (!gatewayToken.trim()) throw new CodexRuntimeHostError('gateway_token_missing')
  return parsed
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

const supportedNativeIsolationConfigContract: CodexRuntimeContracts['nativeIsolationConfigContract'] = {
  launchArgv: ['app-server', '--stdio', '--strict-config'],
  topLevel: {
    model: 'ready-e0-model',
    model_provider: 'ready_gateway',
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    check_for_update_on_startup: false,
  },
  disabledTools: ['experimental_request_user_input', 'update_plan'],
  disabledFeatureKeys: [
    'agents.enabled',
    'skills.include_instructions',
    'orchestrator.skills.enabled',
    'features.multi_agent',
    'features.multi_agent_v2',
    'features.goals',
    'features.apps',
    'features.plugins',
    'features.skill_search',
  ],
  provider: {
    id: 'ready_gateway',
    wire_api: 'responses',
    requires_openai_auth: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    supports_websockets: false,
  },
  instructionOverrides: {
    baseInstructions: 'omitted',
    model_instructions_file: 'unset',
    compact_prompt: 'unset',
    experimental_compact_prompt_file: 'unset',
  },
  providerToolSurface: {
    ordinaryTurn: 'exact_dynamic_tools_only',
    manualCompaction: [],
  },
}

function renderIsolationConfig(input: {
  contract: CodexRuntimeContracts['nativeIsolationConfigContract']
  gatewayUrl: string
  gatewayToken: string
}): string {
  const { contract, gatewayUrl, gatewayToken } = input
  validateGateway(gatewayUrl, gatewayToken)
  if (digestJson(contract) !== digestJson(supportedNativeIsolationConfigContract)) {
    throw new CodexRuntimeHostError('native_isolation_contract_unsupported')
  }
  return [
    'model = "ready-e0-model"',
    'model_provider = "ready_gateway"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'include_permissions_instructions = false',
    'include_apps_instructions = false',
    'include_collaboration_mode_instructions = false',
    'include_environment_context = false',
    'check_for_update_on_startup = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[model_providers.ready_gateway]',
    'name = "Ready Model Gateway"',
    `base_url = ${tomlString(gatewayUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlString(gatewayToken)}`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'supports_websockets = false',
    '',
    '[tools.experimental_request_user_input]',
    'enabled = false',
    '',
    '[tools.update_plan]',
    'enabled = false',
    '',
    '[agents]',
    'enabled = false',
    '',
    '[skills]',
    'include_instructions = false',
    '',
    '[orchestrator.skills]',
    'enabled = false',
    '',
    '[features]',
    'multi_agent = false',
    'multi_agent_v2 = false',
    'goals = false',
    'apps = false',
    'plugins = false',
    'skill_search = false',
    '',
  ].join('\n')
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

export function prepareCodexRuntimeState(input: {
  userDataPath: string
  gatewayUrl: string
  gatewayToken: string
  contracts: CodexRuntimeContracts
}): PreparedCodexRuntimeState {
  if (!isAbsolute(input.userDataPath)) throw new CodexRuntimeHostError('user_data_path_not_absolute')
  validateGateway(input.gatewayUrl, input.gatewayToken)
  const stateDir = join(input.userDataPath, 'codex-runtime')
  const homeDir = join(stateDir, 'home')
  const codexHome = join(stateDir, 'codex-home')
  const threadCwdRoot = join(stateDir, 'threads')
  const runtimeTmpDir = join(stateDir, 'tmp')
  for (const path of [stateDir, homeDir, codexHome, threadCwdRoot, runtimeTmpDir]) {
    ensurePrivateDirectory(path)
  }
  const config = renderIsolationConfig({
    contract: input.contracts.nativeIsolationConfigContract,
    gatewayUrl: input.gatewayUrl,
    gatewayToken: input.gatewayToken,
  })
  const configPath = join(codexHome, 'config.toml')
  const temporaryPath = join(codexHome, `.config-${randomUUID()}.tmp`)
  writeFileSync(temporaryPath, config, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temporaryPath, 0o600)
  renameSync(temporaryPath, configPath)
  chmodSync(configPath, 0o600)
  return {
    stateDir,
    homeDir,
    codexHome,
    threadCwdRoot,
    tmpDir: runtimeTmpDir,
    configPath,
    configDigest: sha256(config),
    gatewayUrl: input.gatewayUrl,
    gatewayTokenDigest: sha256(input.gatewayToken),
  }
}

function validateOwnershipIdentity(value: string, code: string): void {
  if (!value.trim() || /[\r\n\0]/.test(value)) throw new CodexRuntimeHostError(code)
}

export function buildCodexChildEnvironment(input: {
  state: PreparedCodexRuntimeState
  processLeaseId: string
  sidecarSpawnInstanceId: string
  connectionEpoch: string
  gatewayUrl: string
  gatewayToken: string
}): Record<string, string> {
  validateGateway(input.gatewayUrl, input.gatewayToken)
  if (
    input.gatewayUrl !== input.state.gatewayUrl
    || sha256(input.gatewayToken) !== input.state.gatewayTokenDigest
  ) throw new CodexRuntimeHostError('gateway_state_mismatch')
  validateOwnershipIdentity(input.processLeaseId, 'process_lease_identity_invalid')
  validateOwnershipIdentity(input.sidecarSpawnInstanceId, 'spawn_identity_invalid')
  validateOwnershipIdentity(input.connectionEpoch, 'connection_epoch_invalid')
  if (new Set([
    input.processLeaseId,
    input.sidecarSpawnInstanceId,
    input.connectionEpoch,
  ]).size !== 3) throw new CodexRuntimeHostError('sidecar_identity_reused')

  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: input.state.tmpDir,
    HOME: input.state.homeDir,
    CODEX_HOME: input.state.codexHome,
    READY_CODEX_GATEWAY_URL: input.gatewayUrl,
    READY_CODEX_GATEWAY_TOKEN: input.gatewayToken,
    READY_CODEX_PROCESS_LEASE_ID: input.processLeaseId,
    READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: input.sidecarSpawnInstanceId,
    READY_CODEX_CONNECTION_EPOCH: input.connectionEpoch,
    READY_CODEX_STATE_DIR: input.state.stateDir,
  }
}
