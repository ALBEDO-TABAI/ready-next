import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCompressionReport,
  compressArtifactsForPrompt,
  compressHistoryForPrompt,
  compressToolTraceForPrompt,
} from '../main/modules/agent-control/context-compression'

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

test('context compression collapses long tool traces and artifact history into stable summaries', () => {
  const toolTrace = compressToolTraceForPrompt([
    { kind: 'call', text: 'browser_read_page' },
    { kind: 'result', text: '读取完成' },
    { kind: 'call', text: 'document_replace_exact' },
    { kind: 'result', text: '替换完成' },
  ], { maxEntries: 2 })
  const artifacts = compressArtifactsForPrompt([
    { label: '封面草图 1', module: 'design', kind: 'image' },
    { label: '封面草图 2', module: 'design', kind: 'image' },
    { label: '封面草图 3', module: 'design', kind: 'image' },
  ], { maxEntries: 2 })
  const report = buildCompressionReport({
    historyCompressed: false,
    toolTraceCompressed: toolTrace.compressed,
    artifactSummaryUsed: artifacts.compressed,
  })

  assert.equal(toolTrace.compressed, true)
  assert.match(toolTrace.text, /工具轨迹已压缩/)
  assert.equal(artifacts.compressed, true)
  assert.match(artifacts.text, /历史产物已压缩/)
  assert.deepEqual(report, {
    historyCompressed: false,
    toolTraceCompressed: true,
    artifactSummaryUsed: true,
  })
})

test('context compression keeps empty inputs untouched', () => {
  assert.deepEqual(compressHistoryForPrompt([]), { text: '', compressed: false })
  assert.deepEqual(compressToolTraceForPrompt([]), { text: '', compressed: false })
  assert.deepEqual(compressArtifactsForPrompt([]), { text: '', compressed: false })
})
