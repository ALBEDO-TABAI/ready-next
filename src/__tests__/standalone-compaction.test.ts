import assert from 'node:assert/strict'
import test from 'node:test'

import { compactionFailureMessage, isStandaloneCompactionRequest } from '../renderer/modules/agent/standaloneCompaction'

// 2026-10-06: sending @[context-compact] started an Agent turn whose tool could not compact (“未知技能”).
test('only the context-compact skill on its own is a compaction request', () => {
  const skill = { source: 'skill-folder' as const, skillId: 'context-compact', name: 'context-compact' }
  assert.equal(isStandaloneCompactionRequest('@[context-compact]', [skill]), true)
  assert.equal(isStandaloneCompactionRequest('  ', [skill]), true)
  assert.equal(isStandaloneCompactionRequest('@[context-compact] 然后继续改第二节', [skill]), false, 'other requests go to the Agent')
  assert.equal(isStandaloneCompactionRequest('@[context-compact]', [skill, { source: 'file', name: 'a.md' }]), false)
  assert.equal(isStandaloneCompactionRequest('@[lark-cli]', [{ ...skill, skillId: 'lark-cli', name: 'lark-cli' }]), false)
  assert.equal(isStandaloneCompactionRequest('压缩一下', []), false, 'wording alone never compacts')
})

// 2026-10-07: a rejected compaction showed only “发送失败”.
test('compaction failures are explained by what happened, never a generic send failure', () => {
  assert.equal(compactionFailureMessage('no_active_operation'), '目前没有需要压缩的新内容。')
  assert.equal(compactionFailureMessage('native_protocol_error'), '压缩没有开始，对话保持原样，可以再试一次。')
  assert.equal(compactionFailureMessage('thread_busy'), '当前还有任务在进行，等它结束后再压缩。')
  assert.match(compactionFailureMessage('compaction_state_unknown'), /无法确认/)
  for (const code of ['persistence_failed', 'binding_conflict', 'something_else']) {
    assert.doesNotMatch(compactionFailureMessage(code), /发送失败/)
  }
})
