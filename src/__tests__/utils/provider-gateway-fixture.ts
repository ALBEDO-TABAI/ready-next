import { createServer } from 'node:http'
import type { AIModelConfig } from '../../shared/ai-providers'
import { CodexModelGateway, type CodexModelGatewayBinding } from '../../main/modules/agent-control/codex-runtime/codex-model-gateway'
import { createCodexUpstreamProfileSnapshot, digestCanonicalJson, instructionTranscriptDigest } from '../../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'

/** Isolated protocol fixture: authority is a substitute; no product DB or user settings. */
export async function providerGatewayFixture(config: Partial<AIModelConfig> = {}) {
  let events: Record<string, unknown>[] = []
  const requests: Array<{ path: string; body: any; headers: Record<string, unknown> }> = []
  const admissions: unknown[] = []
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const port = (upstream.address() as { port: number }).port
  let gateway: CodexModelGateway | undefined
  try {
    const created = createCodexUpstreamProfileSnapshot({ profileId: 'test', maxRetries: 0, config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model',
      apiKey: 'test-secret', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on', ...config,
    } })
    const tools = [{ type: 'function', name: 'read_token', description: 'Read token', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    const request: any = {
      model: 'ready-e0-model', instructions: 'Use the tool.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read token.' }] }],
      tools, tool_choice: 'auto', parallel_tool_calls: false, reasoning: { summary: 'auto', ...(created.snapshot.reasoningEffort ? { effort: created.snapshot.reasoningEffort } : {}) },
      include: ['reasoning.encrypted_content'], prompt_cache_key: 'thread-test', store: false, stream: true,
      client_metadata: {
        'x-codex-installation-id': 'test', session_id: 'thread-test', 'x-codex-window-id': 'thread-test:0',
        thread_id: 'thread-test', turn_id: 'turn-test', root_turn_id: 'turn-test',
        'x-codex-turn-metadata': JSON.stringify({
          installation_id: 'test', session_id: 'thread-test', thread_id: 'thread-test', turn_id: 'turn-test',
          root_turn_id: 'turn-test', window_id: 'thread-test:0', agent_name: '/root', request_kind: 'turn',
          sandbox: 'seatbelt', sandbox_mode: 'read-only', auto_review_enabled: false,
          node_repl_auto_review_required: false, node_repl_disabled: false, turn_started_at_unix_ms: 1,
          readyRunId: 'run-test', toolSurfaceDigest: digestCanonicalJson(tools),
          turnContractDigest: 'contract-test', upstreamProfileSnapshotDigest: created.snapshotDigest,
        }),
      },
    }
    gateway = new CodexModelGateway({ authority: {
      async resolve(input) {
        const binding: CodexModelGatewayBinding = {
          kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
          snapshotDigest: created.snapshotDigest, toolSurfaceDigest: digestCanonicalJson(tools),
          turnContractDigest: 'contract-test', instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
          additionalContextDigest: digestCanonicalJson([]), deliveredUserTail: [],
          forceToolFreeFinalization: false, allowedToolNames: ['read_token'],
        }
        input.validate(binding)
        return binding
      },
      async admitToolResponse(input) { admissions.push(input.calls) },
    }, credentials: { resolve: () => 'test-secret' } })
    const address = await gateway.start()
    return { requests, admissions, request, snapshot: created.snapshot,
      async call(nextEvents: Record<string, unknown>[]) {
        events = nextEvents
        const response = await fetch(`${address.url}/v1/responses`, {
          method: 'POST', headers: { authorization: `Bearer ${address.bearerToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
        })
        return response.text()
      },
      async close() { await gateway!.stop(); await new Promise<void>((resolve) => upstream.close(() => resolve())) },
    }
  } catch (error) {
    await gateway?.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    throw error
  }
}
