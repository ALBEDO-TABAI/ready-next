import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSingleLinePreview, formatToolTracePreview } from '../renderer/modules/agent/toolTracePreview'

test('formatToolTracePreview keeps only the first non-empty line and appends an ellipsis', () => {
  assert.equal(
    formatToolTracePreview('skill_run_shell({"command":"cd /tmp && node script.js"})\nSTDOUT:\nlong output'),
    'skill_run_shell({"command":"cd /tmp && node script.js"})…',
  )
})

test('formatToolTracePreview normalizes whitespace and preserves existing ellipsis', () => {
  assert.equal(formatToolTracePreview('\n  正在执行   技能脚本…\n更多内容'), '正在执行 技能脚本…')
})

test('formatToolTracePreview returns empty text for blank input', () => {
  assert.equal(formatToolTracePreview(' \n '), '')
  assert.equal(formatToolTracePreview(null), '')
})

test('formatSingleLinePreview only appends ellipsis when text actually folds multiple lines', () => {
  assert.equal(formatSingleLinePreview('技能任务进行中'), '技能任务进行中')
  assert.equal(formatSingleLinePreview('Skill install failed\nCommand failed: pip install'), 'Skill install failed…')
})
