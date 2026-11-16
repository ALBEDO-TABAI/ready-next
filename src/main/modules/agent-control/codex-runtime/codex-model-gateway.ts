/** HTTP lifecycle and the single per-request forwarding pipeline. Protocol and persistence policy live behind explicit ports. */
import { isZaiResponsesConfig, zaiReasoningEffort } from '../../../../shared/ai-providers/zai'
import { redactPriorReadyMemoryHistory } from './codex-memory-history-redaction'
import { responsesRequestToChat } from './codex-model-gateway-chat'
import { streamChatAsResponses } from './codex-model-gateway-chat-stream'
import { CodexModelGatewayError, isRecord, type JsonObject } from './codex-model-gateway-common'
import {
  type CodexModelGatewayFailureEvidence,
  type CodexModelGatewayResponseEvidence,
  currentTurnReadyAdditionalContext,
  digestCanonicalJson,
  upstreamEndpoint,
} from './codex-model-gateway-contract'
import { parseAuthorization, readBoundedResponseText, readJsonBody, sendError } from './codex-model-gateway-http'
import { messagesAsResponses, messagesHeaders, responsesRequestToMessages } from './codex-model-gateway-messages'
import { streamNativeResponses } from './codex-model-gateway-native-stream'
import {
  DEFAULT_BODY_DEADLINE_MS,
  DEFAULT_FIRST_BYTE_DEADLINE_MS,
  DEFAULT_HEADERS_DEADLINE_MS,
  DEFAULT_NATIVE_MAX_BYTES,
  DEFAULT_NATIVE_MAX_EVENTS,
  DEFAULT_NATIVE_MAX_ITEM_BYTES,
  isChatGptOAuthResponsesSnapshot,
  isCodexUpstreamEventStream,
  resolveCodexGatewayEventIdleMs,
} from './codex-model-gateway-policy'
import {
  gatewayFailureClass,
  gatewayFailureEvidence,
  safeProviderHeader,
  sanitizedProviderError,
} from './codex-model-gateway-provider-errors'
import {
  buildValidatedRequestCapture,
  codexSessionAffinityHeaders,
  codexTurnStateHeader,
  durableRequestEvidence,
  expectedKind,
  parseMetadata,
  validateBinding,
  validateRequestShape,
} from './codex-model-gateway-request'
import {
  CodexModelGatewayRetryError,
  fetchCodexUpstreamWithRetry,
  prepareCodexUpstreamStreamForControlledRetry,
  waitForControlledGatewayRetry,
} from './codex-model-gateway-retry'
import type {
  CodexModelGatewayAddress,
  CodexModelGatewayAuthority,
  CodexModelGatewayBinding,
  CodexModelGatewayCredentialStore,
  CodexModelGatewayMetadata,
  CodexModelGatewayOriginalRequestCapture,
  CodexModelGatewayPreparedRequestReceipt,
  CodexModelGatewaySpawnCapability,
  CodexModelGatewayToolResponseCall,
  CodexModelGatewayUpstreamFailureDiagnostic,
  CodexModelGatewayValidatedRequestCapture,
} from './codex-model-gateway-types'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

type ActiveGatewayCapability = {
  bearerToken: string
  sidecarSpawnInstanceId: string
}

export class CodexModelGateway {
  private readonly bootstrapBearerToken: string
  private readonly maxBodyBytes: number
  private readonly maxConcurrentRequests: number
  private readonly bodyDeadlineMs: number
  private readonly nativeMaxBytes: number
  private readonly nativeMaxEvents: number
  private readonly nativeMaxItemBytes: number
  private readonly headersDeadlineMs: number
  private readonly firstByteDeadlineMs: number
  private readonly eventIdleMsOverride: number | undefined
  private activeCapability: ActiveGatewayCapability | null
  private server: Server | null = null
  private port: number | null = null
  private startPromise: Promise<CodexModelGatewayAddress> | null = null
  private activeRequests = 0
  private readonly activeAbortControllers = new Set<AbortController>()
  private lifecycle: 'new' | 'starting' | 'running' | 'stopped' = 'new'

  constructor(private readonly deps: {
    bearerToken?: string
    spawnBound?: boolean
    maxBodyBytes?: number
    maxConcurrentRequests?: number
    bodyDeadlineMs?: number
    nativeMaxBytes?: number
    nativeMaxEvents?: number
    nativeMaxItemBytes?: number
    headersDeadlineMs?: number
    firstByteDeadlineMs?: number
    eventIdleMs?: number
    downstreamKeepaliveMs?: number
    onUpstreamAttempt?: (attempt: number) => void
    onUpstreamFailure?: (diagnostic: CodexModelGatewayUpstreamFailureDiagnostic) => void
    /** A request Ready's own checks refused. Without it a refusal leaves no trace outside the turn's database row. */
    onRequestRefused?: (refusal: { code: string; status: number }) => void
    proofSentinel?: string
    proofSentinels?: readonly string[]
    onValidatedRequest?: (capture: CodexModelGatewayValidatedRequestCapture) => void | Promise<void>
    authority: CodexModelGatewayAuthority
    credentials: CodexModelGatewayCredentialStore
  }) {
    this.bootstrapBearerToken = deps.bearerToken || randomBytes(32).toString('base64url')
    this.activeCapability = deps.spawnBound
      ? null
      : { bearerToken: this.bootstrapBearerToken, sidecarSpawnInstanceId: 'standalone' }
    this.maxBodyBytes = deps.maxBodyBytes || 4_194_304
    this.maxConcurrentRequests = deps.maxConcurrentRequests || 8
    this.bodyDeadlineMs = deps.bodyDeadlineMs || DEFAULT_BODY_DEADLINE_MS
    this.nativeMaxBytes = deps.nativeMaxBytes || DEFAULT_NATIVE_MAX_BYTES
    this.nativeMaxEvents = deps.nativeMaxEvents || DEFAULT_NATIVE_MAX_EVENTS
    this.nativeMaxItemBytes = deps.nativeMaxItemBytes || DEFAULT_NATIVE_MAX_ITEM_BYTES
    this.headersDeadlineMs = deps.headersDeadlineMs || DEFAULT_HEADERS_DEADLINE_MS
    this.firstByteDeadlineMs = deps.firstByteDeadlineMs || DEFAULT_FIRST_BYTE_DEADLINE_MS
    this.eventIdleMsOverride = deps.eventIdleMs
    if (
      !this.bootstrapBearerToken
      || this.maxBodyBytes <= 0
      || this.maxConcurrentRequests <= 0
      || this.bodyDeadlineMs <= 0
      || this.nativeMaxBytes <= 0
      || this.nativeMaxEvents <= 0
      || this.nativeMaxItemBytes <= 0
      || this.headersDeadlineMs <= 0
      || this.firstByteDeadlineMs <= 0
      || (this.eventIdleMsOverride !== undefined
        && (!Number.isSafeInteger(this.eventIdleMsOverride) || this.eventIdleMsOverride <= 0))
      || (deps.downstreamKeepaliveMs !== undefined
        && (!Number.isSafeInteger(deps.downstreamKeepaliveMs) || deps.downstreamKeepaliveMs <= 0))
    ) {
      throw new CodexModelGatewayError('gateway_configuration_invalid')
    }
  }

  async start(): Promise<CodexModelGatewayAddress> {
    if (this.lifecycle !== 'new') throw new CodexModelGatewayError('gateway_already_started')
    this.lifecycle = 'starting'
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    const starting = new Promise<CodexModelGatewayAddress>((resolve, reject) => {
      server.once('error', (error) => {
        if (this.lifecycle === 'starting') this.lifecycle = 'stopped'
        if (this.server === server) this.server = null
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        if (this.lifecycle !== 'starting') {
          server.closeAllConnections()
          server.close(() => {
            if (this.server === server) this.server = null
            reject(new CodexModelGatewayError('gateway_stopped', 503))
          })
          return
        }
        const address = server.address()
        if (!address || typeof address === 'string') {
          this.lifecycle = 'stopped'
          reject(new Error('gateway_address_invalid'))
          return
        }
        this.port = address.port
        this.lifecycle = 'running'
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          bearerToken: this.bootstrapBearerToken,
        })
      })
    })
    this.startPromise = starting
    try {
      return await starting
    } finally {
      if (this.startPromise === starting) this.startPromise = null
    }
  }

  activateSpawn(sidecarSpawnInstanceId: string): CodexModelGatewaySpawnCapability {
    if (this.lifecycle !== 'running' || !this.port) {
      throw new CodexModelGatewayError('gateway_not_started', 503)
    }
    if (!sidecarSpawnInstanceId.trim() || /[\r\n\0]/.test(sidecarSpawnInstanceId)) {
      throw new CodexModelGatewayError('gateway_spawn_identity_invalid')
    }
    for (const controller of this.activeAbortControllers) controller.abort()
    const capability = {
      bearerToken: randomBytes(32).toString('base64url'),
      sidecarSpawnInstanceId,
    }
    this.activeCapability = capability
    return {
      url: `http://127.0.0.1:${this.port}`,
      ...capability,
    }
  }

  revokeSpawn(sidecarSpawnInstanceId: string): void {
    if (this.activeCapability?.sidecarSpawnInstanceId !== sidecarSpawnInstanceId) return
    this.activeCapability = null
    for (const controller of this.activeAbortControllers) controller.abort()
  }

  async stop(): Promise<void> {
    const starting = this.startPromise
    this.lifecycle = 'stopped'
    this.activeCapability = null
    for (const controller of this.activeAbortControllers) controller.abort()
    if (starting) await starting.catch(() => undefined)
    const server = this.server
    this.server = null
    this.port = null
    if (!server || !server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let admitted = false
    try {
      if (this.lifecycle !== 'running' || !this.port) {
        throw new CodexModelGatewayError('gateway_not_started', 503)
      }
      if (request.socket.remoteAddress !== '127.0.0.1') {
        throw new CodexModelGatewayError('gateway_remote_not_loopback', 403)
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        throw new CodexModelGatewayError('gateway_route_invalid', 404)
      }
      if (request.headers.host !== `127.0.0.1:${this.port}`) {
        throw new CodexModelGatewayError('gateway_host_invalid')
      }
      const capability = this.activeCapability
      if (!capability) throw new CodexModelGatewayError('gateway_spawn_capability_inactive', 401)
      parseAuthorization(request, capability.bearerToken)
      if (
        String(request.headers['content-type'] || '').toLowerCase().split(';', 1)[0].trim()
        !== 'application/json'
      ) {
        throw new CodexModelGatewayError('gateway_content_type_invalid', 415)
      }
      if (this.activeRequests >= this.maxConcurrentRequests) {
        throw new CodexModelGatewayError('gateway_concurrency_exceeded', 429)
      }
      this.activeRequests += 1
      admitted = true
      await this.forward(request, response, capability)
    } catch (error) {
      const refusal = error instanceof CodexModelGatewayError ? error : null
      if (!refusal || refusal.responseError.type === 'gateway_error') {
        try {
          this.deps.onRequestRefused?.({
            code: refusal?.code ?? 'gateway_request_unbound',
            status: refusal?.status ?? 409,
          })
        } catch {
          // silent-catch: diagnostics never change the request outcome; a throwing onRequestRefused observer is ignored
        }
      }
      sendError(response, error)
    } finally {
      if (admitted) this.activeRequests -= 1
    }
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    capability: ActiveGatewayCapability,
  ): Promise<void> {
    const assertActiveCapability = (): void => {
      if (this.lifecycle !== 'running' || this.activeCapability !== capability) {
        throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
      }
    }
    const abortController = new AbortController()
    let completed = false
    const forwardStartedAtMs = Date.now()
    let admittedFailureContext: {
      metadata: CodexModelGatewayMetadata
      requestDigest: string
    } | null = null
    let admittedFailureRecorded = false
    let admittedFailureStage: CodexModelGatewayFailureEvidence['failureStage'] = 'connect'
    let failureTarget: { profileId: string; model: string } | null = null
    let retriesUsed = 0
    const reportUpstreamFailure = (
      metadata: CodexModelGatewayMetadata,
      failure: Omit<CodexModelGatewayUpstreamFailureDiagnostic,
        'readyRunId' | 'codexThreadId' | 'codexTurnId' | 'profileId' | 'model' | 'retriesUsed'>,
    ): void => {
      if (!failureTarget || !this.deps.onUpstreamFailure) return
      try {
        this.deps.onUpstreamFailure({
          readyRunId: metadata.readyRunId,
          codexThreadId: metadata.threadId,
          codexTurnId: metadata.turnId,
          ...failureTarget,
          retriesUsed,
          ...failure,
        })
      } catch {
        // silent-catch: diagnostics never change the request outcome; a throwing onUpstreamFailure observer is ignored
      }
    }
    const abortForRequest = () => abortController.abort()
    const abortForResponse = () => { if (!completed) abortController.abort() }
    request.once('aborted', abortForRequest)
    response.once('close', abortForResponse)
    this.activeAbortControllers.add(abortController)
    try {
      assertActiveCapability()
      const body = await readJsonBody(
        request,
        this.maxBodyBytes,
        abortController.signal,
        this.bodyDeadlineMs,
      )
      assertActiveCapability()
      const toolArgumentValidators = validateRequestShape(body)
      const metadata = parseMetadata(body)
      const sidecarRequestDigest = digestCanonicalJson(body)
      const receivedAt = new Date().toISOString()
      const sidecarRequestCapture = buildValidatedRequestCapture({
        body,
        metadata,
        requestDigest: sidecarRequestDigest,
        proofSentinel: this.deps.proofSentinel,
        proofSentinels: this.deps.proofSentinels,
      })
      const validation: {
        binding: CodexModelGatewayBinding | null
        allowedTools: ReadonlySet<string> | null
        currentTurnContext: ReturnType<typeof currentTurnReadyAdditionalContext> | null
      } = { binding: null, allowedTools: null, currentTurnContext: null }
      type PreparedRequest = {
        body: JsonObject
        capture: CodexModelGatewayOriginalRequestCapture
        redaction: ReturnType<typeof redactPriorReadyMemoryHistory>
        receipt: CodexModelGatewayPreparedRequestReceipt
      }
      let preparedRequest: PreparedRequest | null = null
      const prepareRequestReceipt = (): CodexModelGatewayPreparedRequestReceipt => {
        if (preparedRequest) return preparedRequest.receipt
        if (!validation.binding || !validation.allowedTools) {
          throw new CodexModelGatewayError('gateway_request_prepared_before_validation', 409)
        }
        const redaction = redactPriorReadyMemoryHistory({
          requestKind: expectedKind(metadata),
          input: body.input as unknown[],
          currentTurnContext: validation.currentTurnContext,
        })
        const redactedBody = { ...body, input: redaction.input }
        const requestDigest = digestCanonicalJson(redactedBody)
        const capture = buildValidatedRequestCapture({
          body: redactedBody,
          metadata,
          requestDigest,
          proofSentinel: this.deps.proofSentinel,
          proofSentinels: this.deps.proofSentinels,
        })
        const receipt = {
          requestDigest,
          requestEvidence: durableRequestEvidence(capture, redaction.evidence),
        }
        preparedRequest = { body: redactedBody, capture, redaction, receipt }
        return receipt
      }
      const binding = await this.deps.authority.resolve({
        metadata,
        receivedAt,
        validate: (candidate) => {
          if (validation.binding) throw new CodexModelGatewayError('gateway_binding_validated_twice', 409)
          const result = validateBinding({ body, metadata, binding: candidate })
          validation.binding = candidate
          validation.allowedTools = result.allowedTools
          validation.currentTurnContext = result.currentTurnContext
          return validation.allowedTools
        },
        prepareRequestReceipt,
      })
      if (
        this.lifecycle !== 'running'
        || this.activeCapability !== capability
        || abortController.signal.aborted
      ) {
        throw new CodexModelGatewayError('gateway_stopped', 503)
      }
      if (validation.binding !== binding || !validation.allowedTools) {
        throw new CodexModelGatewayError('gateway_binding_not_validated', 409)
      }
      const preparedReceipt = prepareRequestReceipt()
      const sealedRequest = preparedRequest as PreparedRequest | null
      if (!sealedRequest) throw new CodexModelGatewayError('gateway_request_not_prepared', 409)
      const requestDigest = preparedReceipt.requestDigest
      admittedFailureContext = { metadata, requestDigest }
      failureTarget = { profileId: binding.snapshot.profileId, model: binding.snapshot.model }
      const allowedTools = binding.forceToolFreeFinalization
        ? new Set<string>()
        : validation.allowedTools
      const authorizedProviderTools = binding.forceToolFreeFinalization
        ? []
        : (body.tools as JsonObject[]).filter((tool) => (
            typeof tool.name === 'string' && allowedTools.has(tool.name)
          ))
      const providerRequestBody = {
        ...sealedRequest.body,
        tools: authorizedProviderTools,
        ...(authorizedProviderTools.length === 0
          ? { tool_choice: 'none', parallel_tool_calls: false }
          : {}),
      }
      await this.deps.onValidatedRequest?.({
        ...sealedRequest.capture,
        sidecarRequestDigest,
        sidecarInputDigest: sidecarRequestCapture.inputDigest,
        providerInputDigest: sealedRequest.redaction.evidence.providerInputDigest,
        memoryHistoryRedactionDigest: sealedRequest.redaction.evidence.redactionDigest,
        memoryHistoryRedactedItemCount: sealedRequest.redaction.evidence.redactedItemCount,
      })
      const parallelToolCallsAllowed = providerRequestBody.parallel_tool_calls === true
      const admitToolResponse = async (
        calls: readonly CodexModelGatewayToolResponseCall[],
      ): Promise<void> => {
        if (binding.forceToolFreeFinalization) {
          throw new CodexModelGatewayError('gateway_finalization_tool_response_forbidden', 409)
        }
        if (!parallelToolCallsAllowed && calls.length > 1) {
          throw new CodexModelGatewayError('gateway_parallel_tool_calls_forbidden', 409)
        }
        if (!this.deps.authority.admitToolResponse) {
          throw new CodexModelGatewayError('gateway_tool_response_admission_unavailable', 409)
        }
        await this.deps.authority.admitToolResponse({
          metadata,
          requestDigest,
          calls,
          admittedAt: new Date().toISOString(),
        })
      }
      const credential = await this.deps.credentials.resolve({
        credentialReferenceId: binding.snapshot.credentialReferenceId,
        snapshot: binding.snapshot,
      })
      const recordCompleted = async (
        responseEvidence: CodexModelGatewayResponseEvidence,
      ): Promise<void> => {
        if (!this.deps.authority.recordResponseEvidence) return
        await this.deps.authority.recordResponseEvidence({
          metadata,
          requestDigest,
          responseEvidence,
          completedAt: new Date().toISOString(),
        })
      }
      const recordFailed = (failureEvidence: CodexModelGatewayFailureEvidence): void => {
        this.deps.authority.recordResponseFailureEvidence?.({
          metadata,
          requestDigest,
          failureEvidence,
          failedAt: new Date().toISOString(),
        })
        admittedFailureRecorded = true
        reportUpstreamFailure(metadata, {
          causeCode: failureEvidence.causeCode,
          failureStage: failureEvidence.failureStage,
          elapsedMs: failureEvidence.elapsedMs,
          upstreamRequestId: upstreamRequestId,
          providerError: null,
        })
      }
      if (
        this.lifecycle !== 'running'
        || this.activeCapability !== capability
        || abortController.signal.aborted
      ) {
        throw new CodexModelGatewayError('gateway_stopped', 503)
      }
      if (typeof credential !== 'string' || !credential) {
        throw new CodexModelGatewayError('gateway_credential_unavailable', 503)
      }
      const upstreamBody = binding.snapshot.agentProtocol === 'anthropic'
        ? responsesRequestToMessages(providerRequestBody, binding.snapshot)
        : binding.snapshot.wireApi === 'chat/completions'
        ? responsesRequestToChat({
            request: providerRequestBody,
            snapshot: binding.snapshot,
          })
        : {
            ...providerRequestBody,
            ...upstreamClientMetadata(providerRequestBody, isChatGptOAuthResponsesSnapshot(binding.snapshot)),
            model: binding.snapshot.model,
            ...(binding.snapshot.maxOutputTokens
              ? { max_output_tokens: binding.snapshot.maxOutputTokens }
              : {}),
            reasoning: {
              summary: 'auto',
              ...(binding.snapshot.reasoningEffort ? { effort: isZaiResponsesConfig({ ...binding.snapshot, wireApi: 'responses' })
                ? zaiReasoningEffort(binding.snapshot.reasoningEffort) : binding.snapshot.reasoningEffort } : {}),
            },
          }
      let upstreamResponse: Response
      let upstreamResponseBody: ReadableStream<Uint8Array> | null = null
      let upstreamRequestId: string | null = null
      const codexRouting = binding.snapshot.agentProtocol !== 'anthropic' && binding.snapshot.wireApi === 'responses'
      const turnState = codexRouting ? codexTurnStateHeader(request.headers['x-codex-turn-state']) : null
      const sessionAffinityHeaders = codexRouting
        ? { ...codexSessionAffinityHeaders(body), ...(turnState ? { 'x-codex-turn-state': turnState } : {}) }
        : {}
      while (true) {
        let fetched: Awaited<ReturnType<typeof fetchCodexUpstreamWithRetry>>
        try {
          fetched = await fetchCodexUpstreamWithRetry({
            url: upstreamEndpoint(binding.snapshot),
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              ...sessionAffinityHeaders,
              ...(binding.snapshot.agentProtocol === 'anthropic' ? messagesHeaders(binding.snapshot) : binding.snapshot.extraHeaders),
              [binding.snapshot.authHeader]: `${binding.snapshot.authPrefix}${credential}`,
            },
            body: upstreamBody,
            maxRetries: binding.snapshot.retryPolicy.maxRetries - retriesUsed,
            attemptOffset: retriesUsed,
            signal: abortController.signal,
            headersDeadlineMs: this.headersDeadlineMs,
            onAttempt: this.deps.onUpstreamAttempt,
          })
        } catch (error) {
          if (error instanceof CodexModelGatewayRetryError) {
            throw new CodexModelGatewayError(error.code, error.status)
          }
          throw error
        }
        upstreamResponse = fetched.response
        admittedFailureStage = 'headers'
        retriesUsed += fetched.retriesUsed
        if (!upstreamResponse.ok) break
        if (!isCodexUpstreamEventStream(upstreamResponse, binding.snapshot)) {
          break
        }
        if (!upstreamResponse.body) break
        try {
          upstreamResponseBody = await prepareCodexUpstreamStreamForControlledRetry({
            body: upstreamResponse.body,
            wireApi: binding.snapshot.wireApi,
            snapshot: binding.snapshot,
            credential,
            signal: abortController.signal,
            deadlineMs: this.firstByteDeadlineMs,
          })
          break
        } catch (error) {
          if (!(error instanceof CodexModelGatewayRetryError)) throw error
          if (!error.retryableBeforeOutput) {
            throw new CodexModelGatewayError(error.code, error.status)
          }
          if (retriesUsed >= binding.snapshot.retryPolicy.maxRetries) {
            throw new CodexModelGatewayError('gateway_upstream_retry_exhausted', 502)
          }
          retriesUsed += 1
          try {
            await waitForControlledGatewayRetry({
              retryOrdinal: retriesUsed,
              response: upstreamResponse,
              signal: abortController.signal,
            })
          } catch (waitError) {
            if (waitError instanceof CodexModelGatewayRetryError) {
              throw new CodexModelGatewayError(waitError.code, waitError.status)
            }
            throw waitError
          }
        }
      }
      assertActiveCapability()
      if (abortController.signal.aborted) {
        throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
      }
      if (!upstreamResponse.ok) {
        const requestId = safeProviderHeader(
          upstreamResponse.headers.get('x-request-id') || upstreamResponse.headers.get('request-id')
            || upstreamResponse.headers.get('x-oai-request-id'),
          credential,
          'request_id',
        )
        const retryAfter = safeProviderHeader(
          upstreamResponse.headers.get('retry-after'),
          credential,
          'retry_after',
        )
        const providerError = sanitizedProviderError(
          await readBoundedResponseText({
            response: upstreamResponse,
            signal: abortController.signal,
            deadlineMs: this.firstByteDeadlineMs,
          }),
          credential,
        )
        throw new CodexModelGatewayError(
          `gateway_upstream_http_${upstreamResponse.status}`,
          upstreamResponse.status,
          {
            ...(requestId ? { 'x-ready-upstream-request-id': requestId } : {}),
            ...(retryAfter ? { 'retry-after': retryAfter } : {}),
          },
          providerError || undefined,
        )
      }
      if (!isCodexUpstreamEventStream(upstreamResponse, binding.snapshot)) {
        await upstreamResponse.body?.cancel()
        throw new CodexModelGatewayError('gateway_upstream_not_sse', 502)
      }
      if (!upstreamResponseBody) throw new CodexModelGatewayError('gateway_upstream_body_missing', 502)
      upstreamRequestId = safeProviderHeader(
        upstreamResponse.headers.get('x-request-id') || upstreamResponse.headers.get('request-id')
          || upstreamResponse.headers.get('x-oai-request-id'),
        credential,
        'request_id',
      )
      const upstreamTurnState = codexRouting ? codexTurnStateHeader(upstreamResponse.headers.get('x-codex-turn-state')) : null
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...(upstreamRequestId ? { 'x-ready-upstream-request-id': upstreamRequestId } : {}),
        ...(upstreamTurnState ? { 'x-codex-turn-state': upstreamTurnState } : {}),
      })
      const eventIdleMs = resolveCodexGatewayEventIdleMs({
        snapshot: binding.snapshot,
        overrideMs: this.eventIdleMsOverride,
      })
      admittedFailureStage = 'stream-before-item'
      if (binding.snapshot.wireApi === 'chat/completions') {
        await streamChatAsResponses({
          body: upstreamResponseBody,
          write: (chunk) => response.write(chunk),
          allowedToolNames: allowedTools,
          toolArgumentValidators,
          snapshot: binding.snapshot,
          credential,
          abort: () => abortController.abort(),
          maxBytes: this.nativeMaxBytes,
          maxEvents: this.nativeMaxEvents,
          maxItemBytes: this.nativeMaxItemBytes,
          eventIdleMs,
          keepaliveMs: this.deps.downstreamKeepaliveMs,
          admitToolResponse,
          recordCompleted,
          recordFailed: (observation) => recordFailed({
            failureClass: gatewayFailureClass(observation.code),
            failureStage: observation.stage,
            responseIdentitySeen: observation.responseIdentitySeen,
            partialAssistantItemSeen: observation.partialAssistantItemSeen,
            toolCallItemSeen: observation.toolCallItemSeen,
            elapsedMs: observation.elapsedMs,
            eventCount: observation.eventCount,
            wireByteCount: observation.wireByteCount,
            causeCode: observation.code,
          }),
        })
      } else {
        await streamNativeResponses({
          body: binding.snapshot.agentProtocol === 'anthropic'
            ? messagesAsResponses(upstreamResponseBody, binding.snapshot.model, { maxBytes: this.nativeMaxBytes, maxEvents: this.nativeMaxEvents, maxItemBytes: this.nativeMaxItemBytes })
            : upstreamResponseBody,
          response,
          allowedTools,
          toolArgumentValidators,
          expectedModel: binding.snapshot.model,
          normalizeChatGptOAuth: isChatGptOAuthResponsesSnapshot(binding.snapshot),
          normalizeZai: binding.snapshot.wireApi === 'responses' && isZaiResponsesConfig({ ...binding.snapshot, wireApi: 'responses' }),
          normalizeResponsesApi: binding.snapshot.agentProtocol !== 'anthropic' && binding.snapshot.wireApi === 'responses',
          inferMessagePhase: binding.snapshot.agentProtocol === 'anthropic' || (binding.snapshot.wireApi === 'responses' && isZaiResponsesConfig({ ...binding.snapshot, wireApi: 'responses' })),
          credential,
          abort: () => abortController.abort(),
          maxBytes: this.nativeMaxBytes,
          maxEvents: this.nativeMaxEvents,
          maxItemBytes: this.nativeMaxItemBytes,
          eventIdleMs,
          keepaliveMs: this.deps.downstreamKeepaliveMs,
          admitToolResponse,
          recordCompleted,
          recordFailed,
        })
      }
      completed = true
      response.end()
    } catch (error) {
      if (admittedFailureContext && !admittedFailureRecorded) {
        const code = error instanceof CodexModelGatewayError
          ? error.code
          : 'gateway_request_forward_failed'
        const failureEvidence = gatewayFailureEvidence({
          code,
          stage: admittedFailureStage,
          responseIdentitySeen: false,
          partialAssistantItemSeen: false,
          toolCallItemSeen: false,
          startedAtMs: forwardStartedAtMs,
          eventCount: 0,
          wireByteCount: 0,
        })
        this.deps.authority.recordResponseFailureEvidence?.({
          ...admittedFailureContext,
          failureEvidence,
          failedAt: new Date().toISOString(),
        })
        const providerError = error instanceof CodexModelGatewayError
          && error.responseError.type !== 'gateway_error' ? error.responseError : null
        reportUpstreamFailure(admittedFailureContext.metadata, {
          causeCode: failureEvidence.causeCode,
          failureStage: failureEvidence.failureStage,
          elapsedMs: failureEvidence.elapsedMs,
          upstreamRequestId: error instanceof CodexModelGatewayError
            ? error.responseHeaders['x-ready-upstream-request-id'] ?? null : null,
          providerError,
        })
      }
      throw error
    } finally {
      this.activeAbortControllers.delete(abortController)
      request.off('aborted', abortForRequest)
      response.off('close', abortForResponse)
    }
  }
}

/**
 * `client_metadata` is the Codex client's own field for the ChatGPT Codex backend. That backend gets it without
 * the keys Ready adds for its own checks (run id and contract digests); every other Responses provider gets none
 * of it — it is not part of the public API and carries the installation and thread ids.
 */
export function upstreamClientMetadata(body: JsonObject, codexBackend: boolean): { client_metadata: JsonObject | undefined } {
  if (!codexBackend || !isRecord(body.client_metadata)) return { client_metadata: undefined }
  const outer = { ...body.client_metadata }
  const raw = outer['x-codex-turn-metadata']
  if (typeof raw === 'string') {
    const inner = JSON.parse(raw) as JsonObject
    for (const key of ['readyRunId', 'toolSurfaceDigest', 'turnContractDigest', 'upstreamProfileSnapshotDigest']) {
      delete inner[key]
    }
    outer['x-codex-turn-metadata'] = JSON.stringify(inner)
  }
  return { client_metadata: outer }
}

export type {
  CodexModelGatewayBinding,
  CodexModelGatewayMetadata,
  CodexModelGatewayToolResponseCall,
  CodexModelGatewayPreparedRequestReceipt,
  CodexModelGatewayAuthority,
  CodexModelGatewayCredentialStore,
  CodexModelGatewayAddress,
  CodexModelGatewaySpawnCapability,
  CodexModelGatewayValidatedRequestCapture,
} from './codex-model-gateway-types'
export { CodexModelGatewayError } from './codex-model-gateway-common'
export { isCodexUpstreamEventStream, resolveCodexGatewayEventIdleMs } from './codex-model-gateway-policy'
export { normalizeChatGptOAuthResponseEvent } from './codex-model-gateway-oauth'
export type { CodexModelGatewayRequestKind } from './codex-model-gateway-contract'
