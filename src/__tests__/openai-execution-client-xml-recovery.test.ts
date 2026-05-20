import assert from 'node:assert/strict'
import test from 'node:test'

import { OpenAIExecutionClient } from '../main/modules/claude-bridge/openai-execution-client'
import type { AIModelConfig } from '../shared/ai-providers'

// Screenshot-bug ROOT FIX — verifies that a model emitting `<tool_call>` XML
// in the text field under NATIVE function-calling transport gets recovered
// (XML parsed → toolCalls populated) instead of the turn ending with a
// leaked-XML chat bubble. The user reported "直接就停止了这次" — root cause
// was openai-execution-client returning toolCalls=[] when the provider
// passed the model's XML through verbatim.

function createConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'mimo-test',
    ...overrides,
  }
}

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SCREENSHOT_LEAK_TEXT = [
  '好，从头来。先看当前状态和配置，然后清理重跑。<tool_call>',
  '<function=skill_run_shell>',
  '<parameter=command>ls -la /Users/user/Documents/实验田/测试/</parameter>',
  '</function>',
  '</tool_call><tool_call>',
  '<function=skill_run_shell>',
  '<parameter=command>cat /Users/user/Documents/实验田/测试/vnext_config.json 2>/dev/null || echo "No config"</parameter>',
  '</function>',
  '</tool_call>',
].join('\n')

function makeClient(jsonBody: unknown, logs: string[] = []) {
  return new OpenAIExecutionClient({
    fetchWithTimeout: async () => createJsonResponse(jsonBody),
    log: (message) => logs.push(message),
  })
}

const baseSession = {
  messages: [{ role: 'user' as const, content: '再从头重新跑一次看看' }],
  systemPrompt: 'system',
  preferTextToolBridge: false,
}

// ---------------------------------------------------------------------------
// BRANCH A — recovery fires: text has XML markers + provider returned 0 native calls
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG ROOT — XML in text + 0 native calls → recovered as text-bridge response with structured calls', async () => {
  const logs: string[] = []
  const client = makeClient({
    choices: [{
      message: { content: SCREENSHOT_LEAK_TEXT },
      finish_reason: 'stop',
    }],
  }, logs)

  const result = await client.requestWithTools({
    session: baseSession,
    config: createConfig(),
    baseUrl: 'https://example.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
  })

  // Recovery must extract both shell calls.
  assert.equal(result.toolCalls.length, 2, 'both XML calls extracted')
  assert.equal(result.toolCalls[0].name, 'skill_run_shell')
  assert.equal(result.toolCalls[1].name, 'skill_run_shell')
  assert.equal(
    result.toolCalls[0].input?.command,
    'ls -la /Users/user/Documents/实验田/测试/',
    'first call args preserved',
  )
  assert.match(
    String(result.toolCalls[1].input?.command || ''),
    /cat .+vnext_config\.json/,
    'second call args preserved',
  )

  // Visible text must be cleaned of markers — useful prose stays.
  assert.match(result.text, /好，从头来/)
  assert.equal(/<tool_call>|<function=|<parameter=/.test(result.text), false, 'no markers in cleaned text')

  // Transport tagged 'text' so downstream history compression / retry logic
  // treats the recovered calls the same as canonical text-bridge.
  assert.equal(result.toolTransport, 'text')

  // Recovery must surface in the log so an operator can grep it.
  assert.ok(
    logs.some((m) => /xml_recovery/.test(m)),
    'log line emitted on recovery',
  )

  // rawText preserves the original (for transcript / retry semantics).
  assert.equal(result.rawText, SCREENSHOT_LEAK_TEXT)
})

// ---------------------------------------------------------------------------
// BRANCH B — provider returned real native tool_calls → recovery is no-op
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG ROOT — native tool_calls present → recovery is no-op (prefer structured path)', async () => {
  const client = makeClient({
    choices: [{
      message: {
        // Even when text accidentally has markers, presence of native calls
        // means the provider DID translate properly; the markers are just
        // commentary. Don't double-extract.
        content: 'Calling tool... <tool_call>commentary</tool_call>',
        tool_calls: [{
          id: 'call_real',
          function: { name: 'browser_search', arguments: '{"query":"x"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  })

  const result = await client.requestWithTools({
    session: baseSession,
    config: createConfig(),
    baseUrl: 'https://example.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
  })

  // Native call must survive untouched.
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'browser_search')
  assert.equal(result.toolCalls[0].id, 'call_real', 'native id preserved')
  // Transport stays native (don't downgrade a working channel).
  assert.equal(result.toolTransport, 'native')
  // Text is unchanged — the (irrelevant) markers in the commentary survive.
  // TurnTranscript's `sanitizeAssistantText` strip handles renderer-side
  // cosmetics on the way out; we don't double-clean here.
  assert.match(result.text, /Calling tool/)
})

// ---------------------------------------------------------------------------
// BRANCH C — XML present but parser extracts 0 calls → recovery is no-op
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG ROOT — malformed XML (parser extracts 0) → recovery is no-op, TurnTranscript handles cosmetic strip', async () => {
  // Markers present but no extractable function= / parameter= shape.
  // Recovery would yield 0 calls; the response should pass through so the
  // turn ends naturally and the renderer-side strip handles cleanup.
  const malformed = 'I think I should call <tool_call>but I forgot the function name</tool_call>'
  const client = makeClient({
    choices: [{
      message: { content: malformed },
      finish_reason: 'stop',
    }],
  })

  const result = await client.requestWithTools({
    session: baseSession,
    config: createConfig(),
    baseUrl: 'https://example.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
  })

  assert.equal(result.toolCalls.length, 0, 'no extractable calls')
  // Transport unchanged.
  assert.equal(result.toolTransport, 'native')
  // Text passes through; TurnTranscript will strip on emit.
  assert.equal(result.text, malformed)
})

// ---------------------------------------------------------------------------
// BRANCH D — text has no markers → fast-path no-op (no allocation)
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG ROOT — clean text + 0 native calls → no-op (fast path, no recovery)', async () => {
  const cleanText = '我已经检查完毕，结果如下：\n- 步骤 1\n- 步骤 2'
  const client = makeClient({
    choices: [{
      message: { content: cleanText },
      finish_reason: 'stop',
    }],
  })

  const result = await client.requestWithTools({
    session: baseSession,
    config: createConfig(),
    baseUrl: 'https://example.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
  })

  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.toolTransport, 'native')
  assert.equal(result.text, cleanText, 'text identity (no allocation)')
})

// ---------------------------------------------------------------------------
// METRIC REGISTRATION
// ---------------------------------------------------------------------------

test('SCREENSHOT BUG ROOT — xml_tool_calls_recovered_from_native is registered in TOOL_ERROR_METRICS', async () => {
  const { TOOL_ERROR_METRICS } = await import('../main/modules/agent-control/tools-runtime/tool-error-metrics')
  assert.equal(
    TOOL_ERROR_METRICS.xmlToolCallsRecoveredFromNative,
    'xml_tool_calls_recovered_from_native',
  )
})
