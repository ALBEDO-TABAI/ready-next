import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCompressionReport,
  compressHistoryForPrompt,
} from '../main/modules/agent-control/compaction/context-compression'

test('context compression summarizes long history while keeping recent turns visible', () => {
  const history = compressHistoryForPrompt([
    { role: 'user', content: 'A'.repeat(180) },
    { role: 'assistant', content: 'B'.repeat(180) },
    { role: 'user', content: 'C'.repeat(180) },
    { role: 'assistant', content: 'D'.repeat(180) },
  ], {
    keepRecent: 2,
    maxChars: 240,
  })

  assert.equal(history.compressed, true)
  assert.match(history.text, /更早消息 2 条已压缩/)
  assert.match(history.text, /最近保留 2 条原始消息/)
})

test('compression report coerces flags to booleans', () => {
  const report = buildCompressionReport({
    historyCompressed: 1 as unknown as boolean,
    toolTraceCompressed: undefined as unknown as boolean,
    artifactSummaryUsed: false,
  })

  assert.deepEqual(report, {
    historyCompressed: true,
    toolTraceCompressed: false,
    artifactSummaryUsed: false,
  })
})

test('context compression keeps empty inputs untouched', () => {
  assert.deepEqual(compressHistoryForPrompt([]), { text: '', compressed: false })
})
