import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_TOOL_SCHEMAS } from '../main/modules/tools/schemas/browser-tool-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'
import { getBrowserAnthropicTools, getBrowserOpenAITools } from '../main/modules/tools/browser-tool-catalog'

const MINIMAL_FIXTURES: Partial<Record<(typeof BROWSER_PUBLIC_TOOL_NAMES)[number], Record<string, unknown>>> = {
  browser_navigate: { action: 'open', url: 'https://example.com/fixture' },
  browser_search: { query: 'fixture' },
  browser_type: { text: 'fixture' },
  browser_fill_form: { fields: [] },
  browser_press_key: { key: 'Enter' },
  browser_request_takeover: { reason: 'verification required' },
  browser_research: { scope: 'current_site', queries: ['fixture'] },
  browser_download: { mode: 'page', url: 'https://example.com/fixture' },
  browser_archive: { format: 'pdf', path: '/tmp/fixture.pdf' },
  browser_task: { task_id: 'browser-task-fixture' },
  browser_eval: { code: 'document.title', purpose: 'read title' },
  browser_cdp: { method: 'Runtime.evaluate', purpose: 'read title' },
}

test('the canonical schema map exactly matches the 32 public browser tools', () => {
  assert.deepEqual(Object.keys(BROWSER_TOOL_SCHEMAS), BROWSER_PUBLIC_TOOL_NAMES)
  assert.equal(new Set(BROWSER_PUBLIC_TOOL_NAMES).size, 32)
})

test('every public browser schema derives a model parameter list', () => {
  for (const name of BROWSER_PUBLIC_TOOL_NAMES) {
    const params = zodObjectToParamList(BROWSER_TOOL_SCHEMAS[name])
    assert.ok(Array.isArray(params), `${name} must derive parameters`)
    assert.equal(new Set(params.map((param) => param.name)).size, params.length, `${name} parameter names must be unique`)
  }
})

test('every public schema accepts a minimum legal provider call fixture', () => {
  for (const name of BROWSER_PUBLIC_TOOL_NAMES) {
    const parsed = BROWSER_TOOL_SCHEMAS[name].safeParse(MINIMAL_FIXTURES[name] || {})
    assert.equal(parsed.success, true, `${name} minimum fixture must be expressible by its public schema`)
  }
})

test('OpenAI and Anthropic wire schemas preserve required research and task fields', () => {
  const anthropic = new Map(getBrowserAnthropicTools().map((tool) => [tool.name, tool]))
  const openai = new Map(getBrowserOpenAITools().map((tool) => {
    const fn = tool.function as Record<string, unknown>
    return [fn.name, tool]
  }))
  const anthropicResearch = anthropic.get('browser_research')?.input_schema as Record<string, unknown>
  const openaiResearch = (openai.get('browser_research')?.function as Record<string, unknown>)?.parameters as Record<string, unknown>
  assert.deepEqual(anthropicResearch.required, ['scope'])
  assert.deepEqual(openaiResearch.required, ['scope'])
  assert.ok('queries' in (anthropicResearch.properties as Record<string, unknown>))
  assert.ok('queries' in (openaiResearch.properties as Record<string, unknown>))
  assert.ok(Array.isArray(anthropicResearch.allOf))
  assert.ok(Array.isArray(openaiResearch.allOf))
  const anthropicResearchProperties = anthropicResearch.properties as Record<string, Record<string, unknown>>
  const openaiResearchProperties = openaiResearch.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(anthropicResearchProperties.fields.items?.enum, ['title', 'url', 'author', 'engagement', 'published_at', 'body'])
  assert.equal((openaiResearchProperties.urls.items as Record<string, unknown>).format, 'uri')
  assert.equal(openaiResearchProperties.per_query_limit.minimum, 1)
  assert.equal(openaiResearchProperties.per_query_limit.maximum, 50)

  const anthropicTask = anthropic.get('browser_task')?.input_schema as Record<string, unknown>
  const openaiTask = (openai.get('browser_task')?.function as Record<string, unknown>)?.parameters as Record<string, unknown>
  assert.deepEqual(anthropicTask.required, ['task_id'])
  assert.deepEqual(openaiTask.required, ['task_id'])

  const anthropicDownload = anthropic.get('browser_download')?.input_schema as Record<string, unknown>
  const openaiDownload = (openai.get('browser_download')?.function as Record<string, unknown>)?.parameters as Record<string, unknown>
  assert.ok((anthropicDownload.required as string[]).includes('mode'))
  assert.ok((openaiDownload.required as string[]).includes('mode'))
  assert.equal((anthropicDownload.properties as Record<string, Record<string, unknown>>).urls.minItems, 1)
  assert.ok(Array.isArray(anthropicDownload.allOf))
  assert.ok(Array.isArray(openaiDownload.allOf))
})

test('semantic action schemas accept each locator form and reject malformed enum values', () => {
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ target_id: 'ref' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ selector: '#save' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ text: 'Save' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_click.safeParse({ x: 500, y: 500 }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_type.safeParse({ target_id: 'ref', text: 'hello' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_navigate.safeParse({ action: 'sideways' }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_navigate.safeParse({}).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_tabs.safeParse({ action: 'switch' }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_tabs.safeParse({ action: 'close', tab_id: 'tab-1' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_wait.safeParse({ condition: 'selector' }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_wait.safeParse({ condition: 'selector', selector: '#ready' }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_dialog.safeParse({ action: 'ignore' }).success, false)
})

test('removed self-authorization claims are absent from every public schema', () => {
  const internalOnly = [
    'expected_effects',
    'confirmed_via',
    'kind',
    'payload',
    'executionBinding',
    'allow_partial',
    'unrelated_to_collection',
    'strategy',
  ]
  for (const name of BROWSER_PUBLIC_TOOL_NAMES) {
    const paramNames = zodObjectToParamList(BROWSER_TOOL_SCHEMAS[name]).map((param) => param.name)
    for (const field of internalOnly) assert.ok(!paramNames.includes(field), `${name} must not accept ${field}`)
  }
})

test('download and eval schemas expose bounded runtime controls without raw-cookie export', () => {
  const downloadParams = zodObjectToParamList(BROWSER_TOOL_SCHEMAS.browser_download).map((param) => param.name)
  assert.ok(downloadParams.includes('max_total_bytes'))
  const evalParams = zodObjectToParamList(BROWSER_TOOL_SCHEMAS.browser_eval).map((param) => param.name)
  assert.ok(evalParams.includes('timeout_ms'))
  assert.ok(evalParams.includes('max_result_bytes'))
  const sessionParams = zodObjectToParamList(BROWSER_TOOL_SCHEMAS.browser_session).map((param) => param.name)
  assert.ok(!sessionParams.some((name) => /cookie.*export|token|secret/i.test(name)))
})
