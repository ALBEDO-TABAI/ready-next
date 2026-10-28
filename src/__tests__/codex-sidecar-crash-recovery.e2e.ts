import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

import type { DatabaseConnection } from '../main/modules/database/connection'
import { DatabaseManager } from '../main/modules/database'
import {
  CodexAppServerClient,
  type CodexJsonLineTransport,
} from '../main/modules/agent-control/codex-runtime/codex-app-server-client'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  resolveCodexNativeModelSettings,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CodexModelGatewayRepository } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import { buildTerminalNativeReadbackReceipt, resolveCodexHistoryObservation, resolveCodexTerminalFacts, terminalEvidenceRef, terminalNativeReadbackEvidenceRef } from '../main/modules/agent-control/codex-runtime/codex-terminal-facts'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { CodexDefaultBootRecoveryActions } from '../main/modules/agent-control/codex-runtime/codex-boot-recovery-actions'
import { CodexDurableStartDispatchPort } from '../main/modules/agent-control/codex-runtime/codex-durable-start-dispatch'
import { buildCodexToolResponseDeliveryAttemptId } from '../main/modules/agent-control/codex-runtime/codex-tool-response-delivery'
import type {
  CodexNativeNotification,
  CodexTurn,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexProductRunPreparer, type PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { createCodexToolFixtureFromDefinitions } from './utils/codex-tool-fixture'
import { CodexProvisionalInboundBuffer } from '../main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer'
import {
  activateCodexGatewaySpawnConfig,
  buildCodexChildEnvironment,
  loadVerifiedCodexRuntime,
  prepareCodexRuntimeState,
  resolveCodexRuntimePaths,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-host'
import { CodexRuntimeBootReconciler } from '../main/modules/agent-control/codex-runtime/codex-runtime-boot-reconciler'
import {
  CodexDurableThreadArchiveDispatchPort,
  CodexThreadArchiveIntentStore,
} from '../main/modules/agent-control/codex-runtime/codex-thread-archive-cleanup'
import { CodexSidecarSession } from '../main/modules/agent-control/codex-runtime/codex-sidecar-session'
import {
  CodexSidecarSupervisor,
  MacCodexProcessInspector,
  NodeCodexSidecarSpawnPort,
  type CodexProcessInspector,
} from '../main/modules/agent-control/codex-runtime/codex-sidecar-supervisor'
import { createCodexStartIdentityRegistryForRuntime } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { loadRuntimeContinuityAssets } from '../main/modules/agent-control/codex-runtime/codex-runtime-continuity-assets'
import { providerCheckpointExecutionBinding } from './provider-checkpoint-test-fixtures'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type FaultMode = 'hold_response' | 'fail_write'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const upstream = createCodexUpstreamProfileSnapshot({
  profileId: 'profile-recovery', maxRetries: 0,
  config: {
    provider: 'openai', baseUrl: 'http://127.0.0.1:10532/v1', apiKey: 'isolated-test-key',
    model: 'ready-e0-model', agentProtocol: 'openai', wireApi: 'responses',
    contextWindowOverride: 272_000, toolUseMode: 'on', nativeVideoMode: 'off',
  },
})
const toolFixture = createCodexToolFixtureFromDefinitions([{
  name: 'ready_read_probe', groupId: 'agent_interaction', domain: 'document', kind: 'read',
  concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
  supportsTextBridge: true, projectionHint: null, description: 'Read one fixture value.',
  schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  executionVisibility: 'model', resultShape: 'json',
}])

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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function flattenText(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => flattenText(entry, output))
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => flattenText(entry, output))
  }
  return output
}

function sse(events: unknown[]): string {
  return events.map((event) => (
    `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join('')
}

function responseEvents(responseId: string, text: string): unknown[] {
  const messageId = `message-${responseId}`
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: messageId, phase: 'final_answer', content: [] },
    },
    {
      type: 'response.output_text.delta', output_index: 0, content_index: 0,
      item_id: messageId, delta: text,
    },
    {
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'message', role: 'assistant', id: messageId, phase: 'final_answer',
        content: [{ type: 'output_text', text }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 12, input_tokens_details: null, output_tokens: 4,
          output_tokens_details: null, total_tokens: 16,
        },
      },
    },
  ]
}

function toolEvents(responseId: string): unknown[] {
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'function_call', call_id: `call-${responseId}`,
        name: 'ready_read_probe', arguments: JSON.stringify({ query: 'early' }),
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        usage: {
          input_tokens: 12, input_tokens_details: null, output_tokens: 4,
          output_tokens_details: null, total_tokens: 16,
        },
      },
    },
  ]
}

function prepared(
  runId: string,
  text: string,
  scopeId: string,
  aliasId: string,
  reservation: StartIdentityReservationSet,
  actionAdmissionRef: PreparedCodexProductRun['ingress']['actionAdmissionRef'],
): PreparedCodexProductRun {
  const result = new CodexProductRunPreparer().prepare({
    readyMemorySnapshot: disabledReadyMemorySnapshot(),
    taskId: `task-${runId}`,
    runId,
    requestId: `request-${runId}`,
    scopeId, aliasId, aliasGeneration: 1,
    taskOrigin: 'user_root', runOrigin: 'initial',
    reservationSetId: reservation.reservationSetId,
    reservationEvidenceDigest: reservation.reservationEvidenceDigest,
    originUserMessageId: `message-${runId}`,
    currentInput: [{ type: 'text', text, text_elements: [] }],
    explicitResourceEnvelope: { input: [], resourceRefs: [] },
    resourceAdditionalContext: [],
    actionAdmissionRef,
    uncommittedTailAssignments: [],
    supersededUncommittedItems: [],
    trustedWorkbenchMode: 'browser',
    ...toolFixture,
    authorizationOwnerId: `owner-${runId}`,
    resourceOwnerId: `resource-owner-${runId}`,
    productBudgetSeed: {
      maxIterations: 8,
      maxToolCalls: 4,
      maxParallelToolGroups: 1,
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error(result.code)
  return result.prepared
}

function admission(
  run: PreparedCodexProductRun,
  reservation: StartIdentityReservationSet,
  threadBindingId: string,
  threadCwd: string,
  manifestDigest: string,
  ownerMainBootId: string,
): CodexAdmittedBindingInput {
  const executionBinding = providerCheckpointExecutionBinding(run.runId)
  const parentMeta = { requestId: run.ingressBinding.requestId }
  const messageContent = run.ingress.canonicalCurrentInputRef.input
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('')
  const input = {
    prepared: run,
    reservation,
    ownerMainBootId,
    admittedAt: new Date().toISOString(),
    ingressAdmittedRevision: 1,
    threadBindingId,
    isolatedThreadCwd: threadCwd,
    turnRequestId: `client-message-${run.runId}`,
    runtimeManifestDigest: manifestDigest,
    protocolSchemaDigest: 'protocol-schema-recovery',
    instructionContractDigest: 'instruction-recovery',
    codexModel: 'ready-e0-model',
    upstreamProfileSnapshotRef: 'profile-recovery',
    upstreamProfileSnapshotDigest: upstream.snapshotDigest,
    // A started thread is admitted only with the same-thread continuation candidate production resolves.
    continuationCandidate: reservation.existingThread
      ? {
          model: 'ready-e0-model',
          threadConfig: resolveCodexNativeModelSettings(upstream.snapshot).threadConfig,
          isolatedThreadCwd: threadCwd,
          cwdAvailable: true,
          instructionContractDigest: 'instruction-recovery',
          currentToolSurface: run.readyToolSurface,
        }
      : null,
    additionalContextDigest: `additional-context-${run.runId}`,
    turnContractDigest: `turn-contract-${run.runId}`,
    messageVisibilityEpoch: 0,
    readyParentReceipt: {
      messageRole: 'user' as const,
      messageContent,
      messageTimestamp: '2026-08-07T00:00:00.000Z',
      messageMetaDigest: digestCanonicalJson(parentMeta),
      executionBindingDigest: digestCanonicalJson(executionBinding),
    },
  }
  return { ...input, ingressAdmittedDigest: buildCodexIngressAdmittedDigest(input) }
}

function turnParams(run: PreparedCodexProductRun, threadId: string, text: string): CodexTurnStartParams {
  assert.deepEqual(run.ingress.canonicalCurrentInputRef.input, [{ type: 'text', text, text_elements: [] }])
  return {
    threadId,
    clientUserMessageId: `client-message-${run.runId}`,
    collaborationMode: {
      mode: 'default',
      settings: {
        model: 'ready-e0-model',
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
    environments: [],
    input: run.ingress.canonicalCurrentInputRef.input,
    additionalContext: {},
    responsesapiClientMetadata: {
      readyRunId: run.runId,
      toolSurfaceDigest: run.readyToolSurface.toolSurfaceDigest,
      turnContractDigest: `turn-contract-${run.runId}`,
      upstreamProfileSnapshotDigest: upstream.snapshotDigest,
    },
  }
}

function threadParams(cwd: string): CodexThreadStartParams {
  return {
    model: 'ready-e0-model', modelProvider: 'ready_gateway', allowProviderModelFallback: false,
    cwd, approvalPolicy: 'never', sandbox: 'read-only', runtimeWorkspaceRoots: [],
    environments: [],
    config: { model_context_window: 272_000 },
    dynamicTools: toolFixture.readyToolSurface.dynamicTools,
    developerInstructions: 'Use only the declared Ready tool.',
  }
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

function waitForTerminal(
  client: CodexAppServerClient,
  threadId: string,
  clientUserMessageId: string,
): Promise<CodexNativeNotification> {
  return new Promise((resolveTerminal, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`terminal_timeout:${threadId}:${clientUserMessageId}`))
    }, 20_000)
    const unsubscribe = client.subscribe((notification) => {
      if (
        notification.method !== 'turn/completed'
        || notification.params.threadId !== threadId
      ) return
      clearTimeout(timer)
      unsubscribe()
      resolveTerminal(notification)
    })
  })
}

class FaultingTransport implements CodexJsonLineTransport {
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<(error: Error | null) => void>()
  private readonly rpcFaults = new Map<number, { key: string; mode: FaultMode }>()
  private readonly held = new Map<string, string>()
  private readonly rawMethodCounts = new Map<string, number>()
  private readonly unsubscribeLine: () => void
  private readonly unsubscribeClose: () => void

  constructor(
    private readonly inner: CodexJsonLineTransport,
    private readonly rules: ReadonlyMap<string, FaultMode>,
  ) {
    this.unsubscribeLine = inner.onLine((line) => this.routeLine(line))
    this.unsubscribeClose = inner.onClose((error) => {
      for (const listener of this.closeListeners) listener(error)
    })
  }

  write(line: string, callback: (error: Error | null) => void): void {
    let frame: Record<string, unknown> | null = null
    try { frame = JSON.parse(line) as Record<string, unknown> } catch { /* real client validates */ }
    const method = typeof frame?.method === 'string' ? frame.method : null
    const id = Number.isSafeInteger(frame?.id) ? frame?.id as number : null
    if (id && (method === 'thread/start' || method === 'turn/start')) {
      const params = frame?.params as Record<string, unknown>
      const lookup = method === 'thread/start'
        ? String(params.cwd)
        : String((params.responsesapiClientMetadata as Record<string, unknown>).readyRunId)
      const key = `${method}:${lookup}`
      const mode = this.rules.get(key)
      if (mode) {
        this.rpcFaults.set(id, { key, mode })
        if (mode === 'fail_write') {
          callback(new Error(`fixture_child_write_failed:${key}`))
          return
        }
      }
    }
    this.inner.write(line, callback)
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(reason: string, details?: unknown): void {
    this.inner.close(reason, details)
  }

  rawCount(method: string): number {
    return this.rawMethodCounts.get(method) || 0
  }

  hasHeld(key: string): boolean {
    return this.held.has(key)
  }

  release(key: string): void {
    const line = this.held.get(key)
    if (!line) throw new Error(`held_response_missing:${key}`)
    this.held.delete(key)
    for (const listener of this.lineListeners) listener(line)
  }

  dispose(): void {
    this.unsubscribeLine()
    this.unsubscribeClose()
    this.lineListeners.clear()
    this.closeListeners.clear()
  }

  private routeLine(line: string): void {
    const frame = JSON.parse(line) as Record<string, unknown>
    if (typeof frame.method === 'string') {
      this.rawMethodCounts.set(frame.method, this.rawCount(frame.method) + 1)
    }
    if (Number.isSafeInteger(frame.id) && frame.method === undefined) {
      const fault = this.rpcFaults.get(frame.id as number)
      if (fault?.mode === 'hold_response') {
        this.held.set(fault.key, line)
        return
      }
    }
    for (const listener of this.lineListeners) listener(line)
  }
}

test('real app-server crash recovery covers all six start seams and three-way readback', async (t) => {
  if (process.env.READY_CODEX_E2E !== '1') {
    t.skip('set READY_CODEX_E2E=1 to run the pinned real child')
    return
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('pinned E2 runtime is macOS arm64 only')
    return
  }

  if (skipIfSqliteUnavailable(t, 'Codex sidecar crash recovery database')) return
  const database = new DatabaseManager(true)
  const db = database.getRawDb()
  assert.ok(db)
  const tempRoot = mkdtempSync(join(tmpdir(), 'ready-codex-e2-crash-'))
  const providerRequests: Array<Record<string, unknown>> = []
  let providerSequence = 0
  let toolExecutions = 0
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    providerRequests.push(body)
    providerSequence += 1
    const text = flattenText(body).join('\n')
    const events = text.includes('EARLY_TOOL_TOKEN') && !text.includes('READY_TOOL_RESULT')
      ? toolEvents(`response-${providerSequence}`)
      : responseEvents(`response-${providerSequence}`, `answer-${providerSequence}`)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    response.end(sse(events))
  })
  const port = await listen(server)
  const gatewayUrl = `http://127.0.0.1:${port}/v1`
  let activeSession: CodexSidecarSession | null = null
  let activeSupervisor: CodexSidecarSupervisor | null = null
  let activeFault: FaultingTransport | null = null

  try {
    new CodexModelGatewayRepository(db).storeSnapshot({
      ...upstream, snapshotRef: 'profile-recovery', createdAt: new Date().toISOString(),
    })
    const archiveDispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store: new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection),
      now: () => new Date().toISOString(),
    })
    const paths = resolveCodexRuntimePaths({
      appPath: repoRoot, resourcesPath: join(repoRoot, 'assets'), isPackaged: false,
    })
    const runtime = loadVerifiedCodexRuntime(paths)
    // Production binds the repository to the verified manifest and its checked-in continuity catalog.
    const repository = new CodexBindingRepository(db as unknown as DatabaseConnection, {
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-recovery',
      runtimeContinuityCatalog: loadRuntimeContinuityAssets({
        assetRoot: join(repoRoot, 'assets/runtime-continuity'),
        targetManifestDigest: runtime.manifestDigest,
      }).catalog,
    })
    const state = prepareCodexRuntimeState({
      userDataPath: tempRoot, gatewayUrl, contracts: runtime.contracts,
    })
    const inspector = new MacCodexProcessInspector()
    const main = (await inspector.list()).find((row) => row.pid === process.pid)
    assert.ok(main)
    let ownerMainBootId = randomUUID()
    let registry = createCodexStartIdentityRegistryForRuntime(runtime)
    const runText = new Map<string, string>()
    const threadStartByBinding = new Map<string, CodexThreadStartParams>()
    const runById = new Map<string, PreparedCodexProductRun>()

    const prepareScope = (scopeId: string) => {
      db.prepare(`
        INSERT OR IGNORE INTO chat_conversations (
          id, agent, active_agent_id, handoff_generation, title, source_kind, source_id,
          thread_key, meta_json, created_at, updated_at, message_visibility_epoch
        ) VALUES (?, 'butler', 'butler', 0, 'Codex E2', 'local', 'app', ?, '{}', ?, ?, 0)
      `).run(scopeId, scopeId, '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z')
      assert.deepEqual(
        db.prepare('SELECT id, message_visibility_epoch FROM chat_conversations WHERE id = ?')
          .get(scopeId),
        { id: scopeId, message_visibility_epoch: 0 },
      )
    }
    const prepareParentRows = (run: PreparedCodexProductRun) => {
      const scopeId = run.readyToolHostIdentity.scopeId
      const messageContent = run.ingress.canonicalCurrentInputRef.input
        .filter((item) => item.type === 'text').map((item) => item.text).join('')
      const parentMeta = { requestId: run.ingressBinding.requestId }
      db.prepare(`
        INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
        VALUES (?, ?, 'user', ?, '2026-08-07T00:00:00.000Z', ?, 0)
      `).run(
        run.ingress.originUserMessageId, scopeId, messageContent, JSON.stringify(parentMeta),
      )
      const executionBinding = providerCheckpointExecutionBinding(run.runId)
      new TaskProjectionRepository({ getRawDb: () => db }).create({
        taskId: run.taskId,
        scopeId,
        messageVisibilityEpoch: 0,
        runId: run.runId,
        taskType: 'direct_answer',
        module: 'system',
        status: 'running',
        interactionState: 'running',
        waitingFor: 'none',
        steps: [],
        ownerAgentId: 'butler',
        taskOrigin: 'user_root',
        executionBinding,
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:00:00.000Z',
      })
      new RunMetaRepository(db).create({
        runId: run.runId,
        taskId: run.taskId,
        scopeId,
        messageVisibilityEpoch: 0,
        agentId: 'butler',
        executionBinding,
        status: 'running',
      }, Date.parse('2026-08-07T00:00:00.000Z'))
    }

    const createAlias = (scopeId: string, aliasId: string, bindingId: string, cwd: string) => {
      mkdirSync(cwd, { recursive: true })
      repository.createEmptyAliasGeneration({
        threadBindingId: bindingId,
        aliasId,
        aliasGeneration: 1,
        readyScopeId: scopeId,
        runtimeManifestDigest: runtime.manifestDigest,
        protocolSchemaDigest: 'protocol-schema-recovery',
        createdAt: new Date().toISOString(),
      })
    }

    const reserveAndAdmit = (input: {
      runId: string
      scopeId: string
      aliasId: string
      threadBindingId: string
      threadCwd: string
      existingThread: boolean
      text: string
    }) => {
      const result = registry.reserve({ scopeId: input.scopeId, existingThread: input.existingThread })
      assert.equal(result.ok, true)
      if (!result.ok) throw new Error(result.code)
      prepareScope(input.scopeId)
      const head = projectCodexHeadActionProjection(repository.readHeadActionFacts({
        aliasId: input.aliasId,
        aliasGeneration: 1,
        currentRuntimeManifestDigest: runtime.manifestDigest,
        currentProtocolSchemaDigest: 'protocol-schema-recovery',
      }))
      const actionAdmissionRef = {
        headProjectionDigest: head.evidenceDigest,
        actionProjectionVersion: head.actionProjectionVersion,
        actionHeadIdentity: head.actionHeadIdentity!,
      }
      const run = prepared(input.runId, input.text, input.scopeId, input.aliasId, result.reservation, actionAdmissionRef)
      prepareParentRows(run)
      repository.admitProductBindings(admission(
        run,
        result.reservation,
        input.threadBindingId,
        input.threadCwd,
        runtime.manifestDigest,
        ownerMainBootId,
      ))
      runText.set(run.runId, input.text)
      runById.set(run.runId, run)
      return run
    }

    const closeRun = async (
      runId: string,
      turn: CodexTurn,
      status: 'completed' | 'failed' = 'completed',
      reader = activeSession!.getClient(),
    ) => {
      const run = runById.get(runId)
      if (!run) throw new Error(`run_not_found:${runId}`)
      const start = repository.readProductStartState(runId)
      assert.ok(start.codexThreadId)
      assert.equal(start.codexTurnId, turn.id)
      const closeoutAt = new Date().toISOString()
      const finalMessage = status === 'completed'
        ? turn.items.filter((item) => item.type === 'agentMessage').at(-1)
        : null
      assert.ok(status !== 'completed' || finalMessage?.type === 'agentMessage')
      const candidateText = finalMessage?.type === 'agentMessage' ? finalMessage.text : null
      const nativeThread = (await reader.threadRead({ threadId: start.codexThreadId, includeTurns: true })).thread
      repository.recordEngineTerminalCandidate({
        readyRunId: runId,
        codexThreadId: start.codexThreadId,
        codexTurnId: turn.id,
        engineOutcome: status === 'completed' ? 'completed' : 'failed',
        candidate: {
          kind: 'native_terminal',
          readyTaskId: run.taskId,
          readyRunId: runId,
          scopeId: run.readyToolHostIdentity.scopeId,
          codexThreadId: start.codexThreadId,
          codexTurnId: turn.id,
          engineOutcome: status === 'completed' ? 'completed' : 'failed',
          candidateSelection: status === 'completed'
            ? { kind: 'accepted', itemId: finalMessage!.id }
            : { kind: 'none', code: 'terminal_not_completed' },
          candidateText,
          candidateDigest: candidateText === null
            ? null
            : createHash('sha256').update(candidateText).digest('hex'),
          usedToolCalls: [],
          actionReceiptRefs: [],
          interactionState: null,
          waitingFor: null,
          terminalReasonCandidate: status === 'completed' ? 'done' : 'failed',
          abortInitiator: null,
          budgetState: {},
          contextState: {},
          providerDiagnostics: {},
          contextUsage: null,
          recoveryCheckpointRef: null,
          browserContinuationRef: null,
          browserProofRefs: [],
          otherProofRefs: [],
          projectionPatchRefs: [],
          runtimeDiagnostics: {
            finalDeltaItemIds: [], commentaryItemIds: [], nativeTurnError: turn.error?.message ?? null,
          },
        },
        recordedAt: closeoutAt,
      })
      repository.recordToolPublicationReceipt({ readyRunId: runId, recordedAt: closeoutAt })
      const engine = repository.readEngineTerminalCandidate(runId)!
      assert.equal(engine.candidate.kind, 'native_terminal')
      if (engine.candidate.kind !== 'native_terminal') throw new Error('native_candidate_missing')
      const identity = { readyRunId: runId, readyScopeId: run.readyToolHostIdentity.scopeId,
        messageVisibilityEpoch: 0, aliasGeneration: run.conversationAlias.aliasGeneration,
        codexThreadId: start.codexThreadId, codexTurnId: turn.id }
      const nativeReadback = buildTerminalNativeReadbackReceipt({ candidate: engine.candidate, prepared: run,
        aliasGeneration: identity.aliasGeneration, messageVisibilityEpoch: 0,
        connectionEpoch: repository.readLiveProcessLease()!.connectionEpoch, turnRevision: engine.revision, thread: nativeThread })
      const evidence = [terminalEvidenceRef({ ...identity, kind: 'native_turn', revision: 1,
        receiptId: `engine-terminal:${runId}`, digest: engine.candidateDigest,
        ownerIdentity: { nativeTurnId: turn.id, terminalStatus: engine.candidate.engineOutcome } }),
      terminalNativeReadbackEvidenceRef({ ...identity, revision: nativeReadback.turnRevision,
        receiptId: nativeReadback.receiptId, digest: nativeReadback.digest,
        ownerIdentity: { connectionEpoch: nativeReadback.connectionEpoch, readRevision: nativeReadback.turnRevision,
          verifiedThreadId: start.codexThreadId, verifiedTurnId: turn.id } })]
      const history = resolveCodexHistoryObservation({ candidate: engine.candidate, prepared: run,
        expectedClientUserMessageId: `client-message-${runId}`, thread: nativeThread, publicationDiverged: false,
        gatewayEvidence: new CodexModelGatewayRepository(db).readTurnGatewayEvidence(identity) })
      assert.equal(history.kind, 'continuation_safe', JSON.stringify(history))
      const terminalFacts = resolveCodexTerminalFacts({
        product: { terminal: status === 'completed' ? 'done' : 'error',
          terminalReason: status === 'completed' ? 'done' : 'blocked_external',
          failureKind: status === 'completed' ? null : 'provider', evidence },
        history, historyEvidence: evidence, effect: { state: 'none', evidence: [] },
      })
      const terminalMeta = { taskId: run.taskId, runId, terminalReason: terminalFacts.product.terminalReason }
      const messageId = `assistant:${run.taskId}:${runId}:terminal`
      const productTerminalDigest = status === 'completed' && candidateText !== null
        ? workflowDigest({
            id: messageId,
            conversationId: run.readyToolHostIdentity.scopeId,
            role: 'assistant',
            content: candidateText,
            timestamp: closeoutAt,
            meta: terminalMeta,
          })
        : `terminal-${runId}-${status}`
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`UPDATE task_projections SET status = ? WHERE task_id = ?`).run(status, run.taskId)
        db.prepare('UPDATE run_meta SET status = ?, terminal_reason = ? WHERE run_id = ?')
          .run(terminalFacts.product.terminal, terminalFacts.product.terminalReason, runId)
        if (status === 'completed' && candidateText !== null) {
          db.prepare(`
            INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
            VALUES (?, ?, 'assistant', ?, ?, ?, 0)
          `).run(
            messageId,
            run.readyToolHostIdentity.scopeId,
            candidateText,
            closeoutAt,
            JSON.stringify(terminalMeta),
          )
        }
        repository.completeCanonicalProductCloseoutInOpenTransaction({
          readyRunId: runId,
          productTerminalDigest,
          closeoutAt,
          terminalEvidence: { terminalFacts, nativeReadback },
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }

    const serverRequestExecutor = {
      async executeServerRequest(input: {
        bindingId: string
        connectionEpoch: string
        requestId: number | string
        params: { threadId: string; turnId: string; callId: string; tool: string; arguments: unknown }
      }) {
        const bridgeBinding = repository.readToolBridgeExecutionBinding(input.bindingId)
        const surfaceEntry = bridgeBinding.toolSurface.entries.find(
          (entry) => entry.name === input.params.tool,
        )
        assert.ok(surfaceEntry)
        toolExecutions += 1
        const result = {
          contentItems: [{ type: 'inputText', text: 'READY_TOOL_RESULT' }],
          success: true,
        }
        const identity = {
          codexThreadId: input.params.threadId,
          codexTurnId: input.params.turnId,
          codexCallId: input.params.callId,
          readyActionId: `crash-recovery-action-${input.params.callId}`,
          connectionEpoch: input.connectionEpoch,
          requestRpcId: String(input.requestId),
          toolResponseDigest: digestCanonicalJson(result),
        }
        return {
          result,
          deliveryAttempt: {
            attemptId: buildCodexToolResponseDeliveryAttemptId(identity),
            ...identity,
          },
        }
      },
      confirmServerResponseTransportWrite() {},
    }

    const makeSupervisor = (bootId: string, processInspector: CodexProcessInspector) => (
      new CodexSidecarSupervisor({
        runtime,
        state,
        spawnCapability: {
          activate: (identities) => {
            const gatewaySpawnConfig = activateCodexGatewaySpawnConfig({
              state,
              sidecarSpawnInstanceId: identities.sidecarSpawnInstanceId,
              gatewayUrl,
              gatewayToken: randomUUID(),
              contracts: runtime.contracts,
            })
            return buildCodexChildEnvironment({ state, ...identities, gatewaySpawnConfig })
          },
          revoke() {},
        },
        leaseStore: repository,
        inspector: processInspector,
        spawnPort: new NodeCodexSidecarSpawnPort(),
        ownerMainBootId: bootId,
        ownerMainPid: process.pid,
        ownerMainProcessStartIdentity: main.processStartIdentity,
      })
    )

    const makeSession = (supervisor: CodexSidecarSupervisor) => new CodexSidecarSession({
      runtime,
      state,
      repository,
      supervisor,
      threadArchiveDispatchPort: archiveDispatchPort,
      evidenceResolver: {
        async resolveTypedRejection() { return { resolution: 'unknown' } },
      },
      serverRequestExecutor,
      requestTimeoutMs: 10_000,
      inboundDeadlineMs: 20_000,
      inboundMaxFrames: 256,
      inboundMaxBytes: 2 * 1024 * 1024,
      now: () => new Date().toISOString(),
      nowMs: Date.now,
    })

    const startFaultClient = async (
      supervisor: CodexSidecarSupervisor,
      rules: ReadonlyMap<string, FaultMode>,
      requestTimeoutMs = 150,
    ) => {
      const started = await supervisor.start()
      const inboundBuffer = new CodexProvisionalInboundBuffer({
        maxFramesPerOwner: 256,
        maxBytesPerOwner: 2 * 1024 * 1024,
        nowMs: Date.now,
        serverRequestExecutor,
        startInboundQuarantinePort: {
          quarantine: (input) => repository.quarantineStartInbound({
            ...input, quarantinedAt: new Date().toISOString(),
          }),
        },
      })
      const dispatch = new CodexDurableStartDispatchPort({
        repository,
        registry,
        inboundBuffer,
        evidenceResolver: {
          async resolveTypedRejection() { return { resolution: 'unknown' } },
        },
        now: () => new Date().toISOString(),
        inboundDeadlineMs: 20_000,
        pinnedThreadSource: runtime.contracts.turnClientIdentityExtractionContract
          .thread_start.pinnedAppServerSource,
      })
      const transport = new FaultingTransport(started.transport, rules)
      const client = new CodexAppServerClient({
        transport,
        connectionEpoch: started.lease.connectionEpoch,
        requestTimeoutMs,
        startDispatchPort: dispatch,
        inboundFramePort: inboundBuffer,
        threadArchiveDispatchPort: archiveDispatchPort,
        threadArchiveAuthorizationPort: {
          assertEligible: (threadId) => repository.assertThreadArchiveEligible(threadId),
        },
      })
      await client.initialize()
      client.sealBootReconciliation()
      activeFault = transport
      return { client, transport, inboundBuffer, connectionEpoch: started.lease.connectionEpoch }
    }

    const baseScope = 'scope-recovery-base'
    const baseAlias = baseScope
    const baseBinding = 'thread-binding-recovery-base'
    const baseCwd = join(state.threadCwdRoot, baseBinding)
    createAlias(baseScope, baseAlias, baseBinding, baseCwd)
    const baseRun = reserveAndAdmit({
      runId: 'run-recovery-base', scopeId: baseScope, aliasId: baseAlias,
      threadBindingId: baseBinding, threadCwd: baseCwd, existingThread: false,
      text: 'BASE_TOKEN',
    })
    activeSupervisor = makeSupervisor(ownerMainBootId, inspector)
    activeSession = makeSession(activeSupervisor)
    await activeSession.startAndInitialize({
      registry,
      snapshot: repository.readRecoverySnapshot(() => false),
    })
    let client = activeSession.getClient()
    const baseThread = await client.threadStart(threadParams(baseCwd))
    const baseTerminal = waitForTerminal(
      client, baseThread.thread.id, `client-message-${baseRun.runId}`,
    )
    await client.turnStart(turnParams(baseRun, baseThread.thread.id, 'BASE_TOKEN'))
    const baseTerminalEvent = await baseTerminal
    await closeRun(baseRun.runId, baseTerminalEvent.params.turn)
    const createEstablishedPeer = async (suffix: string) => {
      const peerScope = `scope-recovery-${suffix}`
      const peerBinding = `thread-binding-recovery-${suffix}`
      const peerCwd = join(state.threadCwdRoot, peerBinding)
      createAlias(peerScope, peerScope, peerBinding, peerCwd)
      const peerRun = reserveAndAdmit({
        runId: `run-recovery-${suffix}`,
        scopeId: peerScope,
        aliasId: peerScope,
        threadBindingId: peerBinding,
        threadCwd: peerCwd,
        existingThread: false,
        text: `BASE_${suffix.toUpperCase()}_TOKEN`,
      })
      const peerThread = await client.threadStart(threadParams(peerCwd))
      const terminal = waitForTerminal(
        client, peerThread.thread.id, `client-message-${peerRun.runId}`,
      )
      await client.turnStart(turnParams(
        peerRun, peerThread.thread.id, `BASE_${suffix.toUpperCase()}_TOKEN`,
      ))
      const terminalEvent = await terminal
      await closeRun(peerRun.runId, terminalEvent.params.turn)
      return {
        scopeId: peerScope,
        aliasId: peerScope,
        threadBindingId: peerBinding,
        threadCwd: peerCwd,
        threadId: peerThread.thread.id,
      }
    }
    const absentPeer = await createEstablishedPeer('absent-peer')
    const heldPeer = await createEstablishedPeer('held-peer')
    client.sealBootReconciliation()
    await activeSession.stop()
    activeSession = null

    const earlyRun = reserveAndAdmit({
      runId: 'run-early-timeout', scopeId: baseScope, aliasId: baseAlias,
      threadBindingId: baseBinding, threadCwd: baseCwd, existingThread: true,
      text: 'EARLY_TOOL_TOKEN',
    })
    const earlyKey = `turn/start:${earlyRun.runId}`
    let manual = await startFaultClient(activeSupervisor, new Map([[earlyKey, 'hold_response']]), 1_000)
    client = manual.client
    await client.threadResume({ threadId: baseThread.thread.id })
    const earlyTerminal = waitForTerminal(
      client, baseThread.thread.id, `client-message-${earlyRun.runId}`,
    ).then(
      (notification) => ({ notification, error: null as Error | null }),
      (error: Error) => ({ notification: null, error }),
    )
    let earlySettled = false
    const earlyStart = client.turnStart(turnParams(
      earlyRun, baseThread.thread.id, 'EARLY_TOOL_TOKEN',
    )).then((value) => { earlySettled = true; return value })
    await waitUntil(() => manual.transport.hasHeld(earlyKey) ? true : null)
    await waitUntil(() => manual.transport.rawCount('item/tool/call') > 0 ? true : null)
    await new Promise((resolveWait) => setTimeout(resolveWait, 220))
    assert.equal(earlySettled, false)
    assert.equal(toolExecutions, 0)
    assert.deepEqual(db.prepare(`
      SELECT codex_turn_id, turn_start_reservation_released_at
        FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get(earlyRun.runId), {
      codex_turn_id: null,
      turn_start_reservation_released_at: null,
    })
    assert.equal(repository.readRecoverySnapshot(() => true).members.some((member) => (
      member.bindingId === earlyRun.runId && member.state === 'pending'
    )), true)
    manual.transport.release(earlyKey)
    const earlyStartResult = await Promise.race([
      earlyStart.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 2_000)),
    ])
    if (earlyStartResult !== 'resolved') {
      throw new Error(`early_start_failed:${JSON.stringify({
        toolExecutions,
        providerRequests: providerRequests.length,
        rawToolCalls: manual.transport.rawCount('item/tool/call'),
        rawTerminals: manual.transport.rawCount('turn/completed'),
        inbound: manual.inboundBuffer.snapshot(),
        recovery: repository.readRecoverySnapshot(() => true),
      })}`)
    }
    const earlyTerminalResult = await earlyTerminal
    if (earlyTerminalResult.error) {
      throw new Error(`early_terminal_failed:${JSON.stringify({
        cause: earlyTerminalResult.error.message,
        toolExecutions,
        providerRequests: providerRequests.length,
        rawToolCalls: manual.transport.rawCount('item/tool/call'),
        rawTerminals: manual.transport.rawCount('turn/completed'),
        inbound: manual.inboundBuffer.snapshot(),
        recovery: repository.readRecoverySnapshot(() => true),
      })}`)
    }
    assert.ok(earlyTerminalResult.notification)
    await closeRun(earlyRun.runId, earlyTerminalResult.notification.params.turn, 'completed', manual.client)
    assert.equal(toolExecutions, 1)
    assert.equal(registry.snapshot().capacityCharged, 0)

    const turnAccepted = reserveAndAdmit({
      runId: 'run-turn-accepted', scopeId: baseScope, aliasId: baseAlias,
      threadBindingId: baseBinding, threadCwd: baseCwd, existingThread: true,
      text: 'TURN_ACCEPTED_CRASH_TOKEN',
    })
    const turnAbsent = reserveAndAdmit({
      runId: 'run-turn-absent', scopeId: absentPeer.scopeId, aliasId: absentPeer.aliasId,
      threadBindingId: absentPeer.threadBindingId, threadCwd: absentPeer.threadCwd,
      existingThread: true,
      text: 'TURN_ABSENT_CRASH_TOKEN',
    })
    const turnHeld = reserveAndAdmit({
      runId: 'run-turn-held', scopeId: heldPeer.scopeId, aliasId: heldPeer.aliasId,
      threadBindingId: heldPeer.threadBindingId, threadCwd: heldPeer.threadCwd,
      existingThread: true,
      text: 'TURN_HELD_CRASH_TOKEN',
    })
    const acceptedKey = `turn/start:${turnAccepted.runId}`
    const absentKey = `turn/start:${turnAbsent.runId}`
    manual.transport.dispose()
    manual.client.dispose()
    await activeSupervisor.hardReset('test_cleanup')
    manual = await startFaultClient(activeSupervisor, new Map([
      [acceptedKey, 'hold_response'],
      [absentKey, 'fail_write'],
    ]))
    await manual.client.threadResume({ threadId: baseThread.thread.id })
    await manual.client.threadResume({ threadId: absentPeer.threadId })
    await manual.client.threadResume({ threadId: heldPeer.threadId })
    const acceptedCompletedBefore = manual.transport.rawCount('turn/completed')
    void manual.client.turnStart(turnParams(
      turnAccepted, baseThread.thread.id, 'TURN_ACCEPTED_CRASH_TOKEN',
    )).catch(() => undefined)
    await waitUntil(() => manual.transport.hasHeld(acceptedKey) ? true : null)
    await waitUntil(() => (
      manual.transport.rawCount('turn/completed') > acceptedCompletedBefore ? true : null
    ))
    void manual.client.turnStart(turnParams(
      turnAbsent, absentPeer.threadId, 'TURN_ABSENT_CRASH_TOKEN',
    )).catch(() => undefined)
    await waitUntil(() => db.prepare(`
      SELECT turn_start_dispatch_intent_at FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<{ turn_start_dispatch_intent_at: string | null }>(turnAbsent.runId)
      ?.turn_start_dispatch_intent_at || null)
    const turnCrashSnapshot = repository.readRecoverySnapshot(() => false)
    assert.deepEqual(turnCrashSnapshot.members.map((member) => member.crashSeam).sort(), [4, 5, 6])

    let lastBootThreadLists: unknown[] = []
    const bootAfterCrash = async (provenAbsentBindings: ReadonlySet<string>) => {
      lastBootThreadLists = []
      manual.client.dispose()
      manual.transport.dispose()
      activeFault = null
      ownerMainBootId = randomUUID()
      const hidesOldMain: CodexProcessInspector = {
        async list() {
          return (await inspector.list()).filter((row) => row.pid !== process.pid)
        },
      }
      activeSupervisor = makeSupervisor(ownerMainBootId, hidesOldMain)
      activeSession = makeSession(activeSupervisor)
      const freshBootThreadIds = new Set<string>()
      const actions = new CodexDefaultBootRecoveryActions({
        runtime: {
          threadList: async (params) => {
            const listed = await activeSession!.getClient().threadList(params)
            lastBootThreadLists.push({ params, listed })
            return listed
          },
          threadRead: (params) => activeSession!.getClient().threadRead(params),
        },
        repository,
        pinnedThreadSource: runtime.contracts.turnClientIdentityExtractionContract
          .thread_start.pinnedAppServerSource,
        threadListLimit: 100,
        stableZeroReadCount: 2,
        waitBetweenZeroReads: async () => undefined,
        heldStartDispatcher: {
          async dispatch({ member }) {
            if (member.method === 'thread/start') {
              const params = threadStartByBinding.get(member.bindingId)
              if (!params) throw new Error(`held_thread_params_missing:${member.bindingId}`)
              const started = await activeSession!.getClient().threadStart(params)
              freshBootThreadIds.add(started.thread.id)
              return 'accepted'
            }
            const identity = repository.readStartInboundIdentity('turn/start', member.bindingId)
            if (identity.method !== 'turn/start') throw new Error('held_turn_identity_invalid')
            const run = runById.get(member.bindingId)
            if (!run) throw new Error(`held_run_missing:${member.bindingId}`)
            if (!freshBootThreadIds.has(identity.threadId)) {
              await activeSession!.getClient().threadResume({ threadId: identity.threadId })
            }
            const terminal = waitForTerminal(
              activeSession!.getClient(), identity.threadId, identity.clientUserMessageId,
            )
            await activeSession!.getClient().turnStart(turnParams(
              run, identity.threadId, runText.get(run.runId) as string,
            ))
            const terminalEvent = await terminal
            await closeRun(run.runId, terminalEvent.params.turn)
            return 'accepted'
          },
        },
        absenceProof: {
          async prove({ member }) {
            const lease = db.prepare(`
              SELECT owner_main_dead_at, tree_zero_at,
                     tree_zero_evidence_digest
                FROM codex_sidecar_process_leases
               WHERE connection_epoch = ?
            `).get<{
              owner_main_dead_at: string | null
              tree_zero_at: string | null
              tree_zero_evidence_digest: string | null
            }>(member.connectionEpoch)
            assert.ok(lease?.owner_main_dead_at)
            assert.ok(lease?.tree_zero_at)
            assert.ok(lease?.tree_zero_evidence_digest)
            return provenAbsentBindings.has(member.bindingId)
              ? { proven: true as const, evidenceDigest: `proven-absent-${member.bindingId}` }
              : { proven: false as const }
          },
        },
        hostFailureTerminal: {
          async commit(failure) {
            const run = runById.get(failure.readyRunId)
            if (!run) throw new Error(`failure_run_missing:${failure.readyRunId}`)
            db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`)
              .run(run.taskId)
            return {
              productTerminalDigest: `terminal-${failure.readyRunId}-failed`,
              closeoutAt: new Date().toISOString(),
            }
          },
          async deliver() {},
        },
        manualCompaction: {
          async reconcile() { throw new Error('unexpected_manual_recovery') },
        },
        productFence: {
          async reconcile(fence) {
            const stillOwned = db.prepare(`
              SELECT 1 AS present FROM codex_thread_dispatch_fences
               WHERE thread_binding_id = ? AND owner_ready_run_id = ?
            `).get(fence.threadBindingId, fence.readyRunId)
            if (!stillOwned) return
            const identity = repository.readStartInboundIdentity('turn/start', fence.readyRunId)
            if (identity.method !== 'turn/start') throw new Error('fence_turn_identity_invalid')
            const read = await activeSession!.getClient().threadRead({
              threadId: identity.threadId, includeTurns: true,
            })
            const matching = read.thread.turns.filter((turn) => turn.items.some((item) => (
              item.type === 'userMessage' && item.clientId === identity.clientUserMessageId
            )))
            assert.equal(matching.length, 1)
            assert.notEqual(matching[0].status, 'inProgress')
            await closeRun(fence.readyRunId, matching[0])
          },
        },
      })
      const gates: string[] = []
      const result = await new CodexRuntimeBootReconciler({
        runtime,
        repository,
        supervisor: activeSupervisor,
        sidecarSession: activeSession,
        actions,
        ingressGate: {
          close: (reason) => gates.push(`closed:${reason}`),
          open: () => gates.push('open'),
        },
        now: () => new Date().toISOString(),
      }).boot()
      registry = result.registry
      assert.deepEqual(gates, ['closed:boot_reconciliation_pending', 'open'])
      return result
    }

    let bootResult = await bootAfterCrash(new Set([turnAbsent.runId]))
    assert.deepEqual(bootResult.unresolvedStartBindings, [], JSON.stringify({
      lastBootThreadLists,
      fences: repository.readRecoverySnapshot(() => false).productFences,
    }))
    assert.equal(registry.snapshot().capacityCharged, 0)
    assert.deepEqual(db.prepare(`
      SELECT run_id, status FROM task_projections
       WHERE run_id IN (?, ?, ?) ORDER BY run_id
    `).all(turnAccepted.runId, turnAbsent.runId, turnHeld.runId), [
      { run_id: turnAbsent.runId, status: 'failed' },
      { run_id: turnAccepted.runId, status: 'completed' },
      { run_id: turnHeld.runId, status: 'completed' },
    ])
    for (const [run, threadId] of [
      [turnAccepted, baseThread.thread.id],
      [turnHeld, heldPeer.threadId],
    ] as const) {
      const recoveredTurnRead = await activeSession.getClient().threadRead({
        threadId, includeTurns: true,
      })
      assert.equal(recoveredTurnRead.thread.turns.filter((turn) => turn.items.some((item) => (
        item.type === 'userMessage' && item.clientId === `client-message-${run.runId}`
      ))).length, 1)
    }

    await activeSession.stop()
    activeSession = null
    const liveThreadScope = 'scope-thread-live-timeout'
    const liveThreadBinding = 'thread-binding-thread-live-timeout'
    const liveThreadCwd = join(state.threadCwdRoot, liveThreadBinding)
    createAlias(liveThreadScope, liveThreadScope, liveThreadBinding, liveThreadCwd)
    const liveThreadRun = reserveAndAdmit({
      runId: 'run-thread-live-timeout',
      scopeId: liveThreadScope,
      aliasId: liveThreadScope,
      threadBindingId: liveThreadBinding,
      threadCwd: liveThreadCwd,
      existingThread: false,
      text: 'THREAD_LIVE_TIMEOUT_TOKEN',
    })
    const liveThreadKey = `thread/start:${liveThreadCwd}`
    manual = await startFaultClient(activeSupervisor, new Map([
      [liveThreadKey, 'hold_response'],
    ]), 1_000)
    const liveThreadStartedBefore = manual.transport.rawCount('thread/started')
    let liveThreadSettled = false
    const liveThreadStart = manual.client.threadStart(threadParams(liveThreadCwd))
      .then((value) => { liveThreadSettled = true; return value })
    await waitUntil(() => manual.transport.hasHeld(liveThreadKey) ? true : null)
    await waitUntil(() => (
      manual.transport.rawCount('thread/started') > liveThreadStartedBefore ? true : null
    ))
    await new Promise((resolveWait) => setTimeout(resolveWait, 220))
    assert.equal(liveThreadSettled, false)
    assert.deepEqual(db.prepare(`
      SELECT codex_thread_id, thread_start_reservation_released_at
        FROM codex_thread_bindings WHERE thread_binding_id = ?
    `).get(liveThreadBinding), {
      codex_thread_id: null,
      thread_start_reservation_released_at: null,
    })
    manual.transport.release(liveThreadKey)
    const liveThread = await liveThreadStart
    const liveThreadTerminal = waitForTerminal(
      manual.client,
      liveThread.thread.id,
      `client-message-${liveThreadRun.runId}`,
    )
    await manual.client.turnStart(turnParams(
      liveThreadRun,
      liveThread.thread.id,
      'THREAD_LIVE_TIMEOUT_TOKEN',
    ))
    const liveThreadTerminalEvent = await liveThreadTerminal
    await closeRun(liveThreadRun.runId, liveThreadTerminalEvent.params.turn, 'completed', manual.client)
    assert.equal(registry.snapshot().capacityCharged, 0)
    manual.client.dispose()
    manual.transport.dispose()
    await activeSupervisor.hardReset('test_cleanup')

    const acceptedScope = 'scope-thread-accepted'
    const acceptedBinding = 'thread-binding-thread-accepted'
    const acceptedCwd = join(state.threadCwdRoot, acceptedBinding)
    createAlias(acceptedScope, acceptedScope, acceptedBinding, acceptedCwd)
    const threadAcceptedRun = reserveAndAdmit({
      runId: 'run-thread-accepted', scopeId: acceptedScope, aliasId: acceptedScope,
      threadBindingId: acceptedBinding, threadCwd: acceptedCwd, existingThread: false,
      text: 'THREAD_ACCEPTED_TURN_TOKEN',
    })
    threadStartByBinding.set(acceptedBinding, threadParams(acceptedCwd))
    const absentScope = 'scope-thread-absent'
    const absentBinding = 'thread-binding-thread-absent'
    const absentCwd = join(state.threadCwdRoot, absentBinding)
    createAlias(absentScope, absentScope, absentBinding, absentCwd)
    const threadAbsentRun = reserveAndAdmit({
      runId: 'run-thread-absent', scopeId: absentScope, aliasId: absentScope,
      threadBindingId: absentBinding, threadCwd: absentCwd, existingThread: false,
      text: 'THREAD_ABSENT_TURN_TOKEN',
    })
    threadStartByBinding.set(absentBinding, threadParams(absentCwd))
    const threadAcceptedKey = `thread/start:${acceptedCwd}`
    const threadAbsentKey = `thread/start:${absentCwd}`
    manual = await startFaultClient(activeSupervisor, new Map([
      [threadAcceptedKey, 'hold_response'],
      [threadAbsentKey, 'fail_write'],
    ]), 10_000)
    const rawThreadStarted = manual.transport.rawCount('thread/started')
    void manual.client.threadStart(threadParams(acceptedCwd)).catch(() => undefined)
    await waitUntil(() => manual.transport.hasHeld(threadAcceptedKey) ? true : null)
    await waitUntil(() => (
      manual.transport.rawCount('thread/started') > rawThreadStarted ? true : null
    ))
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
    void manual.client.threadStart(threadParams(absentCwd)).catch(() => undefined)
    await waitUntil(() => db.prepare(`
      SELECT thread_start_dispatch_intent_at FROM codex_thread_bindings
       WHERE thread_binding_id = ?
    `).get<{ thread_start_dispatch_intent_at: string | null }>(absentBinding)
      ?.thread_start_dispatch_intent_at || null)
    assert.deepEqual(
      repository.readRecoverySnapshot(() => false).members.map((member) => member.crashSeam).sort(),
      [2, 3, 4, 4],
    )
    bootResult = await bootAfterCrash(new Set([acceptedBinding, absentBinding]))
    assert.deepEqual(bootResult.unresolvedStartBindings, [], JSON.stringify({
      lastBootThreadLists,
      fences: repository.readRecoverySnapshot(() => false).productFences,
    }))
    assert.equal(registry.snapshot().capacityCharged, 0)
    assert.deepEqual(db.prepare(`
      SELECT run_id, status FROM task_projections WHERE run_id IN (?, ?) ORDER BY run_id
    `).all(threadAcceptedRun.runId, threadAbsentRun.runId), [
      { run_id: threadAbsentRun.runId, status: 'failed' },
      { run_id: threadAcceptedRun.runId, status: 'failed' },
    ])

    await activeSession.stop()
    activeSession = null
    const heldScope = 'scope-thread-held'
    const heldBinding = 'thread-binding-thread-held'
    const heldCwd = join(state.threadCwdRoot, heldBinding)
    createAlias(heldScope, heldScope, heldBinding, heldCwd)
    const threadHeldRun = reserveAndAdmit({
      runId: 'run-thread-held', scopeId: heldScope, aliasId: heldScope,
      threadBindingId: heldBinding, threadCwd: heldCwd, existingThread: false,
      text: 'THREAD_HELD_TURN_TOKEN',
    })
    threadStartByBinding.set(heldBinding, threadParams(heldCwd))
    const unknownScope = 'scope-thread-unknown'
    const unknownBinding = 'thread-binding-thread-unknown'
    const unknownCwd = join(state.threadCwdRoot, unknownBinding)
    createAlias(unknownScope, unknownScope, unknownBinding, unknownCwd)
    const threadUnknownRun = reserveAndAdmit({
      runId: 'run-thread-unknown', scopeId: unknownScope, aliasId: unknownScope,
      threadBindingId: unknownBinding, threadCwd: unknownCwd, existingThread: false,
      text: 'THREAD_UNKNOWN_MUST_NOT_RUN',
    })
    threadStartByBinding.set(unknownBinding, threadParams(unknownCwd))
    const unknownKey = `thread/start:${unknownCwd}`
    manual = await startFaultClient(activeSupervisor, new Map([[unknownKey, 'fail_write']]))
    void manual.client.threadStart(threadParams(unknownCwd)).catch(() => undefined)
    await waitUntil(() => db.prepare(`
      SELECT thread_start_dispatch_intent_at FROM codex_thread_bindings
       WHERE thread_binding_id = ?
    `).get<{ thread_start_dispatch_intent_at: string | null }>(unknownBinding)
      ?.thread_start_dispatch_intent_at || null)
    assert.deepEqual(
      repository.readRecoverySnapshot(() => false).members.map((member) => member.crashSeam).sort(),
      [1, 2, 4, 4],
    )
    bootResult = await bootAfterCrash(new Set())
    assert.deepEqual(bootResult.unresolvedStartBindings, [unknownBinding])
    assert.equal(registry.snapshot().capacityCharged, 2)
    const unknownFence = repository.readRecoverySnapshot(() => false).productFences.find((fence) => (
      fence.readyRunId === threadUnknownRun.runId
    ))
    assert.ok(unknownFence?.quarantinedAt)
    assert.match(unknownFence?.quarantineReason || '', /start_resolution_unknown/)
    assert.deepEqual(db.prepare(`
      SELECT codex_thread_id, thread_start_reservation_released_at
        FROM codex_thread_bindings WHERE thread_binding_id = ?
    `).get(unknownBinding), {
      codex_thread_id: null,
      thread_start_reservation_released_at: null,
    })
    const heldNative = db.prepare(`
      SELECT codex_thread_id FROM codex_thread_bindings WHERE thread_binding_id = ?
    `).get<{ codex_thread_id: string }>(heldBinding)
    assert.ok(heldNative?.codex_thread_id)
    assert.deepEqual(db.prepare(`
      SELECT status FROM task_projections WHERE run_id = ?
    `).get(threadHeldRun.runId), { status: 'completed' })

    const postUnknown = reserveAndAdmit({
      runId: 'run-post-unknown', scopeId: baseScope, aliasId: baseAlias,
      threadBindingId: baseBinding, threadCwd: baseCwd, existingThread: true,
      text: 'POST_UNKNOWN_OTHER_ROOT_TOKEN',
    })
    const postTerminal = waitForTerminal(
      activeSession.getClient(), baseThread.thread.id, `client-message-${postUnknown.runId}`,
    )
    await activeSession.getClient().threadResume({ threadId: baseThread.thread.id })
    await activeSession.getClient().turnStart(turnParams(
      postUnknown, baseThread.thread.id, 'POST_UNKNOWN_OTHER_ROOT_TOKEN',
    ))
    const postTerminalEvent = await postTerminal
    await closeRun(postUnknown.runId, postTerminalEvent.params.turn)
    assert.equal(registry.snapshot().capacityCharged, 2)
    assert.equal(
      providerRequests.some((body) => flattenText(body).join('\n').includes('THREAD_UNKNOWN_MUST_NOT_RUN')),
      false,
    )
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    activeFault?.dispose()
    if (activeSession) await activeSession.stop().catch(() => undefined)
    else if (activeSupervisor) await activeSupervisor.hardReset('test_cleanup').catch(() => undefined)
    await closeServer(server)
    database.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
