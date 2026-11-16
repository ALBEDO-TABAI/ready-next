import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

import type { DatabaseConnection } from '../main/modules/database/connection'
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
  digestReadyAdditionalContext,
  instructionTranscriptDigest,
  resolveCodexNativeModelSettings,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { verifyCodexAutomaticCompactionEvidence } from '../main/modules/agent-control/codex-runtime/codex-automatic-compaction-evidence'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { CodexModelGateway } from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import { CodexTurnInputBuilder } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import type { CodexNativeNotification } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import {
  CodexProductRunPreparer,
  isPreparedCodexProductRun,
  type PreparedCodexProductRun,
} from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { buildTerminalNativeReadbackReceipt, resolveCodexHistoryObservation, resolveCodexTerminalFacts,
  terminalEvidenceRef, terminalGatewayEvidenceRef, terminalNativeReadbackEvidenceRef } from '../main/modules/agent-control/codex-runtime/codex-terminal-facts'
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
import { CodexManualCompactionController } from '../main/modules/agent-control/codex-runtime/codex-manual-compaction-controller'
import { classifyLifecycleOperation } from '../shared/ipc-contracts/agent-lifecycle-snapshot'
import { createLifecycleStore } from '../main/modules/agent-control/codex-runtime/codex-product-lifecycle-store'
import { StableNativeRuntime } from '../main/modules/agent-control/codex-runtime/codex-stable-native-runtime'
import { CodexThreadResumeAuthority } from '../main/modules/agent-control/codex-runtime/codex-thread-resume-authority'
import { ReadyCodexLifecycleAdapter } from '../main/modules/agent-control/codex-runtime/ready-codex-lifecycle-adapter'
import {
  CodexSidecarSupervisor,
  MacCodexProcessInspector,
  NodeCodexSidecarSpawnPort,
} from '../main/modules/agent-control/codex-runtime/codex-sidecar-supervisor'
import { createCodexStartIdentityRegistryForRuntime } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import { codexRequestToolsDigest } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
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
  text: string,
  reservation: StartIdentityReservationSet,
  actionAdmissionRef: PreparedCodexProductRun['ingress']['actionAdmissionRef'],
  runScopeId = scopeId,
  readyToolSurface: PreparedCodexProductRun['readyToolSurface'] = createCodexToolFixture([]).readyToolSurface,
): PreparedCodexProductRun {
  const maxToolCalls = readyToolSurface.toolNames.length > 0 ? 4 : 0
  const resourceRefs = ['run-first', 'run-second', 'run-native-tool-midturn'].includes(runId)
    ? [{ logicalResourceId: 'document-e3', currentVersion: 'v1', currentDigest: 'f'.repeat(64), supersedesVersion: null, policyEpoch: 1 }]
    : []
  const result = new CodexProductRunPreparer().prepare({
    readyMemorySnapshot: disabledReadyMemorySnapshot(),
    taskId: `task-${runId}`,
    runId,
    scopeId: runScopeId, aliasId: runScopeId, aliasGeneration: 1,
    requestId: `request-${runId}`, taskOrigin: 'user_root', runOrigin: 'initial',
    reservationSetId: reservation.reservationSetId,
    reservationEvidenceDigest: reservation.reservationEvidenceDigest,
    originUserMessageId: `message-${runId}`,
    currentInput: [{ type: 'text', text, text_elements: [] }],
    explicitResourceEnvelope: { input: [], resourceRefs },
    resourceAdditionalContext: resourceRefs, actionAdmissionRef,
    uncommittedTailAssignments: [], supersededUncommittedItems: [],
    trustedWorkbenchMode: 'browser',
    readyToolSurface,
    readyTurnToolAuthorization: createCodexAuthorizationForSurface(
      readyToolSurface,
      `authorization-${runId}`,
    ),
    authorizationOwnerId: `owner-${runId}`,
    resourceOwnerId: `resource-owner-${runId}`,
    productBudgetSeed: {
      maxIterations: 8, maxToolCalls, maxParallelToolGroups: 1,
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error(result.code)
  return result.prepared
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
  let toolResponseDeliveries = 0
  let midTurnProductRequests = 0
  let validatedRequest: { readyRunId: string | null; requestKind: string } | null = null
  const upstream = createServer(async (request, response) => {
    upstreamSequence += 1
    upstreamPaths.push(request.url || '')
    upstreamAuthPresent.push(Boolean(request.headers.authorization))
    const upstreamBody = await readBody(request)
    upstreamBodies.push(upstreamBody)
    const upstreamText = JSON.stringify(upstreamBody)
    // The provider is never told which run a request belongs to (client metadata stays on this machine), so the
    // fixture reads it from the gateway's own record of the request it has just validated.
    assert.equal('client_metadata' in upstreamBody, false, 'client metadata does not reach an API-key provider')
    const readyRunId = validatedRequest?.readyRunId ?? ''
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (request.url === '/v1/responses' && readyRunId === 'run-native-tool-midturn') {
      // Two tool rounds report a nearly full context, so Codex compacts mid-turn before each next sampling.
      const compaction = validatedRequest?.requestKind !== 'product'
      if (!compaction) midTurnProductRequests += 1
      const responseId = `midturn-response-${upstreamSequence}`
      const item = compaction
        ? { type: 'message', id: `midturn-summary-${upstreamSequence}`, role: 'assistant',
            content: [{ type: 'output_text', text: 'MIDTURN_SUMMARY' }] }
        : midTurnProductRequests <= 2
          ? { type: 'function_call', id: `midturn-call-item-${midTurnProductRequests}`,
              call_id: `midturn-call-${midTurnProductRequests}`, name: 'ready_read_probe', arguments: '{"query":"q"}' }
          : { type: 'message', id: `midturn-final-${upstreamSequence}`, role: 'assistant', phase: 'final_answer',
              content: [{ type: 'output_text', text: 'midturn done' }] }
      const totalTokens = !compaction && midTurnProductRequests <= 2 ? 60_000 : 500
      const text = item.type === 'message' ? (item.content as Array<{ text: string }>)[0].text : null
      const itemEvents = text === null
        ? [
            { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: '{"query":"q"}' },
            { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: '{"query":"q"}' },
          ]
        : [
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
            { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text },
          ]
      response.end([
        { type: 'response.created', response: { id: responseId, model: 'upstream-native-model', status: 'in_progress', output: [] } },
        ...itemEvents,
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: responseId, model: 'upstream-native-model', status: 'completed', output: [item],
          usage: { input_tokens: totalTokens - 10, output_tokens: 10, total_tokens: totalTokens,
            input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      return
    }
    if (request.url === '/v1/responses') {
      if (readyRunId === 'run-native-tool-long') {
        if (upstreamText.includes('UNEXPECTED_TOOL_RESULT')) {
          const item = {
            type: 'message', id: `native-long-final-${upstreamSequence}`, role: 'assistant',
            content: [{ type: 'output_text', text: 'long tool delivered' }],
          }
          response.end([
            {
              type: 'response.created',
              response: {
                id: `native-long-response-${upstreamSequence}`,
                model: 'upstream-native-model', status: 'in_progress', output: [],
              },
            },
            {
              type: 'response.output_item.added', output_index: 0,
              item: { ...item, content: [] },
            },
            {
              type: 'response.output_text.delta', output_index: 0, content_index: 0,
              item_id: item.id, delta: 'long tool delivered',
            },
            {
              type: 'response.output_text.done', output_index: 0, content_index: 0,
              item_id: item.id, text: 'long tool delivered',
            },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: `native-long-response-${upstreamSequence}`,
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
        // The model first calls the tool with arguments its schema rejects. The gateway passes that on as a
        // refused call, the runtime answers it as unsupported, and the model's next call is in order.
        const corrected = upstreamText.includes('unsupported call: invalid_arguments__ready_read_probe')
        const pieces = corrected
          ? ['{"query":"', ...Array.from({ length: 4_998 }, () => 'a'), '"}']
          : ['{"wrong":true}']
        const argumentsValue = pieces.join('')
        const item = {
          type: 'function_call', id: `native-long-item-${upstreamSequence}`,
          call_id: `native-long-call-${upstreamSequence}`,
          name: 'ready_read_probe', arguments: argumentsValue,
        }
        const events = [
          {
            type: 'response.created',
            response: {
              id: `native-long-response-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'in_progress', output: [],
            },
          },
          {
            type: 'response.output_item.added', output_index: 0,
            item: { ...item, arguments: '', status: 'in_progress' },
          },
          ...pieces.map((delta) => ({
            type: 'response.function_call_arguments.delta', output_index: 0,
            item_id: item.id, delta,
          })),
          {
            type: 'response.function_call_arguments.done', output_index: 0,
            item_id: item.id, arguments: argumentsValue,
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: `native-long-response-${upstreamSequence}`,
              model: 'upstream-native-model', status: 'completed', output: [item],
              usage: {
                input_tokens: 8, output_tokens: 2, total_tokens: 10,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        ]
        response.end(events.map((event) => (
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        )).join(''))
        return
      }
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
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0,
        closed_at TEXT
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL,
        timestamp TEXT NOT NULL, meta_json TEXT NOT NULL,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        status TEXT NOT NULL, execution_binding_json TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE run_meta (
        run_id TEXT PRIMARY KEY, task_id TEXT, scope_id TEXT,
        status TEXT NOT NULL, terminal_reason TEXT, execution_binding_json TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
    `)
    __runMigrationForTests('053_pending_confirmations', db as unknown as MigrationDatabase)
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
    __runMigrationForTests('111_codex_gateway_budget_lanes', db as unknown as MigrationDatabase)
    const paths = resolveCodexRuntimePaths({
      appPath: repoRoot, resourcesPath: join(repoRoot, 'assets'), isPackaged: false,
    })
    const runtime = loadVerifiedCodexRuntime(paths)
    const repository = new CodexBindingRepository(db as unknown as DatabaseConnection, {
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e3',
      runtimeContinuityCatalog: { contract: 'ready_runtime_continuity_catalog_v1', targetManifestDigest: runtime.manifestDigest, transitions: [] },
    })
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
      onValidatedRequest(capture) { validatedRequest = capture },
    })
    const gatewayAddress = await gateway.start()
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
        confirmServerResponseTransportWrite() { toolResponseDeliveries += 1 },
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
      text: string,
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
      db.prepare(`INSERT OR IGNORE INTO chat_conversations (id) VALUES (?)`).run(runScopeId)
      const head = projectCodexHeadActionProjection(repository.readHeadActionFacts({
        aliasId: runScopeId, aliasGeneration: 1,
        currentRuntimeManifestDigest: runtime.manifestDigest,
        currentProtocolSchemaDigest: 'protocol-schema-e3',
      }))
      const actionAdmissionRef = {
        headProjectionDigest: head.evidenceDigest,
        actionProjectionVersion: head.actionProjectionVersion,
        actionHeadIdentity: head.actionHeadIdentity!,
      }
      const run = prepared(runId, text, reserved.reservation, actionAdmissionRef, runScopeId, readyToolSurface)
      const executionBinding = { schemaVersion: 1, runId: run.runId }
      const parentMeta = { requestId: run.ingressBinding.requestId }
      const parentTimestamp = '2026-08-07T00:00:00.000Z'
      const messageContent = run.ingress.canonicalCurrentInputRef.input
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
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
      assert.equal(isPreparedCodexProductRun(run), true, JSON.stringify(run))
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
        additionalContextDigest: digestReadyAdditionalContext({ resourceReferences: run.ingress.resourceAdditionalContext, explicitRetry: null }),
        turnContractDigest: `turn-contract-${runId}`,
        continuationCandidate: existingThread ? {
          model: 'ready-e0-model', threadConfig: resolveCodexNativeModelSettings(upstreamSnapshot.snapshot).threadConfig,
          isolatedThreadCwd: runThreadCwd, cwdAvailable: true,
          instructionContractDigest: instructionDigest, currentToolSurface: run.readyToolSurface,
        } : null,
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

    const firstText = `ARM_AUTOMATIC_COMPACTION\n${'x '.repeat(230_000)}`
    const firstRun = reserveAndAdmit('run-first', firstText, false)
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
    const closeoutRun = async (
      run: PreparedCodexProductRun,
      status: 'completed' | 'failed',
      candidate: CoreTurnCandidate,
    ): Promise<void> => {
      assert.equal(candidate.kind, 'native_terminal')
      if (candidate.kind !== 'native_terminal') throw new Error('native_terminal_missing')
      const closeoutAt = new Date().toISOString()
      const nativeThread = (await client.threadRead({ threadId: candidate.codexThreadId, includeTurns: true })).thread
      const automatic = verifyCodexAutomaticCompactionEvidence({ gatewayRepository, readyRunId: run.runId,
        codexThreadId: candidate.codexThreadId, codexTurnId: candidate.codexTurnId,
        upstreamProfileSnapshotDigest: snapshotByRun.get(run.runId)!.snapshotDigest,
        productRequestToolsDigest: codexRequestToolsDigest(run.readyToolSurface), thread: nativeThread })
      candidate.contextState = { ...candidate.contextState, automaticCompactionExchanges: automatic }
      repository.recordEngineTerminalCandidate({
        readyRunId: run.runId,
        codexThreadId: candidate.codexThreadId,
        codexTurnId: candidate.codexTurnId,
        engineOutcome: candidate.engineOutcome,
        candidate,
        recordedAt: closeoutAt,
      })
      repository.recordToolPublicationReceipt({ readyRunId: run.runId, recordedAt: closeoutAt })
      const engine = repository.readEngineTerminalCandidate(run.runId)!
      const identity = { readyRunId: run.runId, readyScopeId: run.readyToolHostIdentity.scopeId,
        messageVisibilityEpoch: 0, aliasGeneration: run.conversationAlias.aliasGeneration,
        codexThreadId: candidate.codexThreadId, codexTurnId: candidate.codexTurnId }
      const nativeReadback = buildTerminalNativeReadbackReceipt({ candidate, prepared: run,
        aliasGeneration: identity.aliasGeneration, messageVisibilityEpoch: 0,
        connectionEpoch: repository.readLiveProcessLease()!.connectionEpoch, turnRevision: engine.revision, thread: nativeThread })
      const gatewayEvidence = gatewayRepository.readTurnGatewayEvidence(identity)
      const evidence = [terminalEvidenceRef({ ...identity, kind: 'native_turn', revision: 1,
        receiptId: `engine-terminal:${run.runId}`, digest: engine.candidateDigest,
        ownerIdentity: { nativeTurnId: candidate.codexTurnId, terminalStatus: candidate.engineOutcome } }),
      terminalNativeReadbackEvidenceRef({ ...identity, revision: nativeReadback.turnRevision,
        receiptId: nativeReadback.receiptId, digest: nativeReadback.digest,
        ownerIdentity: { connectionEpoch: nativeReadback.connectionEpoch, readRevision: nativeReadback.turnRevision,
          verifiedThreadId: candidate.codexThreadId, verifiedTurnId: candidate.codexTurnId } }),
      ...gatewayEvidence.map((row) => terminalGatewayEvidenceRef({ ...identity,
        revision: row.responseSequence ?? row.requestSequence, receiptId: row.receiptId,
        digest: row.responseEvidenceDigest ?? row.requestEvidenceDigest,
        ownerIdentity: { gatewayRequestReceiptId: row.receiptId, eventSequence: row.responseSequence ?? row.requestSequence } }))]
      const history = resolveCodexHistoryObservation({ candidate, prepared: run,
        expectedClientUserMessageId: `client-message-${run.runId}`, thread: nativeThread, publicationDiverged: false,
        gatewayEvidence })
      assert.equal(history.kind, 'continuation_safe', JSON.stringify(history))
      const terminalFacts = resolveCodexTerminalFacts({ product: {
        terminal: status === 'completed' ? 'done' : 'error', terminalReason: status === 'completed' ? 'done' : 'blocked_external',
        failureKind: status === 'completed' ? null : 'provider', evidence,
      }, history, historyEvidence: evidence, effect: { state: 'none', evidence: [] } })
      const terminalMeta = {
        taskId: run.taskId,
        runId: run.runId,
        terminalReason: terminalFacts.product.terminalReason,
      }
      const messageId = `assistant:${run.taskId}:${run.runId}:terminal`
      const acceptedText = candidate.candidateSelection.kind === 'accepted'
        ? candidate.candidateText
        : null
      const publicText = status === 'completed' && acceptedText !== null
        ? acceptedText
        : '本轮未能完成，已保留已完成的工具和产物记录。'
      const productTerminalDigest = workflowDigest({
        id: messageId,
        conversationId: run.readyToolHostIdentity.scopeId,
        role: 'assistant',
        content: publicText,
        timestamp: closeoutAt,
        meta: terminalMeta,
      })
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`UPDATE task_projections SET status = ? WHERE task_id = ?`).run(
          status,
          run.taskId,
        )
        db.prepare('UPDATE run_meta SET status = ?, terminal_reason = ? WHERE run_id = ?')
          .run(terminalFacts.product.terminal, terminalFacts.product.terminalReason, run.runId)
        db.prepare(`
          INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
          VALUES (?, ?, 'assistant', ?, ?, ?, 0)
        `).run(
          messageId,
          run.readyToolHostIdentity.scopeId,
          publicText,
          closeoutAt,
          JSON.stringify(terminalMeta),
        )
        repository.completeCanonicalProductCloseoutInOpenTransaction({
          readyRunId: run.runId,
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
    const runTurn = async (
      run: PreparedCodexProductRun,
      text: string,
      expectedStatus: 'completed' | 'failed' = 'completed',
      runThreadId = startedThread.thread.id,
    ) => {
      assert.deepEqual(run.ingress.canonicalCurrentInputRef.input, [{ type: 'text', text, text_elements: [] }])
      const terminalPromise = waitForNotification(client, (notification) => (
        notification.method === 'turn/completed'
        && notification.params.threadId === runThreadId
      ))
      const built = new CodexTurnInputBuilder().build(run.ingress, {
        threadId: runThreadId, turnRequestId: `client-message-${run.runId}`, readyRunId: run.runId,
        reasoningEffort: snapshotByRun.get(run.runId)?.snapshot.reasoningEffort || null,
        toolSurfaceDigest: run.readyToolSurface.toolSurfaceDigest,
        turnContractDigest: `turn-contract-${run.runId}`,
        upstreamProfileSnapshotDigest: snapshotByRun.get(run.runId)!.snapshotDigest,
        readyMemorySnapshot: run.readyMemorySnapshot,
      })
      assert.ok(built.ok)
      if (!built.ok) throw new Error(built.code)
      const started = await client.turnStart(built.params)
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
      await closeoutRun(run, expectedStatus, candidate)
      return { turnId: started.turn.id }
    }
    await runTurn(firstRun, firstText)
    const secondRun = reserveAndAdmit('run-second', 'OBSERVE_AUTOMATIC_COMPACTION', true)
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
    const [automaticEvidence, ...extraAutomaticEvidence] = verifyCodexAutomaticCompactionEvidence({
      gatewayRepository,
      readyRunId: secondRun.runId,
      codexThreadId: startedThread.thread.id,
      codexTurnId: secondTurn.turnId,
      upstreamProfileSnapshotDigest: snapshot.snapshotDigest,
      productRequestToolsDigest: codexRequestToolsDigest(secondRun.readyToolSurface),
      thread: automaticReadback.thread,
    })
    assert.ok(automaticEvidence)
    assert.equal(extraAutomaticEvidence.length, 0)
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
      preDispatchThreadReadDigest: digestCanonicalJson(automaticReadback.thread),
      preDispatchTurnIds: automaticReadback.thread.turns.map((turn) => turn.id),
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
    const manualGateway = gatewayRepository.readManualCompactionGatewayEvidence({ manualCompactionId: 'manual-e3',
      codexThreadId: startedThread.thread.id, codexTurnId: manualEvidence.turnId })
    assert.ok(manualGateway)
    repository.consumeManualCompaction({
      manualCompactionId: 'manual-e3',
      codexCompactionTurnId: manualEvidence.turnId,
      notificationContextCompactionItemId: manualEvidence.contextCompactionItemId,
      contextCompactionItemId: readbackCompactionItems[0].id,
      threadReadDigest: digestCanonicalJson(compactRead.thread),
      terminalEvidenceDigest: digestCanonicalJson(compactTurn),
      gatewayRequestReceiptId: manualGateway.receiptId,
      gatewayRequestEvidenceDigest: manualGateway.requestEvidenceDigest,
      gatewayResponseEvidenceDigest: manualGateway.responseEvidenceDigest,
      consumedAt: new Date().toISOString(),
    })
    await session.getInboundBuffer().reconcileTurn({
      bindingId: 'manual-e3',
      connectionEpoch: startedSession.connectionEpoch,
      threadId: startedThread.thread.id,
      nativeTurnId: manualEvidence.turnId,
    })

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

    const liveLease = repository.readLiveProcessLease()
    assert.ok(liveLease?.pid)
    const childEnvironment = execFileSync('/bin/ps', [
      'eww', '-p', String(liveLease.pid), '-o', 'command=',
    ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    assert.equal(childEnvironment.includes('host-secret-e3-must-not-cross'), false)
    assert.equal(upstreamPaths.every((path) => (
      path === '/v1/chat/completions' || path === '/v1/responses'
    )), true)
    assert.equal(upstreamAuthPresent.every(Boolean), true)
    assert.ok(upstreamBodies.some((body) => body.model === 'upstream-chat-model'))
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

    const longToolScopeId = 'scope-e3-native-tool-long'
    const longToolThreadBindingId = 'thread-binding-e3-native-tool-long'
    const longToolThreadCwd = join(state.threadCwdRoot, longToolThreadBindingId)
    mkdirSync(longToolThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: longToolThreadBindingId,
      aliasId: longToolScopeId,
      aliasGeneration: 1,
      readyScopeId: longToolScopeId,
      runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e3',
      createdAt: new Date().toISOString(),
    })
    const longToolRun = reserveAndAdmit(
      'run-native-tool-long',
      'TRIGGER_NATIVE_TOOL_LONG',
      false,
      nativeFailureSnapshot,
      longToolScopeId,
      longToolThreadBindingId,
      longToolThreadCwd,
      toolSurface,
    )
    const longToolThread = await client.threadStart({
      model: 'ready-e0-model', modelProvider: 'ready_gateway',
      allowProviderModelFallback: false, cwd: longToolThreadCwd,
      approvalPolicy: 'never', sandbox: 'read-only',
      runtimeWorkspaceRoots: [], environments: [], config: null,
      dynamicTools: [{
        type: 'function', name: responseTool.name, description: responseTool.description,
        inputSchema: toolParameters,
      }],
      developerInstructions,
    })
    const executionsBeforeLongTool = toolExecutions
    const deliveriesBeforeLongTool = toolResponseDeliveries
    const longToolCandidate = await new CodexTurnCollector(client).collect({
      readyTaskId: longToolRun.taskId,
      readyRunId: longToolRun.runId,
      scopeId: longToolScopeId,
      codexThreadId: longToolThread.thread.id,
      startTurn: () => client.turnStart({
        threadId: longToolThread.thread.id,
        clientUserMessageId: 'client-message-run-native-tool-long',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'ready-e0-model',
            reasoning_effort: nativeFailureSnapshot.snapshot.reasoningEffort,
            developer_instructions: null,
          },
        },
        environments: [],
        input: longToolRun.ingress.canonicalCurrentInputRef.input,
        additionalContext: {},
        responsesapiClientMetadata: {
          readyRunId: longToolRun.runId,
          toolSurfaceDigest: longToolRun.readyToolSurface.toolSurfaceDigest,
          turnContractDigest: `turn-contract-${longToolRun.runId}`,
          upstreamProfileSnapshotDigest: nativeFailureSnapshot.snapshotDigest,
        },
      }),
      terminalTimeoutMs: 20_000,
      actionReceiptRefs: [], interactionState: null, waitingFor: null,
      terminalReasonCandidate: 'done', abortInitiator: null,
      budgetState: {}, contextState: {}, providerDiagnostics: {},
      recoveryCheckpointRef: null, browserContinuationRef: null,
      browserProofRefs: [], otherProofRefs: [], projectionPatchRefs: [],
      allowNullPhaseFallback: true,
      allowDirectProvisionalStream: false,
      onProvisionalDelta: () => undefined,
    })
    assert.equal(
      longToolCandidate.engineOutcome,
      'completed',
      JSON.stringify({
        candidate: longToolCandidate,
        stderr: stderr.join('').slice(-4_000),
        upstreamBody: upstreamBodies.at(-1),
      }),
    )
    assert.ok(
      upstreamBodies.some((body) => JSON.stringify(body).includes('unsupported call: invalid_arguments__ready_read_probe')),
      'the refused call came back to the model as an unsupported call and the turn went on',
    )
    assert.equal(longToolCandidate.usedToolCalls.length, 1)
    assert.ok((longToolCandidate.contextUsage?.usedInputTokens || 0) > 0)
    assert.equal(longToolCandidate.contextUsage?.source, 'last_model_request')
    assert.equal(toolExecutions, executionsBeforeLongTool + 1)
    assert.equal(toolResponseDeliveries, deliveriesBeforeLongTool + 1)
    assert.ok(upstreamPaths.includes('/v1/responses'))
    assert.ok(upstreamBodies.some((body) => body.model === 'upstream-native-model'))

    // 2026-10-06: a 37-tool document turn filled the context; Codex compacted mid-turn and the gateway rejected it,
    // then dropped the turn's Ready context after compaction, and closeout accepted only one compaction per turn.
    const midTurnScopeId = 'scope-e3-native-tool-midturn'
    const midTurnThreadBindingId = 'thread-binding-e3-native-tool-midturn'
    const midTurnThreadCwd = join(state.threadCwdRoot, midTurnThreadBindingId)
    mkdirSync(midTurnThreadCwd, { recursive: true })
    repository.createEmptyAliasGeneration({
      threadBindingId: midTurnThreadBindingId, aliasId: midTurnScopeId, aliasGeneration: 1,
      readyScopeId: midTurnScopeId, runtimeManifestDigest: runtime.manifestDigest,
      protocolSchemaDigest: 'protocol-schema-e3', createdAt: new Date().toISOString(),
    })
    const midTurnRun = reserveAndAdmit('run-native-tool-midturn', 'TRIGGER_MID_TURN_COMPACTION', false,
      nativeFailureSnapshot, midTurnScopeId, midTurnThreadBindingId, midTurnThreadCwd, toolSurface)
    const midTurnThread = await client.threadStart({
      model: 'ready-e0-model', modelProvider: 'ready_gateway',
      allowProviderModelFallback: false, cwd: midTurnThreadCwd,
      approvalPolicy: 'never', sandbox: 'read-only',
      runtimeWorkspaceRoots: [], environments: [],
      // Production sets only the window; Codex derives the compaction threshold from it, which the 60k usage exceeds.
      config: { model_context_window: 50_000 },
      dynamicTools: [{ type: 'function', name: responseTool.name, description: responseTool.description, inputSchema: toolParameters }],
      developerInstructions,
    })
    const midTurnInput = new CodexTurnInputBuilder().build(midTurnRun.ingress, {
      threadId: midTurnThread.thread.id, turnRequestId: 'client-message-run-native-tool-midturn',
      readyRunId: midTurnRun.runId, reasoningEffort: nativeFailureSnapshot.snapshot.reasoningEffort,
      toolSurfaceDigest: midTurnRun.readyToolSurface.toolSurfaceDigest,
      turnContractDigest: `turn-contract-${midTurnRun.runId}`,
      upstreamProfileSnapshotDigest: nativeFailureSnapshot.snapshotDigest,
      readyMemorySnapshot: midTurnRun.readyMemorySnapshot,
    })
    if (!midTurnInput.ok) throw new Error(midTurnInput.code)
    const midTurnCandidate = await new CodexTurnCollector(client).collect({
      readyTaskId: midTurnRun.taskId, readyRunId: midTurnRun.runId, scopeId: midTurnScopeId,
      codexThreadId: midTurnThread.thread.id,
      startTurn: () => client.turnStart(midTurnInput.params),
      terminalTimeoutMs: 20_000,
      actionReceiptRefs: [], interactionState: null, waitingFor: null,
      terminalReasonCandidate: 'done', abortInitiator: null,
      budgetState: {}, contextState: {}, providerDiagnostics: {},
      recoveryCheckpointRef: null, browserContinuationRef: null,
      browserProofRefs: [], otherProofRefs: [], projectionPatchRefs: [],
      allowNullPhaseFallback: true, allowDirectProvisionalStream: false, onProvisionalDelta: () => undefined,
    })
    assert.equal(midTurnCandidate.engineOutcome, 'completed', JSON.stringify({
      candidate: midTurnCandidate, stderr: stderr.join('').slice(-4_000), upstreamBody: upstreamBodies.at(-1),
    }))
    assert.equal(midTurnCandidate.usedToolCalls.length, 2)
    assert.equal(midTurnCandidate.kind === 'native_terminal' && midTurnCandidate.candidateText, 'midturn done')
    const midTurnRows = gatewayRepository.readTurnGatewayEvidence({
      readyRunId: midTurnRun.runId, codexThreadId: midTurnThread.thread.id, codexTurnId: midTurnCandidate.codexTurnId,
    })
    assert.deepEqual(midTurnRows.map((row) => row.requestKind),
      ['product', 'automatic_compaction', 'product', 'automatic_compaction', 'product'],
      'both mid-turn compactions crossed the Ready gateway and the turn continued after each')
    const midTurnReadback = (await client.threadRead({ threadId: midTurnThread.thread.id, includeTurns: true })).thread
    const midTurnEvidence = verifyCodexAutomaticCompactionEvidence({
      gatewayRepository, readyRunId: midTurnRun.runId, codexThreadId: midTurnThread.thread.id,
      codexTurnId: midTurnCandidate.codexTurnId, upstreamProfileSnapshotDigest: nativeFailureSnapshot.snapshotDigest,
      productRequestToolsDigest: codexRequestToolsDigest(midTurnRun.readyToolSurface), thread: midTurnReadback,
    })
    assert.equal(midTurnEvidence.length, 2, 'each compaction is paired with the request after it')
    midTurnCandidate.contextState = { ...midTurnCandidate.contextState, automaticCompactionExchanges: midTurnEvidence }
    const midTurnHistory = resolveCodexHistoryObservation({
      candidate: midTurnCandidate, prepared: midTurnRun,
      expectedClientUserMessageId: 'client-message-run-native-tool-midturn', thread: midTurnReadback,
      publicationDiverged: false, gatewayEvidence: midTurnRows,
    })
    assert.equal(midTurnHistory.kind, 'continuation_safe', JSON.stringify(midTurnHistory))

    // 2026-10-07: after Ready restarted, manual compaction targeted a thread the new runtime process had not loaded.
    // Codex answered “thread not found”, the request stayed pending with its fence, and boot recovery then called it
    // unknown so the conversation could only be reset. Drive the production lifecycle pieces over the real binary.
    const loadedThreads = new Set<string>()
    const unexpected = (): never => { throw new Error('unexpected_lifecycle_call') }
    const stableRuntime = new StableNativeRuntime(() => session!.getClient())
    let lifecycleAdapter: ReadyCodexLifecycleAdapter<unknown> | null = null
    const createManualController = () => new CodexManualCompactionController({
      repository, gatewayRepository, getSession: () => session,
      ensureThreadLoaded: async (identity) => { await lifecycleAdapter!.ensureNativeThreadLoaded(identity) },
      ownerMainBootId: 'main-boot-e3', timeoutMs: 20_000,
      now: () => new Date().toISOString(), nowMs: Date.now,
    })
    let manualController = createManualController()
    const lifecycleStore = createLifecycleStore({
      repository, nativeRuntime: stableRuntime, getHost: () => null, getRegistry: () => registry,
      createAliasAtomic: unexpected, loadedThreads,
      getActiveConnectionEpoch: () => session!.getActiveConnectionEpoch(),
      currentRuntimeManifestDigest: runtime.manifestDigest, currentProtocolSchemaDigest: 'protocol-schema-e3',
      settleHostFailureCloseout: unexpected, scheduleThreadArchiveCleanup: () => undefined,
      sealClosedConversationInOpenTransaction: unexpected, settleEngineTerminalUserStop: unexpected,
      settleReadbackTerminalUserStop: unexpected, retryEngineTerminalUserStopFinalization: unexpected,
      get manualCompactionController() { return manualController },
      getDeveloperInstructions: () => developerInstructions, getNativeModelSettings: unexpected,
      getThreadDeveloperInstructions: (digest) => {
        assert.equal(digest, instructionDigest)
        return developerInstructions
      },
    })
    lifecycleAdapter = new ReadyCodexLifecycleAdapter<unknown>({
      nativeRuntime: stableRuntime,
      threadResumePort: new CodexThreadResumeAuthority(() => session),
      collector: new CodexTurnCollector(stableRuntime),
      inputBuilder: new CodexTurnInputBuilder(),
      lifecycleStore,
      closeout: {} as never,
    })
    // Each restart stands for a new Ready launch, which starts with a fresh supervisor and crash budget.
    const restartRuntime = async () => {
      await session!.stop()
      supervisor.resetCrashBudgetForExplicitRetry()
      loadedThreads.clear()
      await session!.startAndInitialize({ registry, snapshot: repository.readRecoverySnapshot(() => false) })
      client = session!.getClient()
    }
    const mainIdentity = { aliasId: scopeId, aliasGeneration: 1 }
    const snapshotOf = async () => classifyLifecycleOperation(
      (await lifecycleStore.readLifecycleOperation(mainIdentity)).facts,
    )
    const fenceCount = () => db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences WHERE thread_binding_id = ?
    `).get<{ count: number }>(threadBindingId)?.count

    // The main thread was compacted before the earlier restart. Codex rebuilds a compacted thread's context on resume
    // without its developer instructions unless the resume carries them; the gateway would refuse the next turn.
    await restartRuntime()
    await lifecycleAdapter.ensureNativeThreadLoaded(mainIdentity)
    await runTurn(reserveAndAdmit('run-after-restart', 'AFTER_RESTART_TURN', true), 'AFTER_RESTART_TURN')

    await restartRuntime()
    const rejectedPending = await manualController.begin(mainIdentity)
    await assert.rejects(
      client.threadCompactStart({ threadId: startedThread.thread.id }),
      (error: { code?: string; details?: { message?: string } }) => (
        error.code === 'rpc_rejected' && /thread not found/.test(error.details?.message || '')
      ),
      'an unloaded thread cannot be compacted',
    )
    assert.equal(fenceCount(), 1, 'the rejected request is left pending with its fence, as in the user data')
    assert.equal(await snapshotOf(), 'manual_compaction_pending')

    await restartRuntime()
    manualController = createManualController()
    const rejectedRecovery = repository.readRecoverySnapshot(() => false).manualCompactions
      .find((entry) => entry.manualCompactionId === rejectedPending.manualCompactionId)
    assert.equal(rejectedRecovery?.latestAttempt?.responseKind, 'rejected')
    assert.equal(await manualController.reconcileRecovery(rejectedRecovery!), 'settled')
    assert.deepEqual(db.prepare(`
      SELECT abandoned_reason, unknown_at FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
    `).get(rejectedPending.manualCompactionId), { abandoned_reason: 'dispatch_rejected', unknown_at: null })
    assert.equal(fenceCount(), 0, 'boot recovery released the fence instead of calling it unknown')
    assert.equal(await snapshotOf(), 'idle_native_thread')

    const upstreamBeforeManual = upstreamBodies.length
    const compacted = await lifecycleAdapter.compactSession(mainIdentity)
    assert.equal(compacted.ok, true, JSON.stringify(compacted))
    if (!compacted.ok || compacted.action !== 'manual_compact') throw new Error('manual_compaction_failed')
    assert.equal(fenceCount(), 0)
    assert.equal(upstreamBodies.length, upstreamBeforeManual + 1, 'the compaction request crossed the Ready gateway')
    const compactedRead = await client.threadRead({ threadId: startedThread.thread.id, includeTurns: true })
    assert.deepEqual(compactedRead.thread.turns.find((turn) => turn.id === compacted.codexTurnId)?.items
      .map((item) => item.type), ['contextCompaction'])
    const repeated = await lifecycleAdapter.compactSession(mainIdentity)
    assert.equal(!repeated.ok && repeated.code, 'no_active_operation', 'nothing new since the last compaction')
    await runTurn(reserveAndAdmit('run-after-manual', 'AFTER_MANUAL_COMPACTION', true), 'AFTER_MANUAL_COMPACTION')

    const interrupted = await manualController.begin(mainIdentity)
    await restartRuntime()
    manualController = createManualController()
    const interruptedRecovery = repository.readRecoverySnapshot(() => false).manualCompactions
      .find((entry) => entry.manualCompactionId === interrupted.manualCompactionId)
    assert.equal(interruptedRecovery?.latestAttempt, null, 'the request never left Ready before the restart')
    assert.equal(await manualController.reconcileRecovery(interruptedRecovery!), 'observing')
    await waitUntil(() => db.prepare(`
      SELECT consumed_at FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
    `).get<{ consumed_at: string | null }>(interrupted.manualCompactionId)?.consumed_at || null)
    assert.equal(fenceCount(), 0, 'the redispatch resumed the thread first and completed')

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
