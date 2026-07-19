import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_TOOL_SCHEMAS } from '../main/modules/tools/schemas/browser-tool-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'
import { getBrowserAnthropicTools, getBrowserOpenAITools } from '../main/modules/tools/browser-tool-catalog'
import { billProviderRequestSections } from '../shared/context-budget-types'

const MINIMAL_FIXTURES: Partial<Record<(typeof BROWSER_PUBLIC_TOOL_NAMES)[number], Record<string, unknown>>> = {
  browser_navigate: { action: 'open', url: 'https://example.com/fixture' },
  browser_search: { query: 'fixture' },
  browser_type: { text: 'fixture' },
  browser_fill_form: { fields: [] },
  browser_press_key: { key: 'Enter' },
  browser_request_takeover: { reason: 'verification required' },
  browser_upload: { target_id: 'upload-target', attachment_id: 'attachment-1' },
  browser_research: { action: 'start', work_items: [{ requirement: 'fixture' }] },
  browser_download: { mode: 'page', url: 'https://example.com/fixture' },
  browser_archive: { format: 'pdf', path: '/tmp/fixture.pdf' },
  browser_task: { task_id: 'browser-task-fixture' },
  browser_eval: { code: 'document.title', purpose: 'read title' },
  browser_cdp: { method: 'Runtime.evaluate', purpose: 'read title' },
  browser_permission: { action: 'status', site_request_id: 'site-request-fixture' },
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

test('OpenAI and Anthropic wire schemas preserve research, download and task conditions', () => {
  const anthropic = new Map(getBrowserAnthropicTools().map((tool) => [tool.name, tool]))
  const openai = new Map(getBrowserOpenAITools().map((tool) => {
    const fn = tool.function as Record<string, unknown>
    return [fn.name, tool]
  }))
  const anthropicResearch = anthropic.get('browser_research')?.input_schema as Record<string, unknown>
  const openaiResearch = (openai.get('browser_research')?.function as Record<string, unknown>)?.parameters as Record<string, unknown>
  assert.ok(Array.isArray(anthropicResearch.allOf))
  assert.ok(Array.isArray(openaiResearch.allOf))
  for (const schema of [anthropicResearch, openaiResearch]) {
    const conditionalRequirements = (schema.allOf as Array<{ then?: { required?: string[] } }>)
      .flatMap((condition) => condition.then?.required || [])
    assert.deepEqual(conditionalRequirements, ['work_items', 'evidence_bindings'])
  }
  assert.ok('work_items' in (anthropicResearch.properties as Record<string, unknown>))
  assert.ok('evidence_bindings' in (openaiResearch.properties as Record<string, unknown>))

  const anthropicTask = anthropic.get('browser_task')?.input_schema as Record<string, unknown>
  const openaiTask = (openai.get('browser_task')?.function as Record<string, unknown>)?.parameters as Record<string, unknown>
  assert.deepEqual(anthropicTask.required, ['task_id'])
  assert.deepEqual(openaiTask.required, ['task_id'])

  const anthropicDownload = anthropic.get('browser_download')?.input_schema as Record<string, unknown>
  const openaiDownload = (openai.get('browser_download')?.function as Record<string, unknown>)?.parameters as Record<string, unknown>
  assert.ok((anthropicDownload.required as string[]).includes('mode'))
  assert.ok((openaiDownload.required as string[]).includes('mode'))
  assert.equal((anthropicDownload.properties as Record<string, Record<string, unknown>>).urls.minItems, 1)
  assert.equal((anthropicDownload.properties as Record<string, Record<string, unknown>>).url.format, 'uri')
  assert.equal((openaiDownload.properties as Record<string, Record<string, unknown>>).page_url.format, 'uri')
  assert.ok(Array.isArray(anthropicDownload.allOf))
  assert.ok(Array.isArray(openaiDownload.allOf))

  const anthropicUpload = anthropic.get('browser_upload')?.input_schema as Record<string, unknown>
  const openaiUpload = (openai.get('browser_upload')?.function as Record<string, unknown>)?.parameters as Record<string, unknown>
  for (const schema of [anthropicUpload, openaiUpload]) {
    const conditions = schema.allOf as Array<Record<string, unknown>>
    assert.ok(Array.isArray(conditions))
    assert.ok(Array.isArray(conditions[0]?.anyOf))
    assert.ok(Array.isArray(conditions[1]?.oneOf))
  }
})

test('complete provider browser surface stays within its compact schema budget', () => {
  const functions = getBrowserOpenAITools().map((tool) => tool.function as Record<string, unknown>)
  const bill = billProviderRequestSections([], { toolSchemas: functions })
  assert.ok(
    bill.sections.tool_schema <= 6_000,
    `browser schema bill ${bill.sections.tool_schema} exceeds 6000 tokens`,
  )

  const hasNestedDescription = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasNestedDescription)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
      key === 'description' || hasNestedDescription(child)
    ))
  }
  for (const fn of functions) {
    assert.equal(hasNestedDescription(fn.parameters), false)
  }
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
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_upload.safeParse({ target_id: 'upload-target' }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_upload.safeParse({
    target_id: 'upload-target', attachment_id: 'attachment-1', latest: true,
  }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_upload.safeParse({
    target_id: 'upload-target', attachment_ids: ['attachment-1', 'attachment-2'],
  }).success, true)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_permission.safeParse({ action: 'status' }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_permission.safeParse({ action: 'set', site_request_id: 'req-1' }).success, false)
  assert.equal(BROWSER_TOOL_SCHEMAS.browser_permission.safeParse({
    action: 'set', site_request_id: 'req-1', decision: 'deny',
  }).success, true)
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
