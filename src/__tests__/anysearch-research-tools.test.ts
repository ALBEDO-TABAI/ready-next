import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import { WEB_RESEARCH_ERROR_KINDS } from '../main/modules/agent-control/contracts/error-kinds'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import {
  resolveAgentSdkTaskBudgetRuntime,
} from '../main/modules/agent-control/runtime-core/agent-sdk-foundation-utils'
import {
  captureResearchSearchDelivery,
  ensureResearchSearchResultDelivered,
  recoverResearchSearchDeliveryAfterTimeout,
} from '../main/modules/agent-control/runtime-core/research-result-delivery'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { getToolResourceTag } from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import {
  collectResponseDigestProof,
  collectToolOutputProofs,
} from '../main/modules/agent-control/quality/proof-collector'
import { adjudicateTerminalOutcome } from '../main/modules/agent-control/quality/task-adjudicator'
import { resolveCriteria } from '../main/modules/agent-control/quality/criteria-templates'
import { __setSkillsRuntimeManagerForTests } from '../main/modules/skills-runtime/runtime-manager'
import { executeAnySearchDomainLookup } from '../main/modules/tools/builtins/anysearch-domains'
import { executeWebFetch } from '../main/modules/tools/builtins/web-fetch'
import { executeWebSearch, webSearchSchema } from '../main/modules/tools/builtins/web-search'
import { GENERAL_RESEARCH_TOOL_NAMES } from '../main/modules/tools/general-research-tool-defs'
import { GENERAL_RESEARCH_SCHEMAS } from '../main/modules/tools/schemas/general-research-schemas'

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

function rpcText(text: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text }],
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('AnySearch domain lookup is a registered parallel-safe general research tool', () => {
  assert.ok(GENERAL_RESEARCH_TOOL_NAMES.includes('web_search_domains'))
  assert.ok(GENERAL_RESEARCH_SCHEMAS.web_search_domains)
  assert.deepEqual(getToolResourceTag('web_search_domains'), {
    domain: 'general_research',
    accessMode: 'read',
  })
})

test('an explicitly selected AnySearch skill exposes its declared research tools on a live-info turn', () => {
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [{
      id: 'anysearch',
      allowedTools: ['web_search_domains', 'web_search', 'web_fetch'],
    }],
  } as never)

  try {
    const runtime = new AgentSdkRuntime({
      loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
      domainAdapters: [],
    })
    const executor = (runtime as unknown as {
      toolExecutor: {
        listDefaultToolDefinitionsForTurn: (params: Record<string, unknown>) => Array<{ name: string }>
      }
    }).toolExecutor
    const names = executor.listDefaultToolDefinitionsForTurn({
      message: '请使用 anysearch 技能查询 Apple（AAPL）的最新股票报价。',
      sessionId: 'scope-anysearch-live-surface',
      scopeId: 'scope-anysearch-live-surface',
      config: BASE_CONFIG,
      browserHostAvailable: true,
      feishuConnected: false,
      authorization: buildSelectedSkillToolAuthorization({
        skillId: 'anysearch',
        allowedTypedActions: [],
        allowedPrimitives: ['skill_read_artifact'],
        source: 'explicit',
        reason: 'test',
      }),
    }).map((definition) => definition.name)

    assert.ok(names.includes('web_search_domains'))
    assert.ok(names.includes('web_search'))
    assert.ok(names.includes('web_fetch'))
    assert.ok(!names.includes('declare_completion_criteria'))
    assert.ok(!names.includes('browser_search'))
    assert.ok(!names.includes('browser_navigate'))
    assert.ok(!names.includes('present_file'))
    assert.ok(!names.includes('web_clip_url'))
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
})

test('webSearchSchema keeps AnySearch vertical parameters including required empty strings', () => {
  const parsed = webSearchSchema.safeParse({
    query: 'AAPL',
    topK: 2,
    domain: 'finance',
    subDomain: 'finance.quote',
    subDomainParams: { type: 'stock', symbol: 'AAPL', cn_code: '' },
  })
  assert.equal(parsed.success, true)
  if (parsed.success) {
    assert.equal(parsed.data.subDomainParams?.cn_code, '')
  }
})

test('AnySearch domain lookup passes configured auth and preserves capability text', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | null = null
  let authorization = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    authorization = new Headers(init?.headers).get('Authorization') || ''
    return rpcText([
      '## finance Domain Capabilities (1 available)',
      '',
      '### finance.quote',
      'Real-time quotes',
      '',
      '**Parameters:**',
      '- `symbol` (required): ticker',
    ].join('\n'))
  }) as typeof fetch

  try {
    const result = await executeAnySearchDomainLookup(
      { domains: ['finance'] },
      {
        anysearchEnabled: true,
        anysearchBaseUrl: 'https://api.anysearch.test/mcp',
        anysearchKey: 'unit-key',
      },
    )
    assert.equal(authorization, 'Bearer unit-key')
    assert.equal((requestBody?.params as { name?: string } | undefined)?.name, 'get_sub_domains')
    assert.match(result.content, /finance\.quote/)
    assert.match(result.content, /symbol.*required/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('web_search uses AnySearch vertical search and returns the shared result shape', async () => {
  const originalFetch = globalThis.fetch
  let rpcArguments: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as {
      params?: { arguments?: Record<string, unknown> }
    }
    rpcArguments = body.params?.arguments || null
    return rpcText([
      '## Search Results (1 result, 12ms)',
      '',
      '### 1. Apple Inc. (AAPL)',
      '- **URL**: https://example.test/aapl',
      '- Price: 123.45 | Exchange: NASDAQ',
    ].join('\n'))
  }) as typeof fetch

  try {
    const result = await executeWebSearch({
      query: 'AAPL',
      topK: 1,
      domain: 'finance',
      subDomain: 'finance.quote',
      subDomainParams: { type: 'stock', symbol: 'AAPL', cn_code: '' },
    }, {
      anysearchEnabled: true,
      anysearchBaseUrl: 'https://api.anysearch.test/mcp',
      anysearchKey: 'unit-key',
    })

    assert.deepEqual(rpcArguments, {
      query: 'AAPL',
      max_results: 1,
      domain: 'finance',
      sub_domain: 'finance.quote',
      sub_domain_params: { type: 'stock', symbol: 'AAPL', cn_code: '' },
    })
    assert.deepEqual(result.results, [{
      title: 'Apple Inc. (AAPL)',
      url: 'https://example.test/aapl',
      snippet: 'Price: 123.45 | Exchange: NASDAQ',
      source: 'anysearch',
    }])
    assert.equal(result.acquisitionKind, 'answer')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('read-only research skills rebind a generic skill budget to research semantics', () => {
  const rebound = resolveAgentSdkTaskBudgetRuntime({
    options: {
      taskBudgetRuntime: createTaskBudgetRuntime('multi_step_task'),
    },
    inferredTaskType: 'research',
    forceInferredTaskType: true,
  })
  assert.equal(rebound?.taskType, 'research')
})

test('a structured vertical answer is delivered even when the model only acknowledges completion', () => {
  const now = new Date('2026-07-14T14:11:39.111Z')
  const result = {
    acquisitionKind: 'answer' as const,
    results: [{
      title: 'Apple Inc. (AAPL)',
      url: 'https://example.test/aapl',
      snippet: 'Price: 123.45 | Change: -1.25 | Change%: -1.00%',
      source: 'anysearch',
    }],
  }
  const output = createToolExecutionOutput(JSON.stringify(result), {
    data: result as unknown as Record<string, unknown>,
  })
  const delivery = captureResearchSearchDelivery('web_search', output, now)
  const deliveredText = ensureResearchSearchResultDelivered('当前任务已完成。', delivery)

  assert.match(deliveredText, /123\.45/)
  assert.match(deliveredText, /https:\/\/example\.test\/aapl/)
  assert.match(deliveredText, /2026-07-14T14:11:39\.111Z/)
  assert.equal(
    recoverResearchSearchDeliveryAfterTimeout(
      new Error('delivery_wall_clock_exceeded'),
      delivery,
    ),
    ensureResearchSearchResultDelivered('', delivery),
  )
  assert.equal(recoverResearchSearchDeliveryAfterTimeout(new Error('provider failed'), delivery), null)
  assert.equal(
    recoverResearchSearchDeliveryAfterTimeout(
      new Error('delivery_wall_clock_exceeded'),
      delivery ? { ...delivery, acquisitionKind: 'discovery' } : null,
    ),
    null,
  )

  const responseProof = collectResponseDigestProof(deliveredText, now)
  assert.ok(responseProof)
  const adjudication = adjudicateTerminalOutcome({
    terminalStatus: 'done',
    terminalReason: 'done',
    criteria: resolveCriteria('research', 'system').items,
    proofs: [
      ...collectToolOutputProofs('web_search', output, now, { runId: 'run-anysearch-answer' }),
      responseProof!,
    ],
    now,
  })
  assert.equal(adjudication.verdict, 'accept')
})

test('vertical web_search never silently drops AnySearch constraints into a generic fallback', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('unexpected', { status: 200 })
  }) as typeof fetch

  try {
    await assert.rejects(
      executeWebSearch({
        query: 'AAPL',
        topK: 1,
        domain: 'finance',
        subDomain: 'finance.quote',
        subDomainParams: { type: 'stock', symbol: 'AAPL', cn_code: '' },
      }, {
        anysearchEnabled: false,
        tavilyKey: 'tavily-unit-key',
      }),
      (error: unknown) => {
        assert.equal((error as { errorKind?: string }).errorKind, WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code)
        assert.match(String((error as Error).message), /AnySearch/i)
        return true
      },
    )
    assert.equal(calls, 0, 'Tavily/DDG must not receive a downgraded vertical query')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('general web_search falls back from AnySearch to Tavily with honest source labeling', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    if (url.includes('anysearch.test')) {
      return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      results: [{ title: 'Tavily result', url: 'https://example.test/tavily', content: 'fallback result' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const result = await executeWebSearch({ query: 'Ready research', topK: 1 }, {
      anysearchEnabled: true,
      anysearchBaseUrl: 'https://api.anysearch.test/mcp',
      anysearchKey: 'unit-key',
      tavilyKey: 'tavily-unit-key',
      tavilyBaseUrl: 'https://api.tavily.test',
      ddgEnabled: false,
    })
    assert.equal(result.results[0]?.source, 'tavily')
    assert.ok(calls.some((url) => url.includes('anysearch.test')))
    assert.ok(calls.some((url) => url === 'https://api.tavily.test/search'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('web_fetch can prefer AnySearch extract and keeps the shared content cap contract', async () => {
  const originalFetch = globalThis.fetch
  let toolName = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { params?: { name?: string } }
    toolName = body.params?.name || ''
    return rpcText([
      '## Example article',
      '',
      '**Source**: https://example.test/article',
      '',
      '---',
      '',
      '# Example article',
      '',
      'Extracted body.',
    ].join('\n'))
  }) as typeof fetch

  try {
    const result = await executeWebFetch({ url: 'https://example.test/article' }, {
      anysearchEnabled: true,
      anysearchBaseUrl: 'https://api.anysearch.test/mcp',
      anysearchKey: 'unit-key',
      preferredFetchService: 'anysearch',
    })
    assert.equal(toolName, 'extract')
    assert.equal(result.title, 'Example article')
    assert.match(result.content, /Extracted body/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
