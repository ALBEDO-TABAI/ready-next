import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

// Phase 3 — output safety net（A2 退役后的存活部分）。
//
// 原文件同时钉了 turn-engine 的输出净化 helper（sanitizeAssistantText /
// pushAssistantTextSafely / buildBudgetWarningMessage）与 tool-bridge 的
// XML tool_call 解析。turn-engine 已随 Phase A 退役（dormant，生产零引用，
// 见 2026-07-03-p3-a0-b1-implementation.md §A1：全部 helper dead-with-engine，
// live SDK 路径各有等价实现且有自己的测试），引擎侧断言随类摘除；本文件
// 保留 live 守卫：
//   D1 — tool-bridge.ts 的 XML tool_call 提取（claude-bridge live 路径）。
//   metric — toolCallTextIntercepted 注册保持（live 发射者在 SDK 路径）。

const TOOL_BRIDGE_PATH = new URL('../main/modules/claude-bridge/tool-bridge.ts', import.meta.url)

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

test('Phase 3.2 — toolCallTextIntercepted metric is registered in TOOL_ERROR_METRICS', () => {
  assert.equal(TOOL_ERROR_METRICS.toolCallTextIntercepted, 'tool_call_text_intercepted')
})

test('Phase 3.1 wiring — tool-bridge.ts XML regexes are present and exported through parseTextToolBridgeResponse', () => {
  const source = readSource(TOOL_BRIDGE_PATH)
  assert.match(source, /XML_TOOL_CALL_REGEX/)
  assert.match(source, /XML_FUNCTION_REGEX/)
  assert.match(source, /XML_PARAMETER_REGEX/)
  // The new helper that does the per-block extraction.
  assert.match(source, /function extractXmlToolCall\(blockBody: string\):/)
  // parseTextToolBridgeResponse must invoke BOTH regexes (legacy + XML).
  const parserBlock = source.match(/export function parseTextToolBridgeResponse[\s\S]*?return \{ visibleText, toolCalls \}\s*\}/)
  assert.ok(parserBlock)
  assert.match(parserBlock![0], /TOOL_CALL_BLOCK_REGEX/)
  assert.match(parserBlock![0], /XML_TOOL_CALL_REGEX/)
})
