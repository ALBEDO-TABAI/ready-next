/**
 * 2026-07-04 真机回归第二轮根因 — 意图/交易判定输入必须是用户话语。
 *
 * 只保留一个合同：需要向模型展示原话时，优先级是
 * envelope.pureUserText → primaryInstruction → fallback。任务类型不再由
 * 用户文本词表推断，因此这里不维护站点、语言或动词分支。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolvePureUserTextForClassification,
} from '../main/modules/agent-control/runtime-core/agent-sdk-utils'

test('envelope pure text wins; primaryInstruction is the second choice; fallback last', () => {
  assert.equal(
    resolvePureUserTextForClassification({ pureUserText: ' hello ', primaryInstruction: 'p' }, 'f'),
    'hello',
  )
  assert.equal(
    resolvePureUserTextForClassification({ pureUserText: '', primaryInstruction: 'primary' }, 'f'),
    'primary',
  )
  assert.equal(resolvePureUserTextForClassification({}, 'fallback'), 'fallback')
  assert.equal(resolvePureUserTextForClassification(null, 'fallback'), 'fallback')
  assert.equal(resolvePureUserTextForClassification('not-an-object', 'fallback'), 'fallback')
})
