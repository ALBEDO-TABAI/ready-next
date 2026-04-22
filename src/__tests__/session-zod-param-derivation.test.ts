/**
 * Session recall derivation equality test (Phase 2.5 PR 5).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SESSION_SCHEMAS } from '../main/modules/tools/schemas/session-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

test('derives session_search params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'query', type: 'string', description: '可选，搜索关键词', required: false },
    { name: 'channelKey', type: 'string', description: '可选，限定频道来源，例如 local:app', required: false },
    {
      name: 'sourceKind',
      type: 'string',
      description: '可选，限定会话来源 local 或 channel',
      required: false,
      enum: ['local', 'channel'],
    },
    { name: 'hasAttachments', type: 'boolean', description: '可选，只返回带附件的历史会话', required: false },
    { name: 'limit', type: 'number', description: '可选，返回数量限制，默认 5', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(SESSION_SCHEMAS.session_search), expected)
})
