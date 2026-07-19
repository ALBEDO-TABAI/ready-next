import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { z } from 'zod'

import { PromptAssetLoader } from '../main/modules/agent-control/prompt-assets/loader'
import {
  BROWSER_DISCIPLINE_MAJOR,
  MAX_BROWSER_TEXT_ACTIVATION_CHARS,
  buildBrowserDisciplineBundle,
  formatCompleteTextToolCatalog,
} from '../main/modules/agent-control/domain-adapters/browser-discipline-asset'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { getBrowserOpenAITools } from '../main/modules/tools/browser-tool-catalog'
import { BROWSER_TOOL_SCHEMAS } from '../main/modules/tools/schemas/browser-tool-schemas'
import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'
import {
  modelInputToAnthropicMessages,
  modelInputToOpenAIChatMessages,
  modelInputToOpenAIResponsesInput,
} from '../main/modules/agent-control/runtime-core/agent-sdk-model-message-utils'

function browserDefinitions(): ToolDefinition[] {
  return getBrowserOpenAITools().map((wire) => {
    const fn = wire.function as Record<string, unknown>
    return {
      name: String(fn.name),
      description: String(fn.description || fn.name),
      schema: fn.parameters as ToolDefinition['schema'],
      groupId: 'browser_interaction',
      domain: 'browser',
      kind: 'interactive',
      concurrency: 'serialized',
      interruptBehavior: 'abort_signal',
      timeoutProfile: 'browser_interactive',
      supportsTextBridge: true,
      projectionHint: null,
      executionVisibility: 'model',
      resultShape: 'json',
    }
  })
}

test('shipped discipline is complete, current, and not silently clipped', () => {
  const loader = new PromptAssetLoader({ roots: [join(process.cwd(), 'assets', 'prompts')] })
  const asset = loader.load('browser/discipline')
  const rendered = loader.render('browser/discipline')
  assert.equal(asset.name, 'browser-discipline')
  assert.equal(asset.version, String(BROWSER_DISCIPLINE_MAJOR))
  assert.ok(rendered.includes('source target provenance'))
  assert.ok(rendered.includes('observation receipt/resource'))
  assert.ok(rendered.includes('不能用一个汇总项代替多目标覆盖'))
  assert.ok(rendered.includes('0-999'))
  for (const removed of [
    'evaluate_source',
    'evidence_fields',
    'query_outcome',
    'image_gallery',
    '0-1000',
    '禁止 href',
    '两连败',
    'browser_research(action=start',
  ]) {
    assert.ok(!rendered.includes(removed), `removed Browser contract must stay absent: ${removed}`)
  }
})

test('text bridge activation returns every complete Browser schema without truncation', () => {
  const definitions = browserDefinitions()
  const catalog = formatCompleteTextToolCatalog(definitions)
  const entries = catalog.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.equal(entries.length, BROWSER_PUBLIC_TOOL_NAMES.length)
  assert.deepEqual(entries.map((entry) => entry.name), [...BROWSER_PUBLIC_TOOL_NAMES])
  for (const entry of entries) {
    assert.equal(typeof entry.description, 'string')
    assert.equal((entry.parameters as Record<string, unknown>).type, 'object')
  }

  const bundle = buildBrowserDisciplineBundle({
    definitions,
    requestEnvelope: {
      environmentHints: {
        workbenchMode: 'browser',
        browserPageRef: {
          tabId: 'tab-1',
          physicalTargetToken: 'target-1',
          mainFrameId: '0',
          mainFrameDocumentToken: 'document-1',
          profileId: 'default',
        },
      },
    },
    activation: 'same_run',
    includeCompleteTextCatalog: true,
  })
  assert.equal(bundle.toolCount, BROWSER_PUBLIC_TOOL_NAMES.length)
  assert.match(bundle.digest, /^[a-f0-9]{64}$/)
  assert.ok(bundle.text.includes('"tabId":"tab-1"'))
  assert.equal(bundle.text.includes('target-1'), false)
  assert.equal(bundle.text.includes('document-1'), false)
  assert.ok(bundle.text.includes(catalog))
  assert.ok(bundle.text.length <= MAX_BROWSER_TEXT_ACTIVATION_CHARS)
})

test('one complete discipline bundle survives all three provider message bridges', () => {
  const definitions = browserDefinitions()
  const bundle = buildBrowserDisciplineBundle({
    definitions,
    requestEnvelope: null,
    activation: 'same_run',
    includeCompleteTextCatalog: true,
  })
  const repeated = buildBrowserDisciplineBundle({
    definitions,
    requestEnvelope: null,
    activation: 'same_run',
    includeCompleteTextCatalog: true,
  })
  assert.equal(bundle.digest, repeated.digest)
  const input = [{ role: 'system', content: bundle.text }] as never
  for (const bridged of [
    modelInputToOpenAIChatMessages(input),
    modelInputToOpenAIResponsesInput(input),
    modelInputToAnthropicMessages(input),
  ]) {
    const wire = JSON.stringify(bridged)
    assert.ok(wire.includes('ready_browser_activation_v1'))
    assert.ok(wire.includes(definitions[0].name))
    assert.ok(wire.includes(definitions.at(-1)!.name))
    assert.ok(wire.includes('source target provenance'))
  }
})

test('discipline tool and parameter claims resolve against the canonical registry schemas', () => {
  const rendered = new PromptAssetLoader({ roots: [join(process.cwd(), 'assets', 'prompts')] })
    .render('browser/discipline')
  const mentionedTools = [...new Set(rendered.match(/browser_[a-z_]+/g) || [])]
  for (const toolName of mentionedTools) {
    assert.ok(BROWSER_PUBLIC_TOOL_NAMES.includes(toolName as never), `unknown discipline tool: ${toolName}`)
  }
  const click = z.toJSONSchema(BROWSER_TOOL_SCHEMAS.browser_click) as Record<string, unknown>
  const clickProperties = click.properties as Record<string, Record<string, unknown>>
  assert.equal(clickProperties.x.minimum, 0)
  assert.equal(clickProperties.x.maximum, 999)
  assert.equal(clickProperties.y.minimum, 0)
  assert.equal(clickProperties.y.maximum, 999)
})
