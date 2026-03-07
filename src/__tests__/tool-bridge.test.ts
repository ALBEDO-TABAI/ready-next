import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply,
  parseTextToolBridgeResponse,
} from '../main/modules/claude-bridge/tool-bridge'

describe('parseTextToolBridgeResponse', () => {
  it('extracts tool_call blocks and keeps visible text', () => {
    const parsed = parseTextToolBridgeResponse([
      '我先读取当前页面。',
      ':::tool_call',
      '{"tool":"browser_read_page","args":{"mode":"full"}}',
      ':::',
      '读取后我会继续。',
      ':::tool_call',
      '{"tool":"browser_locate_input_targets","args":{}}',
      ':::',
    ].join('\n'))

    assert.deepStrictEqual(parsed.toolCalls, [
      { name: 'browser_read_page', args: { mode: 'full' } },
      { name: 'browser_locate_input_targets', args: {} },
    ])
    assert.strictEqual(parsed.visibleText, '我先读取当前页面。\n读取后我会继续。')
  })
})

describe('looksLikeMissingNativeToolsReply', () => {
  it('detects missing tool availability replies in multiple languages', () => {
    assert.strictEqual(looksLikeMissingNativeToolsReply('没有可用工具，当前无法执行浏览器操作。'), true)
    assert.strictEqual(looksLikeMissingNativeToolsReply('当前通道没有网页操作工具。'), true)
    assert.strictEqual(looksLikeMissingNativeToolsReply("I don’t have a ping tool available in this session."), true)
    assert.strictEqual(looksLikeMissingNativeToolsReply('我现在就去读取页面并继续操作。'), false)
  })
})

describe('buildTextToolResultMessage', () => {
  it('formats tool outputs back into model-readable text', () => {
    const message = buildTextToolResultMessage([
      { id: 'call_1', name: 'browser_read_page', result: 'page ok' },
    ])

    assert.match(message, /\[tool_result\]/)
    assert.match(message, /browser_read_page/)
    assert.match(message, /page ok/)
  })
})
