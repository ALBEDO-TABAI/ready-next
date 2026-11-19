import { ProviderOutputIncompleteError, ProviderOutputMissingTextError } from '../runtime-core/provider-output-status'
import { randomUUID } from 'node:crypto'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import { CHATGPT_OAUTH_PROFILE_ID, isChatGptOAuthConfig } from '../../../../shared/chatgpt-oauth'
import { CodexModelGateway, type CodexModelGatewayBinding } from './codex-model-gateway'
import { CODEX_PLATFORM_SANDBOX, createCodexUpstreamProfileSnapshot, digestCanonicalJson, instructionTranscriptDigest } from './codex-model-gateway-contract'

/** A bounded, tool-free provider request through the current gateway; no chat thread or model loop. */
export async function requestCodexProviderText(config: AIModelConfig, options: { system: string; user: string; maxTokens: number; timeoutMs: number; signal?: AbortSignal }): Promise<{ text: string; latencyMs: number }> {
  const started = Date.now()
  const id = `provider-text-${randomUUID()}`
  // ChatGPT OAuth upstream handling is keyed by its fixed profile id; other providers get a private one.
  const profileId = isChatGptOAuthConfig(config) ? CHATGPT_OAUTH_PROFILE_ID : id
  const created = createCodexUpstreamProfileSnapshot({ profileId, config: { ...config, maxOutputTokensOverride: options.maxTokens }, maxRetries: 0 })
  const instructions = options.system
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: options.user }] }]
  const metadata = {
    installation_id: id, session_id: id, thread_id: id, turn_id: id, root_turn_id: id,
    window_id: `${id}:0`, agent_name: '/root', request_kind: 'turn', sandbox: CODEX_PLATFORM_SANDBOX, sandbox_mode: 'read-only',
    auto_review_enabled: false, node_repl_auto_review_required: false, node_repl_disabled: false,
    // The exact product shape of the pinned runtime; the gateway accepts no other.
    turn_started_at_unix_ms: started, window_number: 0, context_window_id: id, analytics_enabled: false,
    model: 'ready-e0-model', readyRunId: id, toolSurfaceDigest: digestCanonicalJson([]),
    turnContractDigest: id, upstreamProfileSnapshotDigest: created.snapshotDigest,
  }
  const request = {
    model: 'ready-e0-model', instructions, input, tools: [], tool_choice: 'none', parallel_tool_calls: false,
    reasoning: { summary: 'auto', ...(created.snapshot.reasoningEffort ? { effort: created.snapshot.reasoningEffort } : {}) }, include: ['reasoning.encrypted_content'], prompt_cache_key: id, store: false, stream: true,
    client_metadata: {
      'x-codex-installation-id': id, session_id: id, thread_id: id, turn_id: id, root_turn_id: id,
      'x-codex-window-id': `${id}:0`, 'x-codex-turn-metadata': JSON.stringify(metadata),
    },
  }
  let completed = false
  let acknowledgedFailure = false
  const gateway = new CodexModelGateway({
    headersDeadlineMs: options.timeoutMs, firstByteDeadlineMs: options.timeoutMs, eventIdleMs: options.timeoutMs,
    authority: {
      async resolve({ metadata: incoming, validate }) {
        if (incoming.threadId !== id || incoming.turnId !== id || incoming.readyRunId !== id) throw new Error('connection_identity_invalid')
        const binding: CodexModelGatewayBinding = {
          kind: 'product', codexModel: request.model, snapshot: created.snapshot, snapshotDigest: created.snapshotDigest,
          toolSurfaceDigest: metadata.toolSurfaceDigest, requestToolsDigest: digestCanonicalJson([]),
          turnContractDigest: id,
          instructionContractDigest: instructionTranscriptDigest(instructions, input),
          additionalContextDigest: digestCanonicalJson([]), deliveredUserTail: [],
          forceToolFreeFinalization: true, allowedToolNames: [],
        }
        validate(binding)
        return binding
      },
      async recordResponseEvidence() { completed = true },
      recordResponseFailureEvidence({ failureEvidence }) {
        acknowledgedFailure = failureEvidence.failureStage === 'post-terminal'
      },
    },
    credentials: { resolve: () => config.apiKey },
  })
  try {
    const address = await gateway.start()
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${address.bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]),
    })
    const body = await response.text()
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try { message = JSON.parse(body).error?.message || message } catch { /* silent-catch: keep the HTTP status for non-JSON error bodies. */ }
      throw new Error(`连接失败 (HTTP ${response.status}): ${message}`)
    }
    const events = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
    const failure = events.find((event) => event.type === 'response.failed' || event.type === 'error')
    if (failure) {
      const code = failure.response?.error?.code || failure.error?.code
      if (acknowledgedFailure || ['gateway_upstream_output_truncated', 'gateway_upstream_output_filtered'].includes(code)) throw new ProviderOutputIncompleteError()
      throw new Error(failure.response?.error?.message || failure.message || '模型请求未完成')
    }
    if (!completed || !events.some((event) => event.type === 'response.completed')) throw new Error('模型请求缺少完整终态')
    const terminal = events.find((event) => event.type === 'response.completed')?.response
    // The Chat adapter publishes validated item completions and omits output in its terminal envelope.
    const output = Array.isArray(terminal.output) ? terminal.output
      : events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)
    const text = output.filter((item: { type?: string; phase?: string }) => item.type === 'message' && item.phase !== 'commentary')
      .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content || [])
      .filter((part: { type?: string; text?: string }) => part.type === 'output_text' && typeof part.text === 'string').map((part: { text: string }) => part.text).join('').trim()
    if (!text) throw new ProviderOutputMissingTextError()
    return { text, latencyMs: Date.now() - started }
  } finally { await gateway.stop() }
}
