/**
 * Golden snapshot for the system domain (Phase 2.5 PR 11).
 * Pulled from the pure defs module (system-tool-defs.ts) so the test doesn't
 * drag in skills-runtime-manager's electron imports from system-tools.ts.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getSystemAnthropicTools,
  getSystemOpenAITools,
} from '../main/modules/tools/system-tool-defs'

const EXPECTED_ANTHROPIC = [
  {
    name: 'system_run_embedded_python',
    description:
      '使用 Ready 内置的 skills runtime Python 执行代码或脚本。优先用于手动控制 skill 阶段、检查文件或运行辅助 Python 逻辑。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '可选，直接执行的 Python 代码' },
        scriptPath: { type: 'string', description: '可选，要执行的 Python 脚本绝对路径' },
        args: {
          type: 'array',
          description: '可选，脚本参数数组',
          items: { type: 'string' },
        },
        cwd: { type: 'string', description: '可选，执行目录' },
        timeoutMs: { type: 'number', description: '可选，超时时间毫秒' },
      },
      required: [],
    },
  },
  {
    name: 'system_run_openclaw',
    description:
      '执行本地 openclaw 配对/插件命令。当前仅允许 openclaw pairing 子命令，用于批准飞书等插件配对请求。',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '完整命令，例如 openclaw pairing approve feishu FNXQH9PN',
        },
      },
      required: ['command'],
    },
  },
]

test('getSystemAnthropicTools matches the locked LLM-facing payload', () => {
  assert.deepEqual(getSystemAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getSystemOpenAITools matches the locked LLM-facing payload', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getSystemOpenAITools(), expected)
})
