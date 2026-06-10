import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyFollowupIntent,
  classifyFollowupIntentWithJudge,
  detectNegations,
  followupConsultsRecalledContext,
} from '../shared/agent-followup-intent'

const ACTIVE = { hasActiveTaskContext: true }
const IDLE = { hasActiveTaskContext: false }

test('followup truth table — continue / status / correction / new task', () => {
  const cases: Array<[string, typeof ACTIVE, string]> = [
    // continue_task
    ['继续', ACTIVE, 'continue_task'],
    ['接着弄', ACTIVE, 'continue_task'],
    ['接着采', ACTIVE, 'continue_task'],
    ['重试一下', ACTIVE, 'continue_task'],
    ['resume', ACTIVE, 'continue_task'],
    ['keep going', ACTIVE, 'continue_task'],
    ['恢复任务', ACTIVE, 'continue_task'],
    // status_query
    ['怎么样了', ACTIVE, 'status_query'],
    ['还在跑吗', ACTIVE, 'status_query'],
    ['采完了吗', ACTIVE, 'status_query'],
    ['现在进度如何？', ACTIVE, 'status_query'],
    ['好了吗', ACTIVE, 'status_query'],
    ['看看进度', ACTIVE, 'status_query'],
    // correction
    ['第一篇笔记少了图', ACTIVE, 'correction'],
    ['不对，应该是第二个博主', ACTIVE, 'correction'],
    ['你只采了 1 张', ACTIVE, 'correction'],
    ['漏了三条，补齐', ACTIVE, 'correction'],
    // new_task
    ['帮我查一下明天北京的天气', ACTIVE, 'new_task'],
    ['把这个页面的表格整理成文档，再加一个汇总段落。', ACTIVE, 'new_task'],
    ['帮我写一篇关于咖啡的文章', IDLE, 'new_task'],
    // correction patterns without active task context degrade to new_task
    ['不对，错了', IDLE, 'new_task'],
  ]
  for (const [text, ctx, expected] of cases) {
    const got = classifyFollowupIntent(text, ctx).kind
    assert.equal(got, expected, `"${text}" → ${got}, expected ${expected}`)
  }
})

test('negation guard suppresses the negated intent family', () => {
  assert.deepEqual(detectNegations('不要采集了，先看看主页'), ['collection'])
  assert.deepEqual(detectNegations('先不用打开网页'), ['browser'])
  assert.deepEqual(detectNegations('继续采集'), [])
  // negation after the verb does not suppress
  assert.deepEqual(detectNegations('采集吧，速度不要太快'), [])
})

test('negated collection never consults recalled context', () => {
  assert.equal(followupConsultsRecalledContext('不要采集了，先看看', ACTIVE), false)
  assert.equal(followupConsultsRecalledContext('继续', ACTIVE), true)
  assert.equal(followupConsultsRecalledContext('怎么样了', ACTIVE), true)
  assert.equal(followupConsultsRecalledContext('你只采了 1 张', ACTIVE), true)
  assert.equal(followupConsultsRecalledContext('帮我查个汇率', ACTIVE), false)
})

test('status question with continuation verb still routes to status', () => {
  assert.equal(classifyFollowupIntent('继续了吗？', ACTIVE).kind, 'status_query')
})

test('long substantive message is new_task even with continue verb inside', () => {
  const text = '继续之前那个话题不太合适，我们换个方向：帮我整理一份本周的行业新闻摘要并存成文档。'
  assert.equal(classifyFollowupIntent(text, ACTIVE).kind, 'new_task')
})

test('judge is consulted only inside the ambiguous band and failures fall back', async () => {
  let judged = 0
  const judge = async () => {
    judged += 1
    return 'continue_task' as const
  }
  // high-confidence heuristic: judge not consulted
  const sure = await classifyFollowupIntentWithJudge('继续', ACTIVE, judge)
  assert.equal(sure.kind, 'continue_task')
  assert.equal(judged, 0)
  // ambiguous short follow-up with active task: judge consulted
  const vague = await classifyFollowupIntentWithJudge('嗯 然后呢', ACTIVE, judge)
  assert.equal(vague.kind, 'continue_task')
  assert.equal(judged, 1)
  // judge failure falls back to heuristic
  const failing = async () => {
    throw new Error('judge offline')
  }
  const fallback = await classifyFollowupIntentWithJudge('嗯 然后呢', ACTIVE, failing)
  assert.equal(fallback.kind, 'new_task')
})
