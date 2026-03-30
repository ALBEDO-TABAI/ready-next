import assert from 'node:assert/strict'
import test from 'node:test'

import { getFeishuOpenAITools } from '../main/modules/tools/feishu-tools'
import { buildToolParamSchema, normalizeOpenAIToolSchema } from '../main/modules/tools/tool-schema'

test('feishu calendar create event declares attendees item schema', () => {
  const tool = getFeishuOpenAITools().find((entry) => {
    const fn = entry.function as { name?: string } | undefined
    return fn?.name === 'feishu_calendar_create_event'
  })

  assert.ok(tool, 'expected feishu calendar create event tool to exist')

  const fn = tool?.function as { parameters?: { properties?: Record<string, unknown> } }
  const attendees = fn.parameters?.properties?.attendees as Record<string, unknown> | undefined

  assert.ok(attendees, 'expected attendees schema to exist')
  assert.strictEqual(attendees?.type, 'array')
  assert.deepStrictEqual(attendees?.items, { type: 'string' })
})

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
