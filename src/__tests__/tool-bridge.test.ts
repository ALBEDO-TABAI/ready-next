import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply
} from '../main/modules/claude-bridge/tool-bridge'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

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
      looksLikeMissingNativeToolsReply('显式可用工具清单里只有 memory_search 和 session_search。'),
      true,
    )
    assert.strictEqual(
      looksLikeMissingNativeToolsReply('The available tools in this session only include memory_search and session_search.'),
      true,
    )
    assert.strictEqual(looksLikeMissingNativeToolsReply("I don’t have a ping tool available in this session."), true)
    assert.strictEqual(looksLikeMissingNativeToolsReply('我现在就去读取页面并继续操作。'), false)
  })
})

describe('buildTextToolResultMessage', () => {
  it('formats tool outputs back into model-readable text', () => {
    const message = buildTextToolResultMessage([
      { id: 'call_1', name: 'browser_read', result: 'page ok' },
    ])

    assert.match(message, /\[tool_result\]/)
    assert.match(message, /browser_read/)
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
