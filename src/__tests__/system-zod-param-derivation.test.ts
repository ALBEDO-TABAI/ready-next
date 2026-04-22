/**
 * System derivation equality test (Phase 2.5 PR 11).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SYSTEM_SCHEMAS } from '../main/modules/tools/schemas/system-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

test('derives system_run_embedded_python params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'code', type: 'string', description: '可选，直接执行的 Python 代码', required: false },
    {
      name: 'scriptPath',
      type: 'string',
      description: '可选，要执行的 Python 脚本绝对路径',
      required: false,
    },
    {
      name: 'args',
      type: 'array',
      description: '可选，脚本参数数组',
      required: false,
      items: { type: 'string' },
    },
    { name: 'cwd', type: 'string', description: '可选，执行目录', required: false },
    { name: 'timeoutMs', type: 'number', description: '可选，超时时间毫秒', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(SYSTEM_SCHEMAS.system_run_embedded_python), expected)
})

test('derives system_run_openclaw params', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'command',
      type: 'string',
      description: '完整命令，例如 openclaw pairing approve feishu FNXQH9PN',
      required: true,
    },
  ]
  assert.deepEqual(zodObjectToParamList(SYSTEM_SCHEMAS.system_run_openclaw), expected)
})
