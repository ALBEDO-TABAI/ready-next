import { randomUUID } from 'node:crypto'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import { CodexModelGateway, type CodexModelGatewayBinding } from './codex-model-gateway'
import { createCodexUpstreamProfileSnapshot, digestCanonicalJson, instructionTranscriptDigest } from './codex-model-gateway-contract'

/** Private, tool-free diagnostic gateway. No product thread, settings writes, or retries. */
export async function testCodexProviderConnection(config: AIModelConfig): Promise<{ latencyMs: number }> {
  const started = Date.now()
  const id = `connection-${randomUUID()}`
  const created = createCodexUpstreamProfileSnapshot({ profileId: id, config: { ...config, maxOutputTokensOverride: 4096 }, maxRetries: 0 })
  const instructions = 'This is a connection test. Reply OK.'
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }]
  const metadata = {
    installation_id: id, session_id: id, thread_id: id, turn_id: id, root_turn_id: id,
    window_id: `${id}:0`, agent_name: '/root', request_kind: 'turn', sandbox: 'seatbelt', sandbox_mode: 'read-only',
    auto_review_enabled: false, node_repl_auto_review_required: false, node_repl_disabled: false,
    turn_started_at_unix_ms: started, readyRunId: id, toolSurfaceDigest: digestCanonicalJson([]),
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
  const gateway = new CodexModelGateway({
    headersDeadlineMs: 15000, firstByteDeadlineMs: 15000, eventIdleMs: 15000,
    authority: {
      async resolve({ metadata: incoming, validate }) {
        if (incoming.threadId !== id || incoming.turnId !== id || incoming.readyRunId !== id) throw new Error('connection_identity_invalid')
        const binding: CodexModelGatewayBinding = {
          kind: 'product', codexModel: request.model, snapshot: created.snapshot, snapshotDigest: created.snapshotDigest,
          toolSurfaceDigest: metadata.toolSurfaceDigest, turnContractDigest: id,
          instructionContractDigest: instructionTranscriptDigest(instructions, input),
          additionalContextDigest: digestCanonicalJson([]), deliveredUserTail: [],
          forceToolFreeFinalization: true, allowedToolNames: [],
        }
        validate(binding)
        return binding
      },
      async recordResponseEvidence() { completed = true },
    },
    credentials: { resolve: () => config.apiKey },
  })
  try {
    const address = await gateway.start()
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${address.bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(45000),
    })
    const body = await response.text()
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try { message = JSON.parse(body).error?.message || message } catch { /* Keep HTTP status for non-JSON errors. */ }
      throw new Error(`连接失败 (HTTP ${response.status}): ${message}`)
    }
    const events = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
    const failure = events.find((event) => event.type === 'response.failed' || event.type === 'error')
    if (failure || !completed || !events.some((event) => event.type === 'response.output_text.delta' && event.delta?.trim())) {
      throw new Error(`连接失败: ${failure?.response?.error?.message || failure?.message || '模型没有返回完整有效的回复'}`)
    }
    return { latencyMs: Date.now() - started }
  } finally { await gateway.stop() }
}
