import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply,
  parseTextToolBridgeResponse,
  shouldEnforceBrowserToolRetry,
} from '../main/modules/claude-bridge/tool-bridge'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

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

  it('extracts XML-style tool_call blocks emitted as plain text', () => {
    const parsed = parseTextToolBridgeResponse([
      '我先看当前状态。',
      '<tool_call>',
      '<function=skill_run_shell>',
      '<parameter=command>ls -la /tmp/project</parameter>',
      '</function>',
      '</tool_call><tool_call>',
      '<function=skill_read_artifact>',
      '<parameter=path>run_state.json</parameter>',
      '</function>',
      '</tool_call>',
      '看完后继续。',
    ].join('\n'))

    assert.deepStrictEqual(parsed.toolCalls, [
      { name: 'skill_run_shell', args: { command: 'ls -la /tmp/project' } },
      { name: 'skill_read_artifact', args: { path: 'run_state.json' } },
    ])
    assert.strictEqual(parsed.visibleText, '我先看当前状态。\n看完后继续。')
  })

  it('extracts bracket tool_call blocks with input payloads', () => {
    const parsed = parseTextToolBridgeResponse([
      '我先加载参考。',
      '[tool_call]',
      '{',
      '  "tool": "skill_read_artifact",',
      '  "input": {',
      '    "path": "references/proposal-template.md"',
      '  }',
      '}',
      '</tool_call>',
      '加载后继续。',
    ].join('\n'))

    assert.deepStrictEqual(parsed.toolCalls, [
      { name: 'skill_read_artifact', args: { path: 'references/proposal-template.md' } },
    ])
    assert.strictEqual(parsed.visibleText, '我先加载参考。\n加载后继续。')
  })
})

describe('looksLikeMissingNativeToolsReply', () => {
  it('detects missing tool availability replies in multiple languages', () => {
    assert.strictEqual(looksLikeMissingNativeToolsReply('没有可用工具，当前无法执行浏览器操作。'), true)
    assert.strictEqual(looksLikeMissingNativeToolsReply('当前通道没有网页操作工具。'), true)
    assert.strictEqual(
      looksLikeMissingNativeToolsReply('我这边当前消息里虽然写了“浏览器任务执行计划”，但实际没有可调用的浏览器工具组结果返回给我。'),
      true,
    )
    assert.strictEqual(
      looksLikeMissingNativeToolsReply('我现在还是不能真的执行这份浏览器计划，因为这轮实际开放给我的工具里，没有 browser_* 工具。'),
      true,
    )
    assert.strictEqual(
      looksLikeMissingNativeToolsReply('显式可用工具清单里只有 memory_create、memory_search、memory_update、memory_list_recent 和 session_search。'),
      true,
    )
    assert.strictEqual(
      looksLikeMissingNativeToolsReply('The available tools in this session only include memory_create, memory_search, memory_update, memory_list_recent, and session_search.'),
      true,
    )
    assert.strictEqual(looksLikeMissingNativeToolsReply("I don’t have a ping tool available in this session."), true)
    assert.strictEqual(looksLikeMissingNativeToolsReply('我现在就去读取页面并继续操作。'), false)
  })
})

describe('shouldEnforceBrowserToolRetry', () => {
  it('forces a retry when a browser task receives a native zero-tool reply', () => {
    assert.strictEqual(shouldEnforceBrowserToolRetry({
      isBrowserTask: true,
      toolCallsCount: 0,
      toolTransport: 'native',
      responseText: '我先解释一下当前情况。',
    }), true)
    assert.strictEqual(shouldEnforceBrowserToolRetry({
      isBrowserTask: true,
      toolCallsCount: 0,
      toolTransport: 'text',
      responseText: '这轮实际开放给我的工具里，没有 browser_* 工具。',
    }), true)
    assert.strictEqual(shouldEnforceBrowserToolRetry({
      isBrowserTask: true,
      toolCallsCount: 1,
      toolTransport: 'native',
      responseText: '我已经开始执行。',
    }), false)
    assert.strictEqual(shouldEnforceBrowserToolRetry({
      isBrowserTask: false,
      toolCallsCount: 0,
      toolTransport: 'native',
      responseText: '我先解释一下当前情况。',
    }), false)
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

  it('keeps structured tool payloads in the text bridge transcript', () => {
    const message = buildTextToolResultMessage([
      {
        id: 'call_2',
        name: 'document_task_patch',
        result: createToolExecutionOutput('', {
          projectionPatch: {
            module: 'document',
            taskTitle: '文档信息卡',
          },
        }),
      },
    ])

    assert.match(message, /document_task_patch/)
    assert.match(message, /"module":"document"/)
    assert.match(message, /"taskTitle":"文档信息卡"/)
  })

  it('redacts host paths in model-readable text bridge tool results', () => {
    const message = buildTextToolResultMessage([
      {
        id: 'call_3',
        name: 'skill_inspect_run_state',
        result: createToolExecutionOutput('', {
          projectionPatch: {
            taskContinuation: {
              runStatePath: '/Users/alice/Ready/run_state.json',
            },
          },
        }),
      },
    ])

    assert.doesNotMatch(message, /\/Users\/alice/)
    assert.match(message, /\/Users\/<redacted>\/Ready\/run_state\.json/)
  })
})
