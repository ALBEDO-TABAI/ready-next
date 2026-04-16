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
