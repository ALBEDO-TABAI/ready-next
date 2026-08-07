import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { CodexDefaultBootRecoveryActions } from '../main/modules/agent-control/codex-runtime/codex-boot-recovery-actions'
import type { CodexNativeNotification, CodexTurnStartParams } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import {
  buildCodexChildEnvironment,
  loadVerifiedCodexRuntime,
  prepareCodexRuntimeState,
  resolveCodexRuntimePaths,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-host'
import { CodexSidecarSession } from '../main/modules/agent-control/codex-runtime/codex-sidecar-session'
import { CodexRuntimeBootReconciler } from '../main/modules/agent-control/codex-runtime/codex-runtime-boot-reconciler'
import { CodexTurnCollector } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import {
  CodexSidecarSupervisor,
  MacCodexProcessInspector,
  NodeCodexSidecarSpawnPort,
} from '../main/modules/agent-control/codex-runtime/codex-sidecar-supervisor'
import { createCodexStartIdentityRegistryForRuntime } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'

type NativeDb = import('better-sqlite3').Database

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scopeId = 'scope-e2e'
const threadBindingId = 'thread-binding-e2e'

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

function sse(events: unknown[]): string {
  return events.map((event) => (
    `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join('')
}

function completed(responseId: string, inputTokens = 12) {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: null,
        output_tokens: 4,
        output_tokens_details: null,
        total_tokens: inputTokens + 4,
      },
    },
  }
}

function messageEvents(responseId: string, text: string, inputTokens = 12): unknown[] {
  const messageId = `message-${responseId}`
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: messageId, phase: 'final_answer', content: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      item_id: messageId,
      delta: text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        id: messageId,
        phase: 'final_answer',
        content: [{ type: 'output_text', text }],
      },
    },
    completed(responseId, inputTokens),
  ]
}

function functionCallEvents(responseId: string): unknown[] {
  return [
    { type: 'response.created', response: { id: responseId } },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call-ready-probe',
        name: 'ready_read_probe',
        arguments: JSON.stringify({ query: 'contract' }),
      },
    },
    completed(responseId),
  ]
}

function flattenText(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => flattenText(entry, output))
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => flattenText(entry, output))
  }
  return output
}

function latestUserText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.input)) return ''
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index]
    if (item && typeof item === 'object' && (item as { role?: unknown }).role === 'user') {
      return flattenText(item).join('\n')
    }
  }
  return ''
}

function providerToolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return []
  return body.tools.flatMap((tool) => (
    tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
      ? [(tool as { name: string }).name]
      : []
  ))
}

function prepared(
  runId: string,
  messageId: string,
  reservation: StartIdentityReservationSet,
  targetScopeId = scopeId,
  targetAliasId = targetScopeId,
): PreparedCodexProductRun {
  return {
    preparationContract: 'codex_product_run_e1',
    taskId: `task-${runId}`,
    runId,
    conversationAlias: { aliasId: targetAliasId, aliasGeneration: 1 },
    ingressBinding: {
      requestId: `request-${runId}`,
      reservationSetId: reservation.reservationSetId,
      reservationEvidenceDigest: reservation.reservationEvidenceDigest,
    },
    ingress: {
      kind: 'user_ingress',
      attemptKind: 'user_ingress',
      originUserMessageId: messageId,
      canonicalCurrentInputRef: {
        messageId,
        input: [{ type: 'text', text: `input-${runId}`, text_elements: [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    },
    resourceAnchorDigest: `resource-${runId}`,
    recoveredContextDigest: null,
    readyToolSurface: {
      surfaceId: 'surface-e2e',
      toolSurfaceDigest: 'tool-surface-e2e',
      toolNames: ['ready_read_probe'],
    },
    readyTurnToolAuthorization: {
      authorizationId: `authorization-${runId}`,
      authorizationDigest: `authorization-digest-${runId}`,
    },
    readyToolHostIdentity: {
      scopeId: targetScopeId,
      aliasId: targetAliasId,
      authorizationOwnerId: `owner-${runId}`,
      resourceOwnerId: `resource-owner-${runId}`,
    },
    productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
    neutralProjectionSeed: {
      phase: 'planning', taskTitle: '正在理解需求', taskSummary: '正在整理任务边界',
    },
  }
}

function prepareParentRows(db: NativeDb, run: PreparedCodexProductRun): void {
  const targetScopeId = run.readyToolHostIdentity.scopeId
  db.prepare(`INSERT OR IGNORE INTO chat_conversations (id) VALUES (?)`).run(targetScopeId)
  db.prepare(`INSERT INTO chat_messages (id, conversation_id) VALUES (?, ?)`).run(
    run.ingress.originUserMessageId,
    targetScopeId,
  )
  db.prepare(`
    INSERT INTO task_projections (task_id, run_id, scope_id, status)
    VALUES (?, ?, ?, 'running')
  `).run(run.taskId, run.runId, targetScopeId)
}

function admission(
  run: PreparedCodexProductRun,
  reservation: StartIdentityReservationSet,
  threadCwd: string,
  runtimeManifestDigest: string,
  targetThreadBindingId = threadBindingId,
): CodexAdmittedBindingInput {
  return {
    prepared: run,
    reservation,
    ownerMainBootId: 'main-boot-e2e',
    admittedAt: new Date().toISOString(),
    ingressAdmittedRevision: 1,
    ingressAdmittedDigest: `ingress-${run.runId}`,
    threadBindingId: targetThreadBindingId,
    isolatedThreadCwd: threadCwd,
    turnRequestId: `client-message-${run.runId}`,
    runtimeManifestDigest,
    protocolSchemaDigest: 'protocol-schema-e2e',
    instructionContractDigest: 'instruction-e2e',
    codexModel: 'ready-e0-model',
    upstreamProfileSnapshotRef: 'profile-e2e',
    upstreamProfileSnapshotDigest: 'profile-digest-e2e',
    additionalContextDigest: `additional-context-${run.runId}`,
    turnContractDigest: `turn-contract-${run.runId}`,
  }
}

async function waitForNotification(
  client: { subscribe(listener: (notification: CodexNativeNotification) => void): () => void },
  predicate: (notification: CodexNativeNotification) => boolean,
  timeoutMs = 20_000,
): Promise<CodexNativeNotification> {
  return new Promise((resolveNotification, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('notification_timeout'))
    }, timeoutMs)
    const unsubscribe = client.subscribe((notification) => {
      if (!predicate(notification)) return
      clearTimeout(timer)
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

async function waitUntilAsync<T>(read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error('async_condition_timeout')
}

test('real app-server uses durable bindings, exact tools, compaction, and process restart', async (t) => {
  if (process.env.READY_CODEX_E2E !== '1') {
    t.skip('set READY_CODEX_E2E=1 to run the pinned real child')
    return
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('pinned E2 runtime is macOS arm64 only')
    return
  }
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  const tempRoot = mkdtempSync(join(tmpdir(), 'ready-codex-e2-'))
  const gatewayToken = 'e2-short-lived-token'
  const priorCanary = process.env.READY_E2_HOST_SECRET_CANARY
  process.env.READY_E2_HOST_SECRET_CANARY = 'host-secret-must-not-cross'
  const providerRequests: Array<Record<string, unknown>> = []
  let providerSequence = 0
  let activeProviderResponses = 0
  let maxActiveProviderResponses = 0
  let delayAllProviderResponses = false
  let autoCompactArmConsumed = false
  let interruptFixtureConsumed = false
  let markInterruptToolEntered: (() => void) | null = null
  const interruptToolEntered = new Promise<void>((resolveEntered) => {
    markInterruptToolEntered = resolveEntered
  })
  let releaseInterruptTool: (() => void) | null = null
  let toolExecutions = 0
  let preBindingToolExecutions = 0
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    providerRequests.push(body)
    providerSequence += 1
    activeProviderResponses += 1
    maxActiveProviderResponses = Math.max(maxActiveProviderResponses, activeProviderResponses)
    response.once('close', () => { activeProviderResponses -= 1 })
    const text = flattenText(body).join('\n')
    const userText = latestUserText(body)
    if (delayAllProviderResponses || userText.includes('CONCURRENT_ROOT_TOKEN')) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    }
    if (userText.includes('INTERRUPT_TOKEN') && !interruptFixtureConsumed) {
      interruptFixtureConsumed = true
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      })
      response.end(sse(functionCallEvents(`resp-${providerSequence}`)))
      return
    }
    const shouldArmAutomaticCompaction = (
      userText.includes('AUTO_COMPACT_ARM_TOKEN') && !autoCompactArmConsumed
    )
    if (shouldArmAutomaticCompaction) autoCompactArmConsumed = true
    const events = userText.includes('CALL_TOOL_TOKEN') && !text.includes('READY_TOOL_RESULT')
      ? functionCallEvents(`resp-${providerSequence}`)
      : messageEvents(
          `resp-${providerSequence}`,
          `answer-${providerSequence}`,
          shouldArmAutomaticCompaction ? 1_000_000 : 12,
        )
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    response.end(sse(events))
  })
  const port = await listen(server)
  const gatewayUrl = `http://127.0.0.1:${port}/v1`
  const stderr: string[] = []
  let session: CodexSidecarSession | null = null
  try {
    db.exec(`
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY);
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_id TEXT NOT NULL, status TEXT NOT NULL
      );
    `)
    __runMigrationForTests('088_codex_runtime_bindings', db as unknown as MigrationDatabase)
    __runMigrationForTests('089_codex_runtime_evidence_guards', db as unknown as MigrationDatabase)
    const repository = new CodexBindingRepository(db as unknown as DatabaseConnection)
    const paths = resolveCodexRuntimePaths({
      appPath: repoRoot,
      resourcesPath: join(repoRoot, 'assets'),
      isPackaged: false,
    })
    const runtime = loadVerifiedCodexRuntime(paths)
    const state = prepareCodexRuntimeState({
      userDataPath: tempRoot,
      gatewayUrl,
      gatewayToken,
      contracts: runtime.contracts,
    })
    const threadCwd = join(state.threadCwdRoot, threadBindingId)
    mkdirSync(threadCwd, { recursive: true })
    const inspector = new MacCodexProcessInspector()
    const mainProcess = (await inspector.list()).find((processRow) => processRow.pid === process.pid)
    assert.ok(mainProcess)
    const ownerMainBootId = randomUUID()
    const supervisor = new CodexSidecarSupervisor({
      runtime,
      state,
      childEnvironment: (identities) => buildCodexChildEnvironment({
        state,
        ...identities,
        gatewayUrl,
        gatewayToken,
      }),
      leaseStore: repository,
      inspector,
      spawnPort: new NodeCodexSidecarSpawnPort(),
      ownerMainBootId,
      ownerMainPid: process.pid,
      ownerMainProcessStartIdentity: mainProcess.processStartIdentity,
      onStderr: (text) => stderr.push(text),
    })
    let registry = createCodexStartIdentityRegistryForRuntime(runtime)
    const toolResults = new Map<string, unknown>()
    session = new CodexSidecarSession({
      runtime,
      state,
      gatewayToken,
      repository,
      supervisor,
      evidenceResolver: {
        async resolveTypedRejection() { return { resolution: 'unknown' } },
      },
      serverRequestExecutor: {
        async execute(input) {
          const boundTurn = db.prepare(`
            SELECT codex_turn_id FROM codex_turn_bindings WHERE ready_run_id = ?
          `).get<{ codex_turn_id: string | null }>(input.bindingId)
          if (boundTurn?.codex_turn_id !== input.params.turnId) preBindingToolExecutions += 1
          const key = `${input.bindingId}\0${input.params.callId}`
          const prior = toolResults.get(key)
          if (prior) return prior
          const bound = repository.bindToolCall({
            codexThreadId: input.params.threadId,
            codexTurnId: input.params.turnId,
            codexCallId: input.params.callId,
            readyRunId: input.bindingId,
            readyActionId: `action-${input.bindingId}-${input.params.callId}`,
            toolName: input.params.tool,
            argsDigest: JSON.stringify(input.params.arguments),
            turnContractDigest: `turn-contract-${input.bindingId}`,
            at: new Date().toISOString(),
          })
          if (!bound.duplicate) toolExecutions += 1
          if (input.bindingId === 'run-interrupt') {
            markInterruptToolEntered?.()
            await new Promise<void>((resolveRelease) => { releaseInterruptTool = resolveRelease })
          }
          const result = {
            contentItems: [{ type: 'inputText', text: 'READY_TOOL_RESULT' }],
            success: true,
          }
          toolResults.set(key, result)
          return result
        },
      },
      requestTimeoutMs: 10_000,
      inboundDeadlineMs: 20_000,
      inboundMaxFrames: 256,
      inboundMaxBytes: 2 * 1024 * 1024,
      now: () => new Date().toISOString(),
      nowMs: Date.now,
    })

    const reserveAndAdmit = (
      runId: string,
      existingThread: boolean,
      targetScopeId = scopeId,
      targetThreadBindingId = threadBindingId,
      targetThreadCwd = threadCwd,
      targetAliasId = targetScopeId,
    ) => {
      const reservationResult = registry.reserve({ scopeId: targetScopeId, existingThread })
      assert.equal(reservationResult.ok, true)
      if (!reservationResult.ok) throw new Error(reservationResult.code)
      const run = prepared(
        runId,
        `message-${runId}`,
        reservationResult.reservation,
        targetScopeId,
        targetAliasId,
      )
      prepareParentRows(db, run)
      repository.admitProductBindings(admission(
        run,
        reservationResult.reservation,
        targetThreadCwd,
        runtime.manifestDigest,
        targetThreadBindingId,
      ))
      return run
    }

    repository.createEmptyAliasGeneration({
      threadBindingId,
      aliasId: scopeId,
      aliasGeneration: 1,
      readyScopeId: scopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e2e',
      createdAt: new Date().toISOString(),
    })
    const firstRun = reserveAndAdmit('run-first', false)
    await session.startAndInitialize({
      registry,
      snapshot: repository.readRecoverySnapshot(() => false),
    })
    const liveLease = repository.readLiveProcessLease()
    assert.ok(liveLease?.pid)
    const childEnvironment = execFileSync('/bin/ps', [
      'eww', '-p', String(liveLease.pid), '-o', 'command=',
    ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    assert.equal(childEnvironment.includes('host-secret-must-not-cross'), false)
    assert.equal(childEnvironment.includes(`READY_CODEX_PROCESS_LEASE_ID=${liveLease.processLeaseId}`), true)

    let client = session.getClient()
    const threadStarted = await client.threadStart({
      model: 'ready-e0-model',
      modelProvider: 'ready_gateway',
      allowProviderModelFallback: false,
      cwd: threadCwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      runtimeWorkspaceRoots: [],
      environments: [],
      dynamicTools: [{
        type: 'function',
        name: 'ready_read_probe',
        description: 'Read one deterministic fixture value.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      }],
      developerInstructions: 'Use only the Ready tools declared for this thread.',
    })
    assert.equal(threadStarted.instructionSources.length, 0)
    assert.equal(threadStarted.thread.cwd, threadCwd)
    assert.equal(threadStarted.thread.sessionId, threadStarted.thread.id)
    const runProductTurn = async (
      run: PreparedCodexProductRun,
      text: string,
      targetCodexThreadId = threadStarted.thread.id,
    ) => {
      const terminalPromise = waitForNotification(client, (notification) => (
        notification.method === 'turn/completed'
        && notification.params.threadId === targetCodexThreadId
      ))
      const params: CodexTurnStartParams = {
        threadId: targetCodexThreadId,
        clientUserMessageId: `client-message-${run.runId}`,
        input: [{ type: 'text', text, text_elements: [] }],
        additionalContext: {},
        responsesapiClientMetadata: {
          readyRunId: run.runId,
          toolSurfaceDigest: 'tool-surface-e2e',
          turnContractDigest: `turn-contract-${run.runId}`,
          upstreamProfileSnapshotDigest: 'profile-digest-e2e',
        },
      }
      const started = await client.turnStart(params)
      const terminal = await terminalPromise
      assert.equal(terminal.method, 'turn/completed')
      if (terminal.method !== 'turn/completed') throw new Error('terminal_missing')
      assert.equal(terminal.params.turn.id, started.turn.id)
      const closeoutAt = new Date().toISOString()
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`).run(run.taskId)
        repository.completeCanonicalProductCloseoutInOpenTransaction({
          readyRunId: run.runId,
          productTerminalDigest: `terminal-${run.runId}`,
          closeoutAt,
        })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return terminal.params.turn
    }

    const firstTurn = await runProductTurn(firstRun, 'CALL_TOOL_TOKEN')
    assert.equal(firstTurn.status, 'completed')
    assert.equal(toolExecutions, 1)
    const firstRead = await client.threadRead({ threadId: threadStarted.thread.id, includeTurns: true })
    assert.ok(firstRead.thread.turns.flatMap((turn) => turn.items).some((item) => (
      item.type === 'userMessage' && item.clientId === 'client-message-run-first'
    )))
    const bootListed = await client.threadList({ limit: 100, cwd: threadCwd, sourceKinds: ['vscode'] })
    assert.equal(bootListed.data.filter((item) => item.id === threadStarted.thread.id).length, 1)
    client.sealBootReconciliation()

    const secondRun = reserveAndAdmit('run-second', true)
    await runProductTurn(secondRun, 'SECOND_USER_TOKEN')
    const secondRead = await client.threadRead({ threadId: threadStarted.thread.id, includeTurns: true })
    const clientIds = secondRead.thread.turns.flatMap((turn) => turn.items).flatMap((item) => (
      item.type === 'userMessage' && item.clientId ? [item.clientId] : []
    ))
    assert.ok(clientIds.includes('client-message-run-first'))
    assert.ok(clientIds.includes('client-message-run-second'))

    const interruptRun = reserveAndAdmit('run-interrupt', true)
    const interruptObserved = waitForNotification(client, (notification) => (
      notification.method === 'turn/started'
      && notification.params.threadId === threadStarted.thread.id
    ))
    const interruptedTerminal = waitForNotification(client, (notification) => (
      notification.method === 'turn/completed'
      && notification.params.threadId === threadStarted.thread.id
    ))
    const interruptStarted = await client.turnStart({
      threadId: threadStarted.thread.id,
      clientUserMessageId: 'client-message-run-interrupt',
      input: [{ type: 'text', text: 'INTERRUPT_TOKEN', text_elements: [] }],
      additionalContext: {},
      responsesapiClientMetadata: {
        readyRunId: interruptRun.runId,
        toolSurfaceDigest: 'tool-surface-e2e',
        turnContractDigest: 'turn-contract-run-interrupt',
        upstreamProfileSnapshotDigest: 'profile-digest-e2e',
      },
    })
    await interruptObserved
    await interruptToolEntered
    const interruptRequest = client.turnInterrupt({
      threadId: threadStarted.thread.id,
      turnId: interruptStarted.turn.id,
    })
    await new Promise((resolveDispatch) => setTimeout(resolveDispatch, 100))
    releaseInterruptTool?.()
    await interruptRequest
    const interrupted = await interruptedTerminal
    assert.equal(interrupted.method, 'turn/completed')
    if (interrupted.method !== 'turn/completed') throw new Error('interrupt_terminal_missing')
    assert.equal(interrupted.params.turn.status, 'interrupted')
    await waitUntilAsync(async () => {
      const read = await client.threadRead({ threadId: threadStarted.thread.id, includeTurns: true })
      return read.thread.status.type === 'idle' ? read : null
    })
    db.exec('BEGIN IMMEDIATE')
    try {
      const closeoutAt = new Date().toISOString()
      db.prepare(`UPDATE task_projections SET status = 'killed' WHERE task_id = ?`).run(interruptRun.taskId)
      repository.completeCanonicalProductCloseoutInOpenTransaction({
        readyRunId: interruptRun.runId,
        productTerminalDigest: 'terminal-run-interrupt',
        closeoutAt,
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    const postInterruptRun = reserveAndAdmit('run-post-interrupt', true)
    const postInterruptTurn = await runProductTurn(postInterruptRun, 'POST_INTERRUPT_TOKEN')
    assert.equal(postInterruptTurn.status, 'completed')

    const autoCompactArmRun = reserveAndAdmit('run-auto-compact-arm', true)
    await runProductTurn(autoCompactArmRun, 'AUTO_COMPACT_ARM_TOKEN')
    const autoCompactObserveRun = reserveAndAdmit('run-auto-compact-observe', true)
    const automaticCompactionObservations: Array<{
      threadId: string
      turnId: string
      itemId: string
    }> = []
    const collectedAfterCompaction = await new CodexTurnCollector(client).collect({
      readyTaskId: autoCompactObserveRun.taskId,
      readyRunId: autoCompactObserveRun.runId,
      scopeId,
      codexThreadId: threadStarted.thread.id,
      startTurn: () => client.turnStart({
        threadId: threadStarted.thread.id,
        clientUserMessageId: 'client-message-run-auto-compact-observe',
        input: [{ type: 'text', text: 'AUTO_COMPACT_OBSERVE_TOKEN', text_elements: [] }],
        additionalContext: {},
        responsesapiClientMetadata: {
          readyRunId: autoCompactObserveRun.runId,
          toolSurfaceDigest: 'tool-surface-e2e',
          turnContractDigest: 'turn-contract-run-auto-compact-observe',
          upstreamProfileSnapshotDigest: 'profile-digest-e2e',
        },
      }),
      terminalTimeoutMs: 20_000,
      actionReceiptRefs: [],
      interactionState: null,
      waitingFor: null,
      terminalReasonCandidate: 'done',
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
      onAutomaticCompactionObserved: (event) => automaticCompactionObservations.push(event),
      onProvisionalDelta: () => undefined,
    })
    assert.equal(
      collectedAfterCompaction.kind,
      'native_terminal',
      JSON.stringify({
        collectedAfterCompaction,
        automaticCompactionObservations,
        providerRequestCount: providerRequests.length,
        activeProviderResponses,
        stderr,
        inbound: session.getInboundBuffer().snapshot(),
      }),
    )
    assert.equal(collectedAfterCompaction.engineOutcome, 'completed')
    assert.equal(automaticCompactionObservations.length, 1)
    assert.equal(automaticCompactionObservations[0].threadId, threadStarted.thread.id)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_manual_compaction_bindings
    `).get<{ count: number }>()?.count, 0)
    db.exec('BEGIN IMMEDIATE')
    try {
      const closeoutAt = new Date().toISOString()
      db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`)
        .run(autoCompactObserveRun.taskId)
      repository.completeCanonicalProductCloseoutInOpenTransaction({
        readyRunId: autoCompactObserveRun.runId,
        productTerminalDigest: 'terminal-run-auto-compact-observe',
        closeoutAt,
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    const secondScopeId = 'scope-e2e-second-root'
    const secondThreadBindingId = 'thread-binding-e2e-second-root'
    const secondThreadCwd = join(state.threadCwdRoot, secondThreadBindingId)
    mkdirSync(secondThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: secondThreadBindingId,
      aliasId: secondScopeId,
      aliasGeneration: 1,
      readyScopeId: secondScopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e2e',
      createdAt: new Date().toISOString(),
    })
    const secondRootRun = reserveAndAdmit(
      'run-second-root',
      false,
      secondScopeId,
      secondThreadBindingId,
      secondThreadCwd,
    )
    const secondThreadStarted = await client.threadStart({
      model: 'ready-e0-model',
      modelProvider: 'ready_gateway',
      allowProviderModelFallback: false,
      cwd: secondThreadCwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      runtimeWorkspaceRoots: [],
      environments: [],
      dynamicTools: [{
        type: 'function',
        name: 'ready_read_probe',
        description: 'Read one deterministic fixture value.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      }],
      developerInstructions: 'Use only the Ready tools declared for this thread.',
    })
    assert.notEqual(secondThreadStarted.thread.id, threadStarted.thread.id)

    const sameScopeAliasId = 'alias-e2e-same-scope-root'
    const sameScopeThreadBindingId = 'thread-binding-e2e-same-scope-root'
    const sameScopeThreadCwd = join(state.threadCwdRoot, sameScopeThreadBindingId)
    mkdirSync(sameScopeThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: sameScopeThreadBindingId,
      aliasId: sameScopeAliasId,
      aliasGeneration: 1,
      readyScopeId: scopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e2e',
      createdAt: new Date().toISOString(),
    })
    const sameScopeRootRun = reserveAndAdmit(
      'run-same-scope-root',
      false,
      scopeId,
      sameScopeThreadBindingId,
      sameScopeThreadCwd,
      sameScopeAliasId,
    )
    const sameScopeThreadStarted = await client.threadStart({
      model: 'ready-e0-model',
      modelProvider: 'ready_gateway',
      allowProviderModelFallback: false,
      cwd: sameScopeThreadCwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      runtimeWorkspaceRoots: [],
      environments: [],
      dynamicTools: [{
        type: 'function',
        name: 'ready_read_probe',
        description: 'Read one deterministic fixture value.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      }],
      developerInstructions: 'Use only the Ready tools declared for this thread.',
    })
    assert.notEqual(sameScopeThreadStarted.thread.id, threadStarted.thread.id)
    assert.equal(activeProviderResponses, 0)
    maxActiveProviderResponses = 0
    const sameScopePrimaryRun = reserveAndAdmit('run-same-scope-primary-concurrent', true)
    const [sameScopePrimaryTurn, sameScopeConcurrentTurn] = await Promise.all([
      runProductTurn(sameScopePrimaryRun, 'CONCURRENT_ROOT_TOKEN_SAME_SCOPE_PRIMARY'),
      runProductTurn(
        sameScopeRootRun,
        'CONCURRENT_ROOT_TOKEN_SAME_SCOPE_SECOND',
        sameScopeThreadStarted.thread.id,
      ),
    ])
    assert.equal(sameScopePrimaryTurn.status, 'completed')
    assert.equal(sameScopeConcurrentTurn.status, 'completed')
    assert.ok(maxActiveProviderResponses >= 2)

    assert.equal(activeProviderResponses, 0)
    maxActiveProviderResponses = 0
    const primaryConcurrentRun = reserveAndAdmit('run-cross-scope-primary-concurrent', true)
    const [primaryConcurrentTurn, secondConcurrentTurn] = await Promise.all([
      runProductTurn(primaryConcurrentRun, 'CONCURRENT_ROOT_TOKEN_CROSS_SCOPE_PRIMARY'),
      runProductTurn(
        secondRootRun,
        'CONCURRENT_ROOT_TOKEN_CROSS_SCOPE_SECOND',
        secondThreadStarted.thread.id,
      ),
    ])
    assert.equal(primaryConcurrentTurn.status, 'completed')
    assert.equal(secondConcurrentTurn.status, 'completed')
    assert.ok(maxActiveProviderResponses >= 2)

    repository.beginManualCompaction({
      manualCompactionId: 'manual-e2e',
      threadBindingId,
      ownerMainBootId,
      codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-e2e',
      upstreamProfileSnapshotDigest: 'profile-digest-e2e',
      providerSnapshot: { route: 'fixture' },
      credentialReferenceId: 'credential-e2e',
      expectedToolsDigest: 'empty-tools-digest',
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
      createdAt: new Date().toISOString(),
    })
    session.getInboundBuffer().registerProvisionalManualCompaction({
      manualCompactionId: 'manual-e2e',
      connectionEpoch: liveLease.connectionEpoch,
      threadId: threadStarted.thread.id,
      deadlineAtMs: Date.now() + 20_000,
    })
    const compactPeerRun = reserveAndAdmit(
      'run-manual-compact-peer',
      true,
      secondScopeId,
      secondThreadBindingId,
      secondThreadCwd,
    )
    assert.equal(activeProviderResponses, 0)
    maxActiveProviderResponses = 0
    delayAllProviderResponses = true
    const [, compactPeerTurn] = await Promise.all([
      client.threadCompactStart({ threadId: threadStarted.thread.id }),
      runProductTurn(
        compactPeerRun,
        'MANUAL_COMPACT_PEER_TOKEN',
        secondThreadStarted.thread.id,
      ),
    ]).finally(() => { delayAllProviderResponses = false })
    assert.equal(compactPeerTurn.status, 'completed')
    assert.ok(maxActiveProviderResponses >= 2)
    const manualEvidence = await waitUntil(() => (
      session?.getInboundBuffer().readManualCompactionEvidence('manual-e2e') || null
    )).catch(() => {
      throw new Error(`manual_evidence_timeout:${JSON.stringify({
        buffer: session?.getInboundBuffer().snapshot(),
        manualDiagnostic: session?.getInboundBuffer().readManualCompactionDiagnostic('manual-e2e'),
        providerRequestCount: providerRequests.length,
        activeProviderResponses,
        interruptFixtureConsumed,
        sessionLive: session?.isConnectionLive(liveLease.connectionEpoch),
      })}`)
    })
    assert.equal(manualEvidence.terminalStatus, 'completed')
    const compactRead = await client.threadRead({ threadId: threadStarted.thread.id, includeTurns: true })
    repository.consumeManualCompaction({
      manualCompactionId: 'manual-e2e',
      codexCompactionTurnId: manualEvidence.turnId,
      contextCompactionItemId: manualEvidence.contextCompactionItemId,
      threadReadDigest: JSON.stringify(compactRead.thread),
      consumedAt: new Date().toISOString(),
    })
    await session.getInboundBuffer().reconcileTurn({
      bindingId: 'manual-e2e',
      connectionEpoch: liveLease.connectionEpoch,
      threadId: threadStarted.thread.id,
      nativeTurnId: manualEvidence.turnId,
    })

    const resumed = await client.threadResume({ threadId: threadStarted.thread.id })
    assert.equal(resumed.instructionSources.length, 0)

    await session.stop()
    assert.equal(repository.readLiveProcessLease(), null)
    const ingressGateEvents: string[] = []
    const bootActions = new CodexDefaultBootRecoveryActions({
      runtime: {
        threadList: (params) => session!.getClient().threadList(params),
        threadRead: (params) => session!.getClient().threadRead(params),
      },
      repository,
      pinnedThreadSource: runtime.contracts.turnClientIdentityExtractionContract
        .thread_start.pinnedAppServerSource,
      threadListLimit: 100,
      stableZeroReadCount: 2,
      waitBetweenZeroReads: async () => undefined,
      heldStartDispatcher: {
        async dispatch() { throw new Error('unexpected_held_start_during_clean_restart') },
      },
      absenceProof: {
        async prove() { throw new Error('unexpected_absence_proof_during_clean_restart') },
      },
      hostFailureTerminal: {
        async commit() { throw new Error('unexpected_host_failure_during_clean_restart') },
      },
      manualCompaction: {
        async reconcile() { throw new Error('unexpected_manual_recovery_during_clean_restart') },
      },
      productFence: {
        async reconcile() { throw new Error('unexpected_product_fence_during_clean_restart') },
      },
    })
    const boot = await new CodexRuntimeBootReconciler({
      runtime,
      repository,
      supervisor,
      sidecarSession: session,
      actions: bootActions,
      ingressGate: {
        close: (reason) => ingressGateEvents.push(`closed:${reason}`),
        open: () => ingressGateEvents.push('open'),
      },
      now: () => new Date().toISOString(),
    }).boot()
    registry = boot.registry
    assert.deepEqual(boot.unresolvedStartBindings, [])
    assert.deepEqual(ingressGateEvents, ['closed:boot_reconciliation_pending', 'open'])
    client = session.getClient()
    const restartedRead = await client.threadRead({ threadId: threadStarted.thread.id, includeTurns: true })
    assert.ok(restartedRead.thread.turns.length >= 5)
    const restartedSecondRead = await client.threadRead({
      threadId: secondThreadStarted.thread.id,
      includeTurns: true,
    })
    assert.ok(restartedSecondRead.thread.turns.length >= 1)
    const restartedSameScopeRead = await client.threadRead({
      threadId: sameScopeThreadStarted.thread.id,
      includeTurns: true,
    })
    assert.ok(restartedSameScopeRead.thread.turns.length >= 1)
    const restartedResume = await client.threadResume({ threadId: threadStarted.thread.id })
    assert.equal(restartedResume.thread.id, threadStarted.thread.id)
    await assert.rejects(
      client.threadArchive({ threadId: threadStarted.thread.id }),
      /thread_archive_not_retired/,
    )
    repository.resetIdleAlias({
      aliasId: scopeId,
      expectedGeneration: 1,
      retirementEvidenceDigest: 'retire-main-e2e',
      resetAt: new Date().toISOString(),
    })
    await assert.rejects(
      client.threadArchive({ threadId: threadStarted.thread.id }),
      /thread_archive_call_unresolved/,
    )
    repository.resetIdleAlias({
      aliasId: secondScopeId,
      expectedGeneration: 1,
      retirementEvidenceDigest: 'retire-second-e2e',
      resetAt: new Date().toISOString(),
    })
    repository.resetIdleAlias({
      aliasId: sameScopeAliasId,
      expectedGeneration: 1,
      retirementEvidenceDigest: 'retire-same-scope-e2e',
      resetAt: new Date().toISOString(),
    })
    await client.threadArchive({ threadId: secondThreadStarted.thread.id })
    await client.threadArchive({ threadId: sameScopeThreadStarted.thread.id })

    assert.equal(registry.snapshot().capacityCharged, 0)
    assert.equal(toolExecutions, 2)
    assert.equal(preBindingToolExecutions, 0)
    assert.equal(stderr.join('').includes(gatewayToken), false)
    assert.ok(providerRequests.length >= 5)
    const providerToolSurfaces = providerRequests.map(providerToolNames)
    assert.ok(providerToolSurfaces.some((surface) => surface.length === 0))
    assert.ok(providerToolSurfaces.some((surface) => (
      surface.length === 1 && surface[0] === 'ready_read_probe'
    )))
    assert.equal(providerToolSurfaces.every((surface) => (
      surface.length === 0
      || (surface.length === 1 && surface[0] === 'ready_read_probe')
    )), true)
    assert.equal(JSON.stringify(providerRequests).includes(gatewayToken), false)
    assert.equal(JSON.stringify(providerRequests).includes('host-secret-must-not-cross'), false)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    if (session) await session.stop().catch(() => undefined)
    await closeServer(server)
    db.close()
    rmSync(tempRoot, { recursive: true, force: true })
    if (priorCanary === undefined) delete process.env.READY_E2_HOST_SECRET_CANARY
    else process.env.READY_E2_HOST_SECRET_CANARY = priorCanary
  }
})
