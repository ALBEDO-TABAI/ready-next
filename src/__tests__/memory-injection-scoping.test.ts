import assert from 'node:assert/strict'
import test from 'node:test'

import { filterDailyMemoryForScope } from '../main/modules/agent-control/session/daily-memory-scope-filter'

const DAILY_FIXTURE = [
  '## 2026-06-09T07:37:47.859Z',
  '- scope: 帮我找一下 reddit 论坛下这几个子',
  '- success: no',
  '- lifecycle: checkpoint',
  '- interaction: running',
  '- tools: web_search, web_fetch',
  '- summary: 本轮工具调用次数已用完，任务还没完全收口。 已完成 24 次工具操作；请继续这项任务，我会沿着当前进度接着处理。',
  '## 2026-06-09T16:58:33.000Z',
  '- scope: 把@[Henry.L]这个博主的全部笔记',
  '- success: yes',
  '- lifecycle: done',
  '- tools: browser_visible_collect, browser_collect_notes',
  '- summary: 已完成 3/6 篇笔记采集，继续等待后台任务完成。',
].join('\n')

test('foreign-scope imperative checkpoint lines never reach the current scope', () => {
  const filtered = filterDailyMemoryForScope(DAILY_FIXTURE, '把@[Henry.L]这个博主的全部笔记采集到@[Henry.L]')
  assert.ok(!filtered.includes('请继续这项任务'), 'foreign imperative must be stripped')
  assert.ok(!filtered.includes('已完成 24 次工具操作'), 'foreign summary line must be stripped')
  // foreign factual metadata stays
  assert.ok(filtered.includes('- scope: 帮我找一下 reddit 论坛下这几个子'))
  assert.ok(filtered.includes('- tools: web_search, web_fetch'))
  // own-scope entry keeps everything including its summary
  assert.ok(filtered.includes('已完成 3/6 篇笔记采集'))
})

test('uncertain scope match errs toward stripping imperatives', () => {
  const filtered = filterDailyMemoryForScope(DAILY_FIXTURE, '完全无关的新会话标题')
  assert.ok(!filtered.includes('请继续这项任务'))
  assert.ok(!filtered.includes('已完成 3/6 篇笔记采集'), 'unmatched scope summaries are stripped too')
  assert.ok(filtered.includes('- lifecycle: done'), 'factual lines survive')
})

test('preamble and empty content pass through unchanged', () => {
  assert.equal(filterDailyMemoryForScope('', 'x'), '')
  const preamble = '一些没有时间戳条目的前言文本'
  assert.equal(filterDailyMemoryForScope(preamble, 'x'), preamble)
})
