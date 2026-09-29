import assert from 'node:assert/strict'
import test from 'node:test'

import { buildToolParamSchema, normalizeOpenAIToolSchema } from '../main/modules/tools/tool-schema'

test('generic openai tool normalization adds missing array items recursively', () => {
  const normalized = normalizeOpenAIToolSchema({
    type: 'function',
    function: {
      name: 'browser_run_workflow',
      description: 'batch workflow',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'workflow steps',
          },
          nested: {
            type: 'object',
            properties: {
              attachments: {
                type: 'array',
                description: 'attachment list',
              },
            },
          },
        },
      },
    },
  })

  const fn = normalized.function as { parameters?: { properties?: Record<string, unknown> } }
  const steps = fn.parameters?.properties?.steps as Record<string, unknown> | undefined
  const nested = fn.parameters?.properties?.nested as { properties?: Record<string, unknown> } | undefined
  const attachments = nested?.properties?.attachments as Record<string, unknown> | undefined

  assert.deepStrictEqual(steps?.items, {})
  assert.deepStrictEqual(attachments?.items, {})
})

test('tool param schema keeps explicit array item types', () => {
  const schema = buildToolParamSchema({
    name: 'steps',
    type: 'array',
    description: '步骤数组',
    required: true,
    items: { type: 'object', additionalProperties: true },
  })

  assert.deepStrictEqual(schema, {
    type: 'array',
    description: '步骤数组',
    items: { type: 'object', additionalProperties: true },
  })
})
