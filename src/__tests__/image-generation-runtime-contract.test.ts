import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultToolRegistry, resolveToolInputSchemaForExecution } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { getToolResourceTag } from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'
import {
  getImageGenerationAnthropicTools,
  getImageGenerationOpenAITools,
} from '../main/modules/tools/image-generation-tool-defs'
import {
  IMAGE_GENERATION_TOOL_TIMEOUT_MS,
  resolveToolExecutionTimeoutMs,
} from '../main/modules/tools/tool-execution-timeout-policy'
import { getCapabilityGroup } from '../shared/ai-capability-groups'
import { IMAGE_GENERATION_REQUEST_TIMEOUT_MS } from '../shared/image-generation'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('image-generation-runtime-contract declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'image-generation-runtime-contract transitive sqlite guard')
})

test('generate_image has one provider-neutral schema and a serialized projection contract', () => {
  assert.deepEqual(getImageGenerationAnthropicTools().map((tool) => tool.name), ['generate_image'])
  assert.deepEqual(
    getImageGenerationOpenAITools().map((tool) => (tool.function as { name: string }).name),
    ['generate_image'],
  )
  assert.match(String(getImageGenerationAnthropicTools()[0]?.description || ''), /\/imag/)

  const definition = defaultToolRegistry.getToolDefinitionForExecution('generate_image')
  assert.equal(definition?.groupId, 'image_generation')
  assert.equal(definition?.domain, 'image_generation')
  assert.equal(definition?.kind, 'write')
  assert.equal(definition?.concurrency, 'serialized')
  assert.equal(definition?.interruptBehavior, 'abort_signal')
  assert.equal(definition?.timeoutProfile, 'image_generation')
  assert.equal(definition?.executionTimeoutMs, IMAGE_GENERATION_TOOL_TIMEOUT_MS)
  assert.deepEqual(definition?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(definition?.resultShape, 'projection_patch')
  assert.deepEqual(getToolResourceTag('generate_image'), { domain: 'image_generation', accessMode: 'write' })
})

test('generate_image validates prompt and strictly increasing reference labels before execution', () => {
  const schema = resolveToolInputSchemaForExecution('generate_image')
  assert.ok(schema)
  assert.equal(schema?.safeParse({ prompt: 'draw an orange fox', reference_image_orders: [1, 3] }).success, true)
  assert.equal(schema?.safeParse({ prompt: '', reference_image_orders: [1] }).success, false)
  assert.equal(schema?.safeParse({ prompt: 'draw', reference_image_orders: [2, 1] }).success, false)
  assert.equal(schema?.safeParse({ prompt: 'draw', unknown: true }).success, false)
})

test('AI image generation is a local-chat capability with the long request budget', () => {
  const group = getCapabilityGroup('image_generation')
  assert.equal(group?.exposure, 'model_visible')
  assert.equal(group?.availability, 'active')
  assert.deepEqual(group?.defaultProfiles, ['local_chat'])
  assert.equal(group?.settingsVisible, false)
  assert.ok(IMAGE_GENERATION_TOOL_TIMEOUT_MS > IMAGE_GENERATION_REQUEST_TIMEOUT_MS)
  assert.equal(resolveToolExecutionTimeoutMs('generate_image'), IMAGE_GENERATION_TOOL_TIMEOUT_MS)
})
