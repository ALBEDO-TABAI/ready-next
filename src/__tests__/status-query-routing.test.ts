import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

test('status-query-routing declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'status-query-routing transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function browserTool(name: string): ToolDefinition {
  return {
    name,
    groupId: 'browser_content_tasks',
    domain: 'browser',
    kind: name === 'browser_get_task' ? 'read' : 'write',
    concurrency: 'serial',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: `${name} test stub`,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function createRuntime(
  seenTools: string[][],
  deps: Partial<AgentSdkRuntimeDeps> = {},
): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [
      browserTool('browser_get_task'),
      browserTool('browser_visible_collect'),
      browserTool('browser_collect_notes'),
    ],
    executeToolCall: async () => createToolExecutionOutput('ok', { shape: 'json', data: { ok: true } }),
    runAgent: async ({ tools }) => {
      seenTools.push((tools as Array<{ name: string }>).map((toolItem) => toolItem.name))
      return { finalText: '好的。', toolTrace: [] }
    },
    ...deps,
  })
}

// Real envelopes trail the recalled context AFTER the user instruction, so
// primaryInstructionText() slices the instruction before the first marker.
const RECALLED_COLLECTION_CONTEXT = [
  '## L1 会话上下文',
  '## 最近会话摘要',
  '助手: 已启动小红书博主笔记采集任务 browser-task-x，正在后台运行。',
  '用户: 把这个博主的全部笔记采集下来',
].join('\n')

function instructionWithContext(instruction: string): string {
  return `${instruction}\n\n${RECALLED_COLLECTION_CONTEXT}`
}

test('status question narrows browser tools to read-only surface', async () => {
  const seenTools: string[][] = []
  const runtime = createRuntime(seenTools)
  runtime.newSession('butler::scope-status', 'system prompt')
  await runtime.sendMessage('butler::scope-status', instructionWithContext('怎么样了'), 'run-status-1', {})
  assert.equal(seenTools.length, 1)
  const names = seenTools[0]
  assert.ok(names.includes('browser_get_task'), `expected read tool kept, got ${names.join(',')}`)
  assert.ok(!names.includes('browser_visible_collect'), 'write collect tool must be hidden on status query')
  assert.ok(!names.includes('browser_collect_notes'), 'write dispatch tool must be hidden on status query')
})

test('bare continue keeps the full collection surface (99fc8f regression)', async () => {
  const seenTools: string[][] = []
  const runtime = createRuntime(seenTools)
  runtime.newSession('butler::scope-continue', 'system prompt')
  await runtime.sendMessage('butler::scope-continue', instructionWithContext('继续'), 'run-continue-1', {})
  assert.equal(seenTools.length, 1)
  const names = seenTools[0]
  assert.ok(names.includes('browser_visible_collect'), `continue must keep write tools, got ${names.join(',')}`)
  assert.ok(names.includes('browser_collect_notes'), 'continue must keep dispatch tool')
})
