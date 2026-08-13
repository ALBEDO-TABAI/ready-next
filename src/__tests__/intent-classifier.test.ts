import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'

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

test('intent classifier routes public live info to research APIs instead of visible browser control', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '帮我看看今天广州天气怎么样',
  }))

  assert.equal(result.primaryDomain, 'research')
  assert.equal(result.crossDomain, false)
  assert.ok(result.objectSignals.some((item) => /research-live-info/.test(item)))
  assert.ok(!result.objectSignals.some((item) => /browser-live-info/.test(item)))
})

test('intent classifier keeps an explicitly named public weather source on research search and fetch', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '去中国气象网查今天广州天气',
  }))

  assert.equal(result.primaryDomain, 'research')
  assert.ok(result.objectSignals.some((item) => /research-live-info/.test(item)))
})

test('intent classifier recognizes platform public-ranking lookups as browser intent', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: 'youtube 上面 aespa 播放量最高的视频是什么？',
  }))

  assert.equal(result.primaryDomain, 'browser')
  assert.equal(result.crossDomain, false)
  assert.ok(result.objectSignals.some((item) => /browser-live-info/.test(item)))
  assert.ok(result.objectSignals.some((item) => /dynamic-public-ranking/.test(item)))
})

test('intent classifier treats location-heavy comparison requests as research, not map', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '比较北京几个 IT 园区的产业特色和适合入驻的公司类型，位置可以提到，但不要做导航。',
  }))

  assert.equal(result.primaryDomain, 'research')
  assert.ok(result.actionSignals.includes('research-comparison-action'))
})

test('intent classifier does not treat local media adjustment superlatives as live info', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: '把这个视频音量调到最高',
  }))

  assert.ok(!result.objectSignals.some((item) => /browser-live-info/.test(item)))
  assert.ok(!result.objectSignals.some((item) => /dynamic-public-ranking/.test(item)))
})

test('live-info detection is suppressed when the envelope carries an explicit Widget 更新上下文', () => {
  // The user is modifying a specific widget and their own words happen to
  // include a live-info topic keyword (温度/最新). The run must stay on the
  // document domain — otherwise task-execution-router routes to the browser
  // executor and the deterministic browser runner will start searching.
  const userText = [
    '把这张信息卡里最近的温度数据字号调大一点',
    '',
    '### Widget 更新上下文',
    '- 文档: (未保存草稿)',
    '- 路径: /tmp/demo.md',
    '- 标签页ID: doc-1',
    '- 目标 widget: temperature_card',
    '- widgetId: widget_temp',
    '- 当前模式: scripted',
    '- 约束: 这是现有 widget 更新入口。优先使用 document_update_widget，不要新增第二个同类 widget，修改后保存文档。',
    '',
    '```show-widget',
    '{"title":"temperature_card","widget_code":"<div/>"}',
    '```',
  ].join('\n')
  const result = classifyIntent(buildRequestEnvelope({ userText }))

  assert.notEqual(result.primaryDomain, 'browser')
  assert.ok(!result.objectSignals.some((item) => /browser-live-info/.test(item)))
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

test('intent classifier detects skill domain via registered skill id without connector word', () => {
  const result = classifyIntent(
    buildRequestEnvelope({ userText: 'novel_writer_system 续写这段剧情' }),
    { registeredSkillTokens: ['novelwritersystem'] },
  )

  assert.ok(result.mentionedDomains.includes('skill'))
  assert.ok(result.objectSignals.includes('skill-registered-id-object'))
})

test('intent classifier stays generic without registeredSkillTokens option', () => {
  const result = classifyIntent(buildRequestEnvelope({
    userText: 'novel_writer_system 续写这段剧情',
  }))

  assert.ok(!result.mentionedDomains.includes('skill'))
  assert.ok(!result.objectSignals.includes('skill-registered-id-object'))
})
