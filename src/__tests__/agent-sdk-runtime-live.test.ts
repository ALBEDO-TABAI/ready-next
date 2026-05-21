import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { AIWireAPI } from '../../shared/ai-providers'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('agent sdk live smoke declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-runtime-live transitive sqlite load')
})

const liveSmokeEnabled =
  process.env.READY_AGENT_SDK_LIVE_SMOKE === '1'
  && typeof process.env.OPENAI_API_KEY === 'string'
  && process.env.OPENAI_API_KEY.trim().length > 0

const liveSkipReason = liveSmokeEnabled
  ? false
  : 'Set READY_AGENT_SDK_LIVE_SMOKE=1 and OPENAI_API_KEY to run the live Agents SDK smoke.'

const compatibleSmokeEnabled =
  process.env.READY_AGENT_SDK_LIVE_SMOKE === '1'
  && typeof process.env.READY_AGENT_SDK_COMPAT_BASE_URL === 'string'
  && process.env.READY_AGENT_SDK_COMPAT_BASE_URL.trim().length > 0
  && typeof process.env.READY_AGENT_SDK_COMPAT_API_KEY === 'string'
  && process.env.READY_AGENT_SDK_COMPAT_API_KEY.trim().length > 0
  && typeof process.env.READY_AGENT_SDK_COMPAT_MODEL === 'string'
  && process.env.READY_AGENT_SDK_COMPAT_MODEL.trim().length > 0

const compatibleSkipReason = compatibleSmokeEnabled
  ? false
  : 'Set READY_AGENT_SDK_LIVE_SMOKE=1 plus READY_AGENT_SDK_COMPAT_BASE_URL/API_KEY/MODEL to run the OpenAI-compatible smoke.'

async function runLiveSmoke(wireApi: AIWireAPI, overrides?: {
  provider?: 'openai' | 'openai-compatible'
  baseUrl?: string
  apiKey?: string
  model?: string
}): Promise<void> {
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      reason: 'present',
      config: {
        provider: overrides?.provider || 'openai',
        baseUrl: overrides?.baseUrl || 'https://api.openai.com/v1',
        apiKey: overrides?.apiKey || process.env.OPENAI_API_KEY || '',
        model: overrides?.model || process.env.READY_AGENT_SDK_SMOKE_MODEL || 'gpt-4.1-mini',
        agentProtocol: 'openai',
        wireApi,
      },
    }),
    listToolDefinitions: () => [],
  })
  const sessionId = `live-${wireApi.replace(/[^a-z]/gi, '-')}`
  const runtimeErrors: string[] = []
  runtime.on('error', (event: { error?: unknown }) => {
    runtimeErrors.push(String(event.error || 'Unknown SDK runtime error'))
  })
  runtime.newSession(`butler::${sessionId}`, '只按用户要求输出，不要添加解释。')

  const result = await runtime.sendMessage(
    `butler::${sessionId}`,
    '请只回复 READY_SDK_SMOKE_OK',
    `run-${sessionId}`,
    {
      publicSessionId: sessionId,
      taskId: `task-${sessionId}`,
    },
  )

  assert.equal(result.success, true, result.error || runtimeErrors.join('\n'))
  assert.match(result.finalText, /READY_SDK_SMOKE_OK/)
}

test('live agent sdk smoke works through OpenAI Responses', {
  skip: liveSkipReason,
  timeout: 60_000,
}, async () => {
  await runLiveSmoke('responses')
})

test('live agent sdk smoke works through OpenAI Chat Completions', {
  skip: liveSkipReason,
  timeout: 60_000,
}, async () => {
  await runLiveSmoke('chat/completions')
})

test('live agent sdk smoke works through OpenAI-compatible Chat Completions', {
  skip: compatibleSkipReason,
  timeout: 60_000,
}, async () => {
  await runLiveSmoke('chat/completions', {
    provider: 'openai-compatible',
    baseUrl: process.env.READY_AGENT_SDK_COMPAT_BASE_URL,
    apiKey: process.env.READY_AGENT_SDK_COMPAT_API_KEY,
    model: process.env.READY_AGENT_SDK_COMPAT_MODEL,
  })
})
