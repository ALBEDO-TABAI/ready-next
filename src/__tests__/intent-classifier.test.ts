import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'

test('intent classifier keeps analysis-style document card requests out of rss/feishu/calendar', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '在文档里生成一张分析型信息卡，输出 SVG',
  }))

  assert.equal(result.primaryDomain, 'document')
  assert.equal(result.crossDomain, false)
  assert.ok(result.excludedDomains.includes('rss'))
  assert.ok(result.excludedDomains.includes('feishu'))
  assert.ok(result.excludedDomains.includes('calendar'))
})

test('intent classifier recognizes explicit rss report requests', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '把 RSS 模块里最新推送的 10 条信息做详细分析并输出一份报告',
  }))

  assert.equal(result.primaryDomain, 'rss')
  assert.equal(result.crossDomain, false)
  assert.ok(result.objectSignals.some((item) => /rss/i.test(item)))
  assert.ok(result.actionSignals.length > 0)
})

test('intent classifier recognizes explicit cross-domain rss to feishu workflows', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '把 RSS 模块里最新推送的 10 条分析完，再发到飞书文档里',
  }))

  assert.equal(result.crossDomain, true)
  assert.ok(result.mentionedDomains.includes('rss'))
  assert.ok(result.mentionedDomains.includes('feishu'))
})

test('intent classifier recognizes explicit skill workflow requests', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '用 skill 帮我继续执行这个 workflow，并把 blocker 处理掉',
  }))

  assert.equal(result.primaryDomain, 'skill')
  assert.equal(result.crossDomain, false)
  assert.ok(result.objectSignals.some((item) => /skill/i.test(item)))
  assert.ok(result.actionSignals.length > 0)
})

test('intent classifier recognizes live external info lookups as browser intent', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '帮我看看今天广州天气怎么样',
  }))

  assert.equal(result.primaryDomain, 'browser')
  assert.equal(result.crossDomain, false)
  assert.ok(result.objectSignals.some((item) => /browser-live-info/.test(item)))
})

test('live-info detection ignores sports/score words carried in widget attachment text', () => {
  // The user wants a cosmetic tweak to an existing widget whose attachment content
  // happens to contain 赛程/比分 — that text must not flip the run into browser_workflow.
  // (The attachment is injected via the @[...] reference + a "--- 附件: ..." block.)
  const userText = [
    '@[lck_week_preview_9_16] 让下方留白少一点',
    '',
    '--- 附件: lck_week_preview_9_16 ---',
    '- 路径: document-widget://lck_week_preview_9_16',
    '# lck_week_preview_9_16',
    '这周 LCK 赛程',
    '- T1 vs GEN, 比分 3:2',
    '- DK vs HLE, 比分 2:1',
  ].join('\n')
  const result = classifyIntent(buildRequestEnvelope({ userText }))

  // Primary user instruction is just a cosmetic tweak — no sports/score words.
  // Without B1, the sports regex in live-info matches 赛程/比分 inside the
  // attachment block and pushes primaryDomain to 'browser'.
  assert.notEqual(result.primaryDomain, 'browser')
  assert.ok(!result.objectSignals.some((item) => /browser-live-info/.test(item)))
})
