import assert from 'node:assert/strict'
import test from 'node:test'

import { detectLiveInfoIntent } from '../main/modules/agent-control/live-info-intent'
import { __setMetricSinkForTests } from '../main/modules/agent-control/metrics'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

// D19-①: 事件/活动/场所类实时问题此前整类缺席词表，被判 local_chat 导致
// browser 组被抑制（2026-07-04 真机实锚）。fixture 矩阵钉住新增类目与
// 一词多域防回归（第二轮教训：附件/方案类文本里的领域词不得翻转路由）。

test('event-class live queries fire needsLiveInfo', () => {
  const positives = [
    '这周末有什么演出',
    '看看附近有什么活动',
    '查一下故宫的开放时间',
    '查一下周杰伦演唱会门票什么时候开售',
    '现在国家博物馆排队情况怎么样',
    '今晚livehouse有演出吗',
  ]
  for (const text of positives) {
    const intent = detectLiveInfoIntent(text)
    assert.equal(intent.needsLiveInfo, true, `should be live: ${text}`)
    assert.ok(intent.signals.includes('topic-event'), `topic-event signal missing: ${text}`)
  }
})

test('event-word documents/plans stay local (一词多域防回归)', () => {
  const negatives = [
    '帮我写一篇演唱会回顾文档',
    '整理一份活动方案',
    '写一个演出策划案',
    '帮我预约明天的会议',
  ]
  for (const text of negatives) {
    const intent = detectLiveInfoIntent(text)
    assert.equal(intent.needsLiveInfo, false, `must stay local: ${text}`)
  }
})

test('pre-existing topics keep their behavior after the word-table change', () => {
  assert.equal(detectLiveInfoIntent('明天上海天气怎么样').needsLiveInfo, true, 'weather fires on topic alone')
  assert.equal(detectLiveInfoIntent('查一下湖人比分').needsLiveInfo, true, 'sports + lookup verb fires')
  assert.equal(detectLiveInfoIntent('采集这个页面的图片').needsLiveInfo, false, 'collection wording stays out of live-info')
  assert.equal(detectLiveInfoIntent('把这批图片发布到小红书').needsLiveInfo, false, 'publish wording stays out of live-info')
  assert.equal(detectLiveInfoIntent('比分是什么意思').needsLiveInfo, false, 'knowledge-style question stays local')
})

// D19-②: 漏判账本 —— 模型在浏览器组被压掉的回合请求 browser_* 工具时，
// 发 intent_gating_miss 指标（带纯文本摘要），词表从证据演化而非拍脑袋。

test('model asking for a gated browser tool records intent_gating_miss with user text', async () => {
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => { events.push(event as unknown as Record<string, unknown>) })
  try {
    const output = await executeToolCall('browser_navigate', { url: 'https://example.com' }, {
      sessionId: 'scope-gating-miss',
      currentUserText: '这周末有什么演出',
      allowedToolNames: ['file_read_excerpt', 'document_save_tab'],
      authorization: buildExplicitNoSkillAuthorization(),
    } as never)
    assert.equal(output.data?.errorKind, 'tool_restricted_this_turn')

    const miss = events.filter((event) => event.metric === 'intent_gating_miss')
    assert.equal(miss.length, 1, 'exactly one ledger entry')
    assert.equal(miss[0].toolName, 'browser_navigate')
    assert.equal(miss[0].allowedBrowserToolCount, 0, 'fully gated turn → 0 allowed browser tools')
    assert.equal(miss[0].userTextSummary, '这周末有什么演出')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('partial browser exposure is recorded with a nonzero allowed count', async () => {
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => { events.push(event as unknown as Record<string, unknown>) })
  try {
    await executeToolCall('browser_start_task', { goal: 'x' }, {
      sessionId: 'scope-gating-partial',
      currentUserText: '打开这个页面看看',
      allowedToolNames: ['browser_navigate', 'browser_read_page'],
      authorization: buildExplicitNoSkillAuthorization(),
    } as never)
    const miss = events.filter((event) => event.metric === 'intent_gating_miss')
    assert.equal(miss.length, 1)
    assert.equal(miss[0].allowedBrowserToolCount, 2, 'partial exposure distinguishable from full gating')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('gated non-browser tools do not pollute the ledger', async () => {
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => { events.push(event as unknown as Record<string, unknown>) })
  try {
    await executeToolCall('document_save_tab', {}, {
      sessionId: 'scope-gating-doc',
      currentUserText: '保存一下',
      allowedToolNames: ['file_read_excerpt'],
      authorization: buildExplicitNoSkillAuthorization(),
    } as never)
    assert.equal(events.filter((event) => event.metric === 'intent_gating_miss').length, 0)
  } finally {
    __setMetricSinkForTests(null)
  }
})
