/**
 * Phase I P0（2026-07-05）—— 远程确认编解码纯函数合同。
 * 合同：docs/superpowers/plans/2026-07-05-phase-I-p0-remote-confirmation-implementation.md 条款 2。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatAskCardAnswerReceipt,
  formatAskUserQuestionsCardForChannel,
  parseChannelAskCardReply,
} from '../main/modules/agent-control/runtime-core/remote-confirmation-codec'
import type { AskUserQuestionSpec } from '../main/modules/tools/builtins/ask-user-questions-store'

const FROZEN_LIKE: AskUserQuestionSpec[] = [{
  id: 'frozen_call_confirm',
  question: '将覆盖移动文件 report.pdf 到 /归档，是否执行？',
  kind: 'single_choice',
  options: ['确认执行', '取消'],
  required: true,
}]

const MULTI: AskUserQuestionSpec[] = [
  {
    id: 'q1',
    question: '选哪个平台？',
    kind: 'single_choice',
    options: ['小红书', '微博'],
    required: true,
  },
  {
    id: 'q2',
    question: '要带哪些话题？',
    kind: 'multi_choice',
    options: ['生活', '摄影', '旅行'],
    required: true,
  },
]

const FREE: AskUserQuestionSpec[] = [{
  id: 'title',
  question: '标题写什么？',
  kind: 'free_text',
  placeholder: '不超过 20 字',
  required: true,
}]

test('format renders numbered options, placeholder and cancel hint', () => {
  const single = formatAskUserQuestionsCardForChannel(FROZEN_LIKE)
  assert.match(single, /【需要你确认】/)
  assert.match(single, /1\. 确认执行/)
  assert.match(single, /2\. 取消/)
  assert.match(single, /回复「取消」跳过本次确认/)

  const multi = formatAskUserQuestionsCardForChannel(MULTI)
  assert.match(multi, /问题1：选哪个平台？/)
  assert.match(multi, /问题2：要带哪些话题？/)
  assert.match(multi, /共 2 题/)

  const free = formatAskUserQuestionsCardForChannel(FREE)
  assert.match(free, /（不超过 20 字）/)
})

test('parse accepts option number, exact label, and unique prefix', () => {
  const byNumber = parseChannelAskCardReply('1', FROZEN_LIKE)
  assert.equal(byNumber.kind, 'answers')
  assert.deepEqual((byNumber as { answers: unknown }).answers, [
    { id: 'frozen_call_confirm', answer: '确认执行' },
  ])

  const byLabel = parseChannelAskCardReply('确认执行', FROZEN_LIKE)
  assert.equal(byLabel.kind, 'answers')

  const byPrefix = parseChannelAskCardReply('确认', FROZEN_LIKE)
  assert.equal(byPrefix.kind, 'answers')
  assert.deepEqual((byPrefix as { answers: Array<{ answer: unknown }> }).answers[0].answer, '确认执行')
})

test('parse refuses out-of-range numbers and unmatched text with actionable guidance', () => {
  const outOfRange = parseChannelAskCardReply('3', FROZEN_LIKE)
  assert.equal(outOfRange.kind, 'error')
  assert.match((outOfRange as { guidance: string }).guidance, /【需要你确认】/)

  const garbage = parseChannelAskCardReply('这是啥', FROZEN_LIKE)
  assert.equal(garbage.kind, 'error')
  assert.match((garbage as { guidance: string }).guidance, /没有匹配到/)
})

test('cancel words resolve to a cancel decision', () => {
  for (const word of ['取消', '跳过', 'skip', 'CANCEL']) {
    assert.equal(parseChannelAskCardReply(word, FROZEN_LIKE).kind, 'cancel', word)
  }
})

test('multi-question replies split by line/semicolon; multi_choice tokens split by spaces', () => {
  const ok = parseChannelAskCardReply('1\n1 3', MULTI)
  assert.equal(ok.kind, 'answers')
  assert.deepEqual((ok as { answers: unknown }).answers, [
    { id: 'q1', answer: '小红书' },
    { id: 'q2', answer: ['生活', '旅行'] },
  ])

  const bySemicolon = parseChannelAskCardReply('微博；摄影，旅行', MULTI)
  assert.equal(bySemicolon.kind, 'answers')
  assert.deepEqual((bySemicolon as { answers: unknown }).answers, [
    { id: 'q1', answer: '微博' },
    { id: 'q2', answer: ['摄影', '旅行'] },
  ])

  const wrongCount = parseChannelAskCardReply('1', MULTI)
  assert.equal(wrongCount.kind, 'error')
  assert.match((wrongCount as { guidance: string }).guidance, /共 2 题/)
})

test('free_text passes raw content through and rejects empty required answers', () => {
  const ok = parseChannelAskCardReply('Ready 真机测试 0705', FREE)
  assert.equal(ok.kind, 'answers')
  assert.deepEqual((ok as { answers: unknown }).answers, [
    { id: 'title', answer: 'Ready 真机测试 0705' },
  ])
  assert.equal(parseChannelAskCardReply('   ', FREE).kind, 'error')
})

test('receipt summarizes the chosen answers', () => {
  const receipt = formatAskCardAnswerReceipt(FROZEN_LIKE, [
    { id: 'frozen_call_confirm', answer: '确认执行' },
  ])
  assert.match(receipt, /已收到确认：确认执行/)
  const multiReceipt = formatAskCardAnswerReceipt(MULTI, [
    { id: 'q1', answer: '小红书' },
    { id: 'q2', answer: ['生活', '旅行'] },
  ])
  assert.match(multiReceipt, /小红书/)
  assert.match(multiReceipt, /生活、旅行/)
})
