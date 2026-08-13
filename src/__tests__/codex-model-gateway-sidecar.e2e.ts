import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import {
  CodexDatabaseModelGatewayAuthority,
  CodexModelGatewayRepository,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { verifyCodexAutomaticCompactionEvidence } from '../main/modules/agent-control/codex-runtime/codex-automatic-compaction-evidence'
import { CodexModelGateway } from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import type { CodexNativeNotification } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import {
  createCodexAuthorizationForSurface,
  createCodexToolFixture,
  createCodexToolFixtureFromDefinitions,
} from './utils/codex-tool-fixture'
import {
  CodexTurnCollector,
  type CoreTurnCandidate,
} from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import {
  activateCodexGatewaySpawnConfig,
  buildCodexChildEnvironment,
  loadVerifiedCodexRuntime,
  prepareCodexRuntimeState,
  resolveCodexRuntimePaths,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-host'
import { CodexSidecarSession } from '../main/modules/agent-control/codex-runtime/codex-sidecar-session'
import {
  CodexSidecarSupervisor,
  MacCodexProcessInspector,
  NodeCodexSidecarSpawnPort,
} from '../main/modules/agent-control/codex-runtime/codex-sidecar-supervisor'
import { createCodexStartIdentityRegistryForRuntime } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scopeId = 'scope-e3-gateway'
const threadBindingId = 'thread-binding-e3-gateway'
const developerInstructions = 'Ready provides the dynamic product tools declared for this thread. Treat successful tool responses as the authority for external effects. Never claim an external effect without a successful tool response.'

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('fixture_address_invalid'))
      else resolvePort(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function chatSse(input: {
  sequence: number
  hugeUsage: boolean
  finishReason?: 'stop' | 'length'
}): string {
  return [
    { id: `chat-${input.sequence}`, model: 'upstream-chat-model', usage: null, choices: [{ index: 0, delta: { role: 'assistant', reasoning_summary: 'verified' } }] },
    { id: `chat-${input.sequence}`, model: 'upstream-chat-model', usage: null, choices: [{ index: 0, delta: { content: `gateway-answer-${input.sequence}` } }] },
    {
      id: `chat-${input.sequence}`, model: 'upstream-chat-model',
      choices: [{ index: 0, delta: {}, finish_reason: input.finishReason || 'stop' }],
      usage: {
        prompt_tokens: input.hugeUsage ? 1_000_000 : 12,
        completion_tokens: 4,
        total_tokens: input.hugeUsage ? 1_000_004 : 16,
      },
    },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function prepared(
  runId: string,
  reservation: StartIdentityReservationSet,
  runScopeId = scopeId,
  readyToolSurface: PreparedCodexProductRun['readyToolSurface'] = createCodexToolFixture([]).readyToolSurface,
): PreparedCodexProductRun {
  return {
    preparationContract: 'codex_product_run_e1',
    taskId: `task-${runId}`,
    runId,
    conversationAlias: { aliasId: runScopeId, aliasGeneration: 1 },
    ingressBinding: {
      requestId: `request-${runId}`,
      reservationSetId: reservation.reservationSetId,
      reservationEvidenceDigest: reservation.reservationEvidenceDigest,
    },
    ingress: {
      kind: 'user_ingress', attemptKind: 'user_ingress',
      originUserMessageId: `message-${runId}`,
      canonicalCurrentInputRef: {
        messageId: `message-${runId}`,
        input: [{ type: 'text', text: `input-${runId}`, text_elements: [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    },
    resourceAnchorDigest: digestCanonicalJson([]),
    recoveredContextDigest: null,
    readyToolSurface,
    readyTurnToolAuthorization: createCodexAuthorizationForSurface(
      readyToolSurface,
      `authorization-${runId}`,
    ),
    readyToolHostIdentity: {
      scopeId: runScopeId, aliasId: runScopeId,
      authorizationOwnerId: `owner-${runId}`,
      resourceOwnerId: `resource-owner-${runId}`,
    },
    productBudgetSeed: { maxIterations: 8, maxToolCalls: 0, maxParallelToolGroups: 1 },
    neutralProjectionSeed: {
      phase: 'planning', taskTitle: '正在理解需求', taskSummary: '正在整理任务边界',
    },
  }
}

function waitForNotification(
  client: { subscribe(listener: (notification: CodexNativeNotification) => void): () => void },
  predicate: (notification: CodexNativeNotification) => boolean,
  timeoutMs = 20_000,
): Promise<CodexNativeNotification> {
  return new Promise((resolveNotification, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('notification_timeout'))
    }, timeoutMs)
    const unsubscribe = client.subscribe((notification) => {
      if (!predicate(notification)) return
      clearTimeout(timeout)
      unsubscribe()
      resolveNotification(notification)
    })
  })
}

async function waitUntil<T>(read: () => T | null, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = read()
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error('condition_timeout')
}

test('pinned app-server crosses the Ready gateway for product and compaction requests', async (t) => {
  if (process.env.READY_CODEX_E3E !== '1') {
    t.skip('set READY_CODEX_E3E=1 to run the pinned real child')
    return
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('pinned E3 runtime is macOS arm64 only')
    return
  }
  if (skipIfSqliteUnavailable(t, 'Codex model gateway sidecar database')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  const tempRoot = mkdtempSync(join(tmpdir(), 'ready-codex-e3-'))
  const upstreamBodies: Record<string, unknown>[] = []
  const upstreamPaths: string[] = []
  const upstreamAuthPresent: boolean[] = []
  let upstreamSequence = 0
  let toolExecutions = 0
  const upstream = createServer(async (request, response) => {
    upstreamSequence += 1
    upstreamPaths.push(request.url || '')
    upstreamAuthPresent.push(Boolean(request.headers.authorization))
    const upstreamBody = await readBody(request)
    upstreamBodies.push(upstreamBody)
    const upstreamText = JSON.stringify(upstreamBody)
    const rawMetadata = (upstreamBody.client_metadata as Record<string, unknown> | undefined)
      ?.['x-codex-turn-metadata']
    let readyRunId = ''
    if (typeof rawMetadata === 'string') {
      const metadata = JSON.parse(rawMetadata) as Record<string, unknown>
      if (typeof metadata.readyRunId === 'string') readyRunId = metadata.readyRunId
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (request.url === '/v1/responses') {
      if (
        readyRunId === 'run-native-tool-secret'
        || readyRunId === 'run-native-tool-incomplete-item'
        || upstreamText.includes('TRIGGER_NATIVE_TOOL_SECRET')
        || upstreamText.includes('TRIGGER_NATIVE_TOOL_INCOMPLETE_ITEM')
      ) {
        const secretArguments = readyRunId === 'run-native-tool-secret'
          || upstreamText.includes('TRIGGER_NATIVE_TOOL_SECRET')
        const argumentsValue = secretArguments
          ? '{"query":"Bearer other-token"}'
          : '{"query":"verified"}'
        const incompleteItem = readyRunId === 'run-native-tool-incomplete-item'
          || upstreamText.includes('TRIGGER_NATIVE_TOOL_INCOMPLETE_ITEM')
        const item = {
          type: 'function_call', id: `native-tool-item-${upstreamSequence}`,
          call_id: `native-tool-call-${upstreamSequence}`,
          name: 'ready_read_probe', arguments: argumentsValue,
          ...(incompleteItem ? { status: 'incomplete' } : {}),
        }
        response.end([
          {
            type: 'response.created',
            response: {
              id: `native-tool-boundary-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'in_progress', output: [],
            },
          },
          {
            type: 'response.output_item.added', output_index: 0,
            item: { ...item, arguments: '', status: 'in_progress' },
          },
          {
            type: 'response.function_call_arguments.delta', output_index: 0,
            item_id: item.id, delta: argumentsValue,
          },
          {
            type: 'response.function_call_arguments.done', output_index: 0,
            item_id: item.id, arguments: argumentsValue,
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: `native-tool-boundary-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'completed', output: [item],
              usage: {
                input_tokens: 8, output_tokens: 2, total_tokens: 10,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        return
      }
      if (
        readyRunId === 'run-native-message-no-terminal'
        || upstreamText.includes('TRIGGER_NATIVE_MESSAGE_NO_TERMINAL')
      ) {
        const item = {
          type: 'message', id: `native-no-terminal-item-${upstreamSequence}`,
          role: 'assistant', content: [{ type: 'output_text', text: 'orphan-native-answer' }],
        }
        response.end([
          {
            type: 'response.created',
            response: {
              id: `native-no-terminal-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'in_progress', output: [],
            },
          },
          {
            type: 'response.output_item.added', output_index: 0,
            item: { ...item, content: [] },
          },
          {
            type: 'response.output_text.delta', output_index: 0, content_index: 0,
            item_id: item.id, delta: 'orphan-native-answer',
          },
          {
            type: 'response.output_text.done', output_index: 0, content_index: 0,
            item_id: item.id, text: 'orphan-native-answer',
          },
          { type: 'response.output_item.done', output_index: 0, item },
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        return
      }
      if (
        readyRunId === 'run-native-tool-mutation'
        || upstreamText.includes('TRIGGER_NATIVE_TOOL_MUTATION')
      ) {
        response.end([
          {
            type: 'response.created',
            response: {
              id: `native-tool-mutation-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'in_progress', output: [],
            },
          },
          {
            type: 'response.output_item.added', output_index: 0,
            item: {
              type: 'function_call', id: 'native-tool-item', call_id: 'native-tool-call',
              name: 'ready_read_probe', arguments: '',
            },
          },
          {
            type: 'response.function_call_arguments.delta', output_index: 0,
            item_id: 'native-tool-item', delta: '{"query":"blocked"}',
          },
          {
            type: 'response.function_call_arguments.done', output_index: 0,
            item_id: 'native-tool-item', arguments: '{"query":"blocked"}',
          },
          {
            type: 'response.output_item.done', output_index: 0,
            item: {
              type: 'function_call', id: 'native-tool-item', call_id: 'native-tool-call',
              name: 'ready_read_probe_evil', arguments: '{"query":"blocked"}',
            },
          },
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        return
      }
      if (
        readyRunId === 'run-native-incomplete'
        || upstreamText.includes('TRIGGER_NATIVE_INCOMPLETE')
      ) {
        const item = {
          type: 'message', id: `native-incomplete-item-${upstreamSequence}`,
          role: 'assistant', content: [{ type: 'output_text', text: 'partial-native-answer' }],
        }
        response.end([
          {
            type: 'response.created',
            response: {
              id: `native-incomplete-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'in_progress', output: [],
            },
          },
          {
            type: 'response.output_item.added', output_index: 0,
            item: { ...item, content: [] },
          },
          {
            type: 'response.output_text.delta', output_index: 0, content_index: 0,
            item_id: item.id, delta: 'partial-native-answer',
          },
          {
            type: 'response.output_text.done', output_index: 0, content_index: 0,
            item_id: item.id, text: 'partial-native-answer',
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.incomplete',
            response: {
              id: `native-incomplete-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'incomplete', output: [item],
              incomplete_details: { reason: 'max_output_tokens' },
              usage: {
                input_tokens: 10, output_tokens: 3, total_tokens: 13,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        return
      }
      if (readyRunId === 'run-native-flat-error' || upstreamText.includes('TRIGGER_NATIVE_FLAT_ERROR')) {
        response.end(`event: error\ndata: ${JSON.stringify({
          type: 'error', code: 'server_error', message: 'fixture flat error',
          param: null, sequence_number: 0,
        })}\n\n`)
        return
      }
      if (
        readyRunId === 'run-native-first-event-failure'
        || upstreamText.includes('TRIGGER_NATIVE_FAILURE_BEFORE_CREATED')
      ) {
        response.end(`event: response.in_progress\ndata: ${JSON.stringify({
          type: 'response.in_progress',
          response: {
            id: `native-first-event-failure-${upstreamSequence}`,
            model: 'upstream-native-model', status: 'in_progress', output: [],
          },
        })}\n\n`)
        return
      }
      response.end([
        {
          type: 'response.created',
          response: {
            id: `native-failure-${upstreamSequence}`,
            model: 'upstream-native-model',
            status: 'in_progress',
            output: [],
          },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'shell_call', id: 'forbidden-shell', command: 'touch forbidden' },
        },
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      return
    }
    if (
      readyRunId === 'run-tool-schema-invalid'
      || upstreamText.includes('TRIGGER_TOOL_SCHEMA_INVALID')
    ) {
      response.end([
        {
          id: `chat-${upstreamSequence}`, model: 'upstream-chat-model',
          choices: [{ index: 0, logprobs: null, delta: { tool_calls: [{
            index: 0, id: 'call-schema-invalid', type: 'function',
            function: {
              name: 'ready_read_probe', arguments: '{"query":1,"extra":true}',
            },
          }] } }],
        },
        {
          id: `chat-${upstreamSequence}`, model: 'upstream-chat-model',
          choices: [{ index: 0, logprobs: null, delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
            prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
            completion_tokens_details: {
              reasoning_tokens: 0, audio_tokens: 0,
              accepted_prediction_tokens: 0, rejected_prediction_tokens: 0,
            },
          },
        },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
      return
    }
    if (
      readyRunId === 'run-tool-prefix-mutation'
      || upstreamText.includes('TRIGGER_TOOL_PREFIX_MUTATION')
    ) {
      response.end([
        {
          id: `chat-${upstreamSequence}`, model: 'upstream-chat-model',
          choices: [{ index: 0, delta: { tool_calls: [{
            index: 0, id: 'call-prefix-mutation', type: 'function',
            function: { name: 'ready_read_probe', arguments: '{"query":' },
          }] } }],
        },
        {
          id: `chat-${upstreamSequence}`, model: 'upstream-chat-model',
          choices: [{ index: 0, delta: { tool_calls: [{
            index: 0, function: { name: '_evil', arguments: '"blocked"}' },
          }] } }],
        },
        {
          id: `chat-${upstreamSequence}`, model: 'upstream-chat-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
      return
    }
    response.end(chatSse({
      sequence: upstreamSequence,
      hugeUsage: upstreamSequence === 1,
      finishReason: readyRunId === 'run-length-incomplete'
        || upstreamText.includes('TRIGGER_LENGTH_INCOMPLETE')
        ? 'length'
        : 'stop',
    }))
  })
  const upstreamPort = await listen(upstream)
  const snapshot = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-e3',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'provider-secret-e3', model: 'upstream-chat-model',
      agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on',
      contextWindowOverride: 272_000,
    },
    maxRetries: 0,
  })
  const nativeFailureSnapshot = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native-e3',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'provider-secret-e3', model: 'upstream-native-model',
      agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  let gateway: CodexModelGateway | null = null
  let session: CodexSidecarSession | null = null
  const spawnCapabilities: Array<{ spawnId: string; token: string }> = []
  const stderr: string[] = []
  const previousCanary = process.env.READY_E3_HOST_SECRET_CANARY
  process.env.READY_E3_HOST_SECRET_CANARY = 'host-secret-e3-must-not-cross'
  try {
    db.exec(`
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY);
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL,
        timestamp TEXT NOT NULL, meta_json TEXT NOT NULL
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        status TEXT NOT NULL, execution_binding_json TEXT
      );
      CREATE TABLE run_meta (
        run_id TEXT PRIMARY KEY, task_id TEXT, scope_id TEXT,
        status TEXT NOT NULL, execution_binding_json TEXT
      );
    `)
    __runMigrationForTests('088_codex_runtime_bindings', db as unknown as MigrationDatabase)
    __runMigrationForTests('089_codex_runtime_evidence_guards', db as unknown as MigrationDatabase)
    __runMigrationForTests('090_codex_model_gateway_authority', db as unknown as MigrationDatabase)
    __runMigrationForTests('091_codex_model_gateway_turn_claim', db as unknown as MigrationDatabase)
    __runMigrationForTests('092_codex_tool_bridge', db as unknown as MigrationDatabase)
    __runMigrationForTests('093_codex_e5_budget_admission', db as unknown as MigrationDatabase)
    __runMigrationForTests('094_codex_host_failure_closeout_readback', db as unknown as MigrationDatabase)
    __runMigrationForTests('095_codex_lifecycle_recovery_evidence', db as unknown as MigrationDatabase)
    __runMigrationForTests('096_codex_fence_owner_transfer', db as unknown as MigrationDatabase)
    __runMigrationForTests('097_codex_gateway_completion_evidence', db as unknown as MigrationDatabase)
    __runMigrationForTests('098_codex_manual_compaction_recovery_evidence', db as unknown as MigrationDatabase)
    __runMigrationForTests('101_codex_manual_compaction_item_identity', db as unknown as MigrationDatabase)
    const repository = new CodexBindingRepository(db as unknown as DatabaseConnection)
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      repository,
    )
    gatewayRepository.storeSnapshot({ ...snapshot, createdAt: new Date().toISOString() })
    gatewayRepository.storeSnapshot({
      ...nativeFailureSnapshot,
      createdAt: new Date().toISOString(),
    })
    gateway = new CodexModelGateway({
      spawnBound: true,
      authority: new CodexDatabaseModelGatewayAuthority(gatewayRepository),
      credentials: { resolve() { return 'provider-secret-e3' } },
    })
    const gatewayAddress = await gateway.start()
    const paths = resolveCodexRuntimePaths({
      appPath: repoRoot, resourcesPath: join(repoRoot, 'assets'), isPackaged: false,
    })
    const runtime = loadVerifiedCodexRuntime(paths)
    const state = prepareCodexRuntimeState({
      userDataPath: tempRoot,
      gatewayUrl: `${gatewayAddress.url}/v1`,
      contracts: runtime.contracts,
    })
    const threadCwd = join(state.threadCwdRoot, threadBindingId)
    mkdirSync(threadCwd, { recursive: true })
    const capture = JSON.parse(readFileSync(
      join(repoRoot, 'assets/codex-runtime/fixtures/native-protocol-capture.json'),
      'utf8',
    )) as { provider: { requests: Array<{ request: Record<string, unknown> }> } }
    const capturedRequest = capture.provider.requests[0].request
    const instructionDigest = instructionTranscriptDigest(
      capturedRequest.instructions,
      capturedRequest.input,
    )
    const inspector = new MacCodexProcessInspector()
    const mainProcess = (await inspector.list()).find((entry) => entry.pid === process.pid)
    assert.ok(mainProcess)
    const supervisor = new CodexSidecarSupervisor({
      runtime,
      state,
      spawnCapability: {
        activate(identities) {
          const capability = gateway!.activateSpawn(identities.sidecarSpawnInstanceId)
          spawnCapabilities.push({
            spawnId: identities.sidecarSpawnInstanceId,
            token: capability.bearerToken,
          })
          const gatewaySpawnConfig = activateCodexGatewaySpawnConfig({
            state,
            sidecarSpawnInstanceId: identities.sidecarSpawnInstanceId,
            gatewayUrl: `${capability.url}/v1`,
            gatewayToken: capability.bearerToken,
            contracts: runtime.contracts,
          })
          return buildCodexChildEnvironment({ state, ...identities, gatewaySpawnConfig })
        },
        revoke(sidecarSpawnInstanceId) { gateway!.revokeSpawn(sidecarSpawnInstanceId) },
      },
      leaseStore: repository,
      inspector,
      spawnPort: new NodeCodexSidecarSpawnPort(),
      ownerMainBootId: randomUUID(),
      ownerMainPid: process.pid,
      ownerMainProcessStartIdentity: mainProcess.processStartIdentity,
      onStderr: (text) => stderr.push(text),
    })
    const registry = createCodexStartIdentityRegistryForRuntime(runtime)
    session = new CodexSidecarSession({
      runtime,
      state,
      repository,
      supervisor,
      evidenceResolver: { async resolveTypedRejection() { return { resolution: 'unknown' } } },
      serverRequestExecutor: {
        async executeServerRequest(input) {
          toolExecutions += 1
          const result = {
            contentItems: [{ type: 'inputText' as const, text: 'UNEXPECTED_TOOL_RESULT' }],
            success: true,
          }
          const identity = {
            codexThreadId: input.params.threadId,
            codexTurnId: input.params.turnId,
            codexCallId: input.params.callId,
            readyActionId: `unexpected-${input.params.callId}`,
            connectionEpoch: input.connectionEpoch,
            requestRpcId: String(input.requestId),
            toolResponseDigest: digestCanonicalJson(result),
          }
          return {
            result,
            deliveryAttempt: {
              attemptId: `codex-tool-delivery-${digestCanonicalJson(identity)}`,
              ...identity,
            },
          }
        },
        confirmServerResponseTransportWrite() {},
      },
      requestTimeoutMs: 20_000,
      inboundDeadlineMs: 20_000,
      inboundMaxFrames: 256,
      inboundMaxBytes: 2 * 1024 * 1024,
      now: () => new Date().toISOString(),
      nowMs: Date.now,
    })
    repository.createEmptyAliasGeneration({
      threadBindingId, aliasId: scopeId, aliasGeneration: 1, readyScopeId: scopeId,
      runtimeManifestDigest: runtime.manifestDigest, protocolSchemaDigest: 'protocol-schema-e3',
      createdAt: new Date().toISOString(),
    })

    const snapshotByRun = new Map<string, typeof snapshot>()
    const reserveAndAdmit = (
      runId: string,
      existingThread: boolean,
      upstreamSnapshot = snapshot,
      runScopeId = scopeId,
      runThreadBindingId = threadBindingId,
      runThreadCwd = threadCwd,
      readyToolSurface?: PreparedCodexProductRun['readyToolSurface'],
    ) => {
      const reserved = registry.reserve({ scopeId: runScopeId, existingThread })
      assert.equal(reserved.ok, true)
      if (!reserved.ok) throw new Error(reserved.code)
      const run = prepared(runId, reserved.reservation, runScopeId, readyToolSurface)
      const executionBinding = { schemaVersion: 1, runId: run.runId }
      const parentMeta = { requestId: run.ingressBinding.requestId }
      const parentTimestamp = '2026-08-07T00:00:00.000Z'
      const messageContent = run.ingress.canonicalCurrentInputRef.input
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
      db.prepare(`INSERT OR IGNORE INTO chat_conversations (id) VALUES (?)`).run(runScopeId)
      db.prepare(`
        INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
        VALUES (?, ?, 'user', ?, ?, ?, 0)
      `).run(
        run.ingress.originUserMessageId,
        runScopeId,
        messageContent,
        parentTimestamp,
        JSON.stringify(parentMeta),
      )
      db.prepare(`
        INSERT INTO task_projections (
          task_id, run_id, scope_id, status, execution_binding_json, message_visibility_epoch
        ) VALUES (?, ?, ?, 'running', ?, 0)
      `).run(
        run.taskId,
        run.runId,
        runScopeId,
        JSON.stringify(executionBinding),
      )
      db.prepare(`
        INSERT INTO run_meta (
          run_id, task_id, scope_id, status, execution_binding_json, message_visibility_epoch
        ) VALUES (?, ?, ?, 'running', ?, 0)
      `).run(
        run.runId,
        run.taskId,
        runScopeId,
        JSON.stringify(executionBinding),
      )
      const admissionInput = {
        prepared: run,
        reservation: reserved.reservation,
        ownerMainBootId: 'main-boot-e3',
        admittedAt: new Date().toISOString(),
        ingressAdmittedRevision: 1,
        threadBindingId: runThreadBindingId,
        isolatedThreadCwd: runThreadCwd,
        turnRequestId: `client-message-${runId}`,
        runtimeManifestDigest: runtime.manifestDigest,
        protocolSchemaDigest: 'protocol-schema-e3',
        instructionContractDigest: instructionDigest,
        codexModel: 'ready-e0-model',
        upstreamProfileSnapshotRef: upstreamSnapshot.snapshotRef,
        upstreamProfileSnapshotDigest: upstreamSnapshot.snapshotDigest,
        additionalContextDigest: digestCanonicalJson([]),
        turnContractDigest: `turn-contract-${runId}`,
        messageVisibilityEpoch: 0,
        readyParentReceipt: {
          messageRole: 'user' as const,
          messageContent,
          messageTimestamp: parentTimestamp,
          messageMetaDigest: digestCanonicalJson(parentMeta),
          executionBindingDigest: digestCanonicalJson(executionBinding),
        },
      }
      const admission: CodexAdmittedBindingInput = {
        ...admissionInput,
        ingressAdmittedDigest: buildCodexIngressAdmittedDigest(admissionInput),
      }
      repository.admitProductBindings(admission)
      snapshotByRun.set(runId, upstreamSnapshot)
      return run
    }

    const firstRun = reserveAndAdmit('run-first', false)
    const startedSession = await session.startAndInitialize({
      registry,
      snapshot: repository.readRecoverySnapshot(() => false),
    })
    let client = session.getClient()
    const startedThread = await client.threadStart({
      model: 'ready-e0-model', modelProvider: 'ready_gateway',
      allowProviderModelFallback: false, cwd: threadCwd,
      approvalPolicy: 'never', sandbox: 'read-only',
      runtimeWorkspaceRoots: [], environments: [],
      config: { model_context_window: 272_000 }, dynamicTools: [],
      developerInstructions,
    })
    const closeoutRun = (
      run: PreparedCodexProductRun,
      status: 'completed' | 'failed',
      candidate: CoreTurnCandidate,
    ): void => {
      assert.equal(candidate.kind, 'native_terminal')
      if (candidate.kind !== 'native_terminal') throw new Error('native_terminal_missing')
      const closeoutAt = new Date().toISOString()
      repository.recordEngineTerminalCandidate({
        readyRunId: run.runId,
        codexThreadId: candidate.codexThreadId,
        codexTurnId: candidate.codexTurnId,
        engineOutcome: candidate.engineOutcome,
        candidate,
        recordedAt: closeoutAt,
      })
      repository.recordToolPublicationReceipt({ readyRunId: run.runId, recordedAt: closeoutAt })
      const terminalMeta = {
        taskId: run.taskId,
        runId: run.runId,
        terminalReason: status === 'completed' ? 'done' : 'failed',
      }
      const messageId = `assistant:${run.taskId}:${run.runId}:terminal`
      const acceptedText = candidate.candidateSelection.kind === 'accepted'
        ? candidate.candidateText
        : null
      const productTerminalDigest = status === 'completed' && acceptedText !== null
        ? workflowDigest({
            id: messageId,
            conversationId: run.readyToolHostIdentity.scopeId,
            role: 'assistant',
            content: acceptedText,
            timestamp: closeoutAt,
            meta: terminalMeta,
          })
        : `terminal-${run.runId}-${status}`
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`UPDATE task_projections SET status = ? WHERE task_id = ?`).run(
          status,
          run.taskId,
        )
        if (status === 'completed' && acceptedText !== null) {
          db.prepare(`
            INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
            VALUES (?, ?, 'assistant', ?, ?, ?, 0)
          `).run(
            messageId,
            run.readyToolHostIdentity.scopeId,
            acceptedText,
            closeoutAt,
            JSON.stringify(terminalMeta),
          )
        }
        repository.completeCanonicalProductCloseoutInOpenTransaction({
          readyRunId: run.runId,
          productTerminalDigest,
          closeoutAt,
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    const runTurn = async (
      run: PreparedCodexProductRun,
      text: string,
      expectedStatus: 'completed' | 'failed' = 'completed',
      runThreadId = startedThread.thread.id,
    ) => {
      const terminalPromise = waitForNotification(client, (notification) => (
        notification.method === 'turn/completed'
        && notification.params.threadId === runThreadId
      ))
      const started = await client.turnStart({
        threadId: runThreadId,
        clientUserMessageId: `client-message-${run.runId}`,
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'ready-e0-model',
            reasoning_effort: snapshotByRun.get(run.runId)?.snapshot.reasoningEffort || null,
            developer_instructions: null,
          },
        },
        environments: [],
        input: [{ type: 'text', text, text_elements: [] }],
        additionalContext: {},
        responsesapiClientMetadata: {
          readyRunId: run.runId,
          toolSurfaceDigest: run.readyToolSurface.toolSurfaceDigest,
          turnContractDigest: `turn-contract-${run.runId}`,
          upstreamProfileSnapshotDigest: snapshotByRun.get(run.runId)?.snapshotDigest,
        },
      })
      const terminal = await terminalPromise
      assert.equal(terminal.method, 'turn/completed')
      if (terminal.method !== 'turn/completed') throw new Error('terminal_missing')
      assert.equal(terminal.params.turn.id, started.turn.id)
      if (terminal.params.turn.status !== expectedStatus) {
        const readback = await client.threadRead({ threadId: runThreadId, includeTurns: true })
        assert.equal(
          terminal.params.turn.status,
          expectedStatus,
          JSON.stringify({ readback, stderr }),
        )
      }
      const candidate = new CodexTurnCollector(client).buildReadbackCandidate({
        readyTaskId: run.taskId,
        readyRunId: run.runId,
        scopeId: run.readyToolHostIdentity.scopeId,
        codexThreadId: runThreadId,
        actionReceiptRefs: [],
        interactionState: null,
        waitingFor: null,
        terminalReasonCandidate: expectedStatus === 'completed' ? 'done' : 'provider_failed',
        abortInitiator: null,
        budgetState: {},
        contextState: {},
        providerDiagnostics: {},
        recoveryCheckpointRef: null,
        browserContinuationRef: null,
        browserProofRefs: [],
        otherProofRefs: [],
        projectionPatchRefs: [],
        allowNullPhaseFallback: true,
      }, terminal.params.turn)
      closeoutRun(run, expectedStatus, candidate)
      return { turnId: started.turn.id }
    }
    const collectFailedTurn = async (
      run: PreparedCodexProductRun,
      text: string,
      runThreadId: string,
    ) => {
      const candidate = await new CodexTurnCollector(client).collect({
        readyTaskId: run.taskId,
        readyRunId: run.runId,
        scopeId: run.readyToolHostIdentity.scopeId,
        codexThreadId: runThreadId,
        startTurn: () => client.turnStart({
          threadId: runThreadId,
          clientUserMessageId: `client-message-${run.runId}`,
          collaborationMode: {
            mode: 'default',
            settings: {
              model: 'ready-e0-model',
              reasoning_effort: snapshotByRun.get(run.runId)?.snapshot.reasoningEffort || null,
              developer_instructions: null,
            },
          },
          environments: [],
          input: [{ type: 'text', text, text_elements: [] }],
          additionalContext: {},
          responsesapiClientMetadata: {
            readyRunId: run.runId,
            toolSurfaceDigest: run.readyToolSurface.toolSurfaceDigest,
            turnContractDigest: `turn-contract-${run.runId}`,
            upstreamProfileSnapshotDigest: snapshotByRun.get(run.runId)?.snapshotDigest,
          },
        }),
        terminalTimeoutMs: 20_000,
        actionReceiptRefs: [],
        interactionState: null,
        waitingFor: null,
        terminalReasonCandidate: 'provider_failed',
        abortInitiator: null,
        budgetState: {},
        contextState: {},
        providerDiagnostics: {},
        recoveryCheckpointRef: null,
        browserContinuationRef: null,
        browserProofRefs: [],
        otherProofRefs: [],
        projectionPatchRefs: [],
        allowNullPhaseFallback: true,
        allowDirectProvisionalStream: false,
        onProvisionalDelta: () => undefined,
      })
      assert.equal(candidate.kind, 'native_terminal')
      assert.equal(candidate.engineOutcome, 'failed', JSON.stringify({ candidate, stderr }))
      assert.deepEqual(candidate.candidateSelection, {
        kind: 'none', code: 'terminal_not_completed',
      })
      assert.equal(candidate.candidateText, null)
      assert.equal(candidate.candidateDigest, null)
      closeoutRun(run, 'failed', candidate)
      return candidate
    }

    await runTurn(firstRun, `ARM_AUTOMATIC_COMPACTION\n${'x '.repeat(230_000)}`)
    const secondRun = reserveAndAdmit('run-second', true)
    const secondTurn = await runTurn(secondRun, 'OBSERVE_AUTOMATIC_COMPACTION')
    const automaticReadback = await client.threadRead({
      threadId: startedThread.thread.id,
      includeTurns: true,
    })
    const automaticRows = gatewayRepository.readTurnGatewayEvidence({
      readyRunId: secondRun.runId,
      codexThreadId: startedThread.thread.id,
      codexTurnId: secondTurn.turnId,
    })
    assert.equal(automaticRows.length, 2, JSON.stringify(automaticRows))
    assert.ok(
      automaticRows[1].inputTotalStringCharacters < automaticRows[0].inputTotalStringCharacters
        && automaticRows[1].inputMaxStringCharacters < automaticRows[0].inputMaxStringCharacters,
      JSON.stringify(automaticRows),
    )
    const automaticEvidence = verifyCodexAutomaticCompactionEvidence({
      gatewayRepository,
      readyRunId: secondRun.runId,
      codexThreadId: startedThread.thread.id,
      codexTurnId: secondTurn.turnId,
      upstreamProfileSnapshotDigest: snapshot.snapshotDigest,
      productToolSurfaceDigest: secondRun.readyToolSurface.toolSurfaceDigest,
      thread: automaticReadback.thread,
    })
    assert.ok(automaticEvidence)
    assert.ok(automaticEvidence.automaticRequestSequence < automaticEvidence.automaticResponseSequence)
    assert.ok(automaticEvidence.automaticResponseSequence < automaticEvidence.successorProductRequestSequence)
    assert.ok(automaticEvidence.successorProductRequestSequence < automaticEvidence.successorProductResponseSequence)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_manual_compaction_bindings
       WHERE codex_thread_id = ?
    `).get<{ count: number }>(startedThread.thread.id)?.count, 0)

    repository.beginManualCompaction({
      manualCompactionId: 'manual-e3', threadBindingId,
      ownerMainBootId: 'main-boot-e3', codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: snapshot.snapshotRef,
      upstreamProfileSnapshotDigest: snapshot.snapshotDigest,
      providerSnapshot: snapshot.snapshot,
      credentialReferenceId: snapshot.snapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]),
      preDispatchThreadReadDigest: 'pre-dispatch-thread-read',
      preDispatchTurnIds: [],
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
      createdAt: new Date().toISOString(),
    })
    session.getInboundBuffer().registerProvisionalManualCompaction({
      manualCompactionId: 'manual-e3',
      connectionEpoch: startedSession.connectionEpoch,
      threadId: startedThread.thread.id,
      deadlineAtMs: Date.now() + 20_000,
    })
    await client.threadCompactStart({ threadId: startedThread.thread.id })
    const manualEvidence = await waitUntil(() => (
      session?.getInboundBuffer().readManualCompactionEvidence('manual-e3') || null
    ))
    assert.equal(manualEvidence.terminalStatus, 'completed')
    const compactRead = await client.threadRead({ threadId: startedThread.thread.id, includeTurns: true })
    const compactTurn = compactRead.thread.turns.find((turn) => turn.id === manualEvidence.turnId)
    const readbackCompactionItems = compactTurn?.items.filter((item) => item.type === 'contextCompaction') || []
    assert.equal(readbackCompactionItems.length, 1)
    repository.consumeManualCompaction({
      manualCompactionId: 'manual-e3',
      codexCompactionTurnId: manualEvidence.turnId,
      notificationContextCompactionItemId: manualEvidence.contextCompactionItemId,
      contextCompactionItemId: readbackCompactionItems[0].id,
      threadReadDigest: digestCanonicalJson(compactRead.thread),
      terminalEvidenceDigest: digestCanonicalJson(compactTurn),
      gatewayRequestReceiptId: 'gateway-receipt-e3',
      gatewayRequestEvidenceDigest: 'gateway-request-evidence-e3',
      gatewayResponseEvidenceDigest: 'gateway-response-evidence-e3',
      consumedAt: new Date().toISOString(),
    })
    await session.getInboundBuffer().reconcileTurn({
      bindingId: 'manual-e3',
      connectionEpoch: startedSession.connectionEpoch,
      threadId: startedThread.thread.id,
      nativeTurnId: manualEvidence.turnId,
    })

    const nativeScopeId = 'scope-e3-native-failure'
    const nativeThreadBindingId = 'thread-binding-e3-native-failure'
    const nativeThreadCwd = join(state.threadCwdRoot, nativeThreadBindingId)
    mkdirSync(nativeThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: nativeThreadBindingId,
      aliasId: nativeScopeId,
      aliasGeneration: 1,
      readyScopeId: nativeScopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e3',
      createdAt: new Date().toISOString(),
    })
    const nativeFailureRun = reserveAndAdmit(
      'run-native-failure',
      false,
      nativeFailureSnapshot,
      nativeScopeId,
      nativeThreadBindingId,
      nativeThreadCwd,
    )
    const nativeThread = await client.threadStart({
      model: 'ready-e0-model', modelProvider: 'ready_gateway',
      allowProviderModelFallback: false, cwd: nativeThreadCwd,
      approvalPolicy: 'never', sandbox: 'read-only',
      runtimeWorkspaceRoots: [], environments: [], config: null, dynamicTools: [],
      developerInstructions,
    })
    await runTurn(
      nativeFailureRun,
      'TRIGGER_VERIFIED_NATIVE_FAILURE',
      'failed',
      nativeThread.thread.id,
    )
    assert.equal(upstreamPaths.at(-1), '/v1/responses')

    const nativeFirstEventFailureRun = reserveAndAdmit(
      'run-native-first-event-failure',
      true,
      nativeFailureSnapshot,
      nativeScopeId,
      nativeThreadBindingId,
      nativeThreadCwd,
    )
    await runTurn(
      nativeFirstEventFailureRun,
      'TRIGGER_NATIVE_FAILURE_BEFORE_CREATED',
      'failed',
      nativeThread.thread.id,
    )
    assert.equal(upstreamPaths.at(-1), '/v1/responses')

    const nativeFlatErrorRun = reserveAndAdmit(
      'run-native-flat-error',
      true,
      nativeFailureSnapshot,
      nativeScopeId,
      nativeThreadBindingId,
      nativeThreadCwd,
    )
    await runTurn(
      nativeFlatErrorRun,
      'TRIGGER_NATIVE_FLAT_ERROR',
      'failed',
      nativeThread.thread.id,
    )
    assert.equal(upstreamPaths.at(-1), '/v1/responses')

    const lengthScopeId = 'scope-e3-length-incomplete'
    const lengthThreadBindingId = 'thread-binding-e3-length-incomplete'
    const lengthThreadCwd = join(state.threadCwdRoot, lengthThreadBindingId)
    mkdirSync(lengthThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: lengthThreadBindingId,
      aliasId: lengthScopeId,
      aliasGeneration: 1,
      readyScopeId: lengthScopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e3',
      createdAt: new Date().toISOString(),
    })
    const lengthRun = reserveAndAdmit(
      'run-length-incomplete',
      false,
      snapshot,
      lengthScopeId,
      lengthThreadBindingId,
      lengthThreadCwd,
    )
    const lengthThread = await client.threadStart({
      model: 'ready-e0-model', modelProvider: 'ready_gateway',
      allowProviderModelFallback: false, cwd: lengthThreadCwd,
      approvalPolicy: 'never', sandbox: 'read-only',
      runtimeWorkspaceRoots: [], environments: [], config: null, dynamicTools: [],
      developerInstructions,
    })
    const upstreamCountBeforeLength = upstreamBodies.length
    await collectFailedTurn(
      lengthRun,
      'TRIGGER_LENGTH_INCOMPLETE',
      lengthThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeLength + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/chat/completions')

    const nativeIncompleteRun = reserveAndAdmit(
      'run-native-incomplete',
      true,
      nativeFailureSnapshot,
      nativeScopeId,
      nativeThreadBindingId,
      nativeThreadCwd,
    )
    const upstreamCountBeforeNativeIncomplete = upstreamBodies.length
    await collectFailedTurn(
      nativeIncompleteRun,
      'TRIGGER_NATIVE_INCOMPLETE',
      nativeThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeNativeIncomplete + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/responses')

    const nativeMessageNoTerminalRun = reserveAndAdmit(
      'run-native-message-no-terminal',
      true,
      nativeFailureSnapshot,
      nativeScopeId,
      nativeThreadBindingId,
      nativeThreadCwd,
    )
    const upstreamCountBeforeNativeMessageNoTerminal = upstreamBodies.length
    await collectFailedTurn(
      nativeMessageNoTerminalRun,
      'TRIGGER_NATIVE_MESSAGE_NO_TERMINAL',
      nativeThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeNativeMessageNoTerminal + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/responses')

    const toolScopeId = 'scope-e3-tool-prefix-mutation'
    const toolThreadBindingId = 'thread-binding-e3-tool-prefix-mutation'
    const toolThreadCwd = join(state.threadCwdRoot, toolThreadBindingId)
    const toolParameters = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    }
    const responseTool = {
      type: 'function',
      name: 'ready_read_probe',
      description: 'Read one deterministic fixture value.',
      strict: false,
      parameters: toolParameters,
    }
    const toolDefinition: ToolDefinition = {
      name: responseTool.name, groupId: 'agent_interaction', domain: 'document', kind: 'read',
      concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
      supportsTextBridge: true, projectionHint: null, description: responseTool.description,
      schema: toolParameters, executionVisibility: 'model', resultShape: 'json',
    }
    const toolSurface = createCodexToolFixtureFromDefinitions([toolDefinition]).readyToolSurface
    assert.equal(toolSurface.toolSurfaceDigest, digestCanonicalJson([responseTool]))
    mkdirSync(toolThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: toolThreadBindingId,
      aliasId: toolScopeId,
      aliasGeneration: 1,
      readyScopeId: toolScopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e3',
      createdAt: new Date().toISOString(),
    })
    const toolRun = reserveAndAdmit(
      'run-tool-prefix-mutation',
      false,
      snapshot,
      toolScopeId,
      toolThreadBindingId,
      toolThreadCwd,
      toolSurface,
    )
    const toolThread = await client.threadStart({
      model: 'ready-e0-model', modelProvider: 'ready_gateway',
      allowProviderModelFallback: false, cwd: toolThreadCwd,
      approvalPolicy: 'never', sandbox: 'read-only',
      runtimeWorkspaceRoots: [], environments: [], config: null,
      dynamicTools: [{
        type: 'function',
        name: responseTool.name,
        description: responseTool.description,
        inputSchema: toolParameters,
      }],
      developerInstructions,
    })
    const upstreamCountBeforeToolMutation = upstreamBodies.length
    await collectFailedTurn(
      toolRun,
      'TRIGGER_TOOL_PREFIX_MUTATION',
      toolThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeToolMutation + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/chat/completions')
    assert.equal(toolExecutions, 0)

    const toolSchemaRun = reserveAndAdmit(
      'run-tool-schema-invalid',
      true,
      snapshot,
      toolScopeId,
      toolThreadBindingId,
      toolThreadCwd,
      toolSurface,
    )
    const upstreamCountBeforeToolSchema = upstreamBodies.length
    await collectFailedTurn(
      toolSchemaRun,
      'TRIGGER_TOOL_SCHEMA_INVALID',
      toolThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeToolSchema + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/chat/completions')
    assert.equal(toolExecutions, 0)

    const nativeToolScopeId = 'scope-e3-native-tool-mutation'
    const nativeToolThreadBindingId = 'thread-binding-e3-native-tool-mutation'
    const nativeToolThreadCwd = join(state.threadCwdRoot, nativeToolThreadBindingId)
    mkdirSync(nativeToolThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: nativeToolThreadBindingId,
      aliasId: nativeToolScopeId,
      aliasGeneration: 1,
      readyScopeId: nativeToolScopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e3',
      createdAt: new Date().toISOString(),
    })
    const nativeToolRun = reserveAndAdmit(
      'run-native-tool-mutation',
      false,
      nativeFailureSnapshot,
      nativeToolScopeId,
      nativeToolThreadBindingId,
      nativeToolThreadCwd,
      toolSurface,
    )
    const nativeToolThread = await client.threadStart({
      model: 'ready-e0-model', modelProvider: 'ready_gateway',
      allowProviderModelFallback: false, cwd: nativeToolThreadCwd,
      approvalPolicy: 'never', sandbox: 'read-only',
      runtimeWorkspaceRoots: [], environments: [], config: null,
      dynamicTools: [{
        type: 'function',
        name: responseTool.name,
        description: responseTool.description,
        inputSchema: toolParameters,
      }],
      developerInstructions,
    })
    const upstreamCountBeforeNativeToolMutation = upstreamBodies.length
    await collectFailedTurn(
      nativeToolRun,
      'TRIGGER_NATIVE_TOOL_MUTATION',
      nativeToolThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeNativeToolMutation + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/responses')
    assert.equal(toolExecutions, 0)

    const nativeToolSecretRun = reserveAndAdmit(
      'run-native-tool-secret',
      true,
      nativeFailureSnapshot,
      nativeToolScopeId,
      nativeToolThreadBindingId,
      nativeToolThreadCwd,
      toolSurface,
    )
    const upstreamCountBeforeNativeToolSecret = upstreamBodies.length
    await collectFailedTurn(
      nativeToolSecretRun,
      'TRIGGER_NATIVE_TOOL_SECRET',
      nativeToolThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeNativeToolSecret + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/responses')
    assert.equal(toolExecutions, 0)

    const nativeToolIncompleteRun = reserveAndAdmit(
      'run-native-tool-incomplete-item',
      true,
      nativeFailureSnapshot,
      nativeToolScopeId,
      nativeToolThreadBindingId,
      nativeToolThreadCwd,
      toolSurface,
    )
    const upstreamCountBeforeNativeToolIncomplete = upstreamBodies.length
    await collectFailedTurn(
      nativeToolIncompleteRun,
      'TRIGGER_NATIVE_TOOL_INCOMPLETE_ITEM',
      nativeToolThread.thread.id,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeNativeToolIncomplete + 1)
    assert.equal(upstreamPaths.at(-1), '/v1/responses')
    assert.equal(toolExecutions, 0)

    const liveLease = repository.readLiveProcessLease()
    assert.ok(liveLease?.pid)
    const childEnvironment = execFileSync('/bin/ps', [
      'eww', '-p', String(liveLease.pid), '-o', 'command=',
    ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    assert.equal(childEnvironment.includes('host-secret-e3-must-not-cross'), false)
    assert.equal(upstreamPaths.every((path) => (
      path === '/v1/chat/completions' || path === '/v1/responses'
    )), true)
    assert.ok(upstreamPaths.includes('/v1/responses'))
    assert.equal(upstreamAuthPresent.every(Boolean), true)
    assert.ok(upstreamBodies.some((body) => body.model === 'upstream-chat-model'))
    assert.ok(upstreamBodies.some((body) => body.model === 'upstream-native-model'))
    assert.equal(JSON.stringify(upstreamBodies).includes('ready-e0-model'), false)
    assert.equal(JSON.stringify(upstreamBodies).includes(gatewayAddress.bearerToken), false)
    assert.equal(JSON.stringify(upstreamBodies).includes('provider-secret-e3'), false)
    assert.equal(stderr.join('').includes(gatewayAddress.bearerToken), false)
    assert.deepEqual(db.prepare(`
      SELECT DISTINCT request_kind FROM ready_model_gateway_request_receipts ORDER BY request_kind
    `).all(), [
      { request_kind: 'automatic_compaction' },
      { request_kind: 'manual_compaction' },
      { request_kind: 'product' },
    ])

    const receiptCountBeforeRestart = db.prepare(`
      SELECT COUNT(*) AS count FROM ready_model_gateway_request_receipts
    `).get<{ count: number }>()?.count || 0
    const upstreamCountBeforeRestart = upstreamBodies.length
    assert.equal(spawnCapabilities.length, 1)
    const oldCapability = spawnCapabilities[0]
    await session.stop()
    await session.startAndInitialize({
      registry,
      snapshot: repository.readRecoverySnapshot(() => false),
    })
    client = session.getClient()
    await client.threadResume({ threadId: startedThread.thread.id })
    assert.equal(spawnCapabilities.length, 2)
    assert.notEqual(spawnCapabilities[1].spawnId, oldCapability.spawnId)
    assert.notEqual(spawnCapabilities[1].token, oldCapability.token)
    for (const requestKind of ['product', 'automatic_compaction', 'manual_compaction']) {
      const stale = await fetch(`${gatewayAddress.url}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${oldCapability.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ request_kind: requestKind }),
      })
      assert.equal(stale.status, 401)
    }
    const currentCapabilityAccepted = await fetch(`${gatewayAddress.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${spawnCapabilities[1].token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(currentCapabilityAccepted.status, 400)
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ready_model_gateway_request_receipts`)
        .get<{ count: number }>()?.count,
      receiptCountBeforeRestart,
    )
    assert.equal(upstreamBodies.length, upstreamCountBeforeRestart)

    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    if (session) await session.stop().catch(() => undefined)
    if (gateway) await gateway.stop().catch(() => undefined)
    await close(upstream)
    db.close()
    rmSync(tempRoot, { recursive: true, force: true })
    if (previousCanary === undefined) delete process.env.READY_E3_HOST_SECRET_CANARY
    else process.env.READY_E3_HOST_SECRET_CANARY = previousCanary
  }
})
