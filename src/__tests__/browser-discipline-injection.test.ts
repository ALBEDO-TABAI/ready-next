import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { BrowserDomainAdapter } from '../main/modules/agent-control/domain-adapters/browser-domain-adapter'
import { PromptAssetLoader } from '../main/modules/agent-control/prompt-assets/loader'

test('browser adapter no longer contributes the runtime discipline as an L2 fragment', () => {
  const fragments = new BrowserDomainAdapter({} as never).contributePromptFragment() ?? []
  assert.ok(!fragments.some((fragment) => fragment.id === 'browser-discipline'))
  assert.ok(fragments.some((f) => f.id === 'browser-collect-notes'))
})

test('真机回归 2026-07-04：采集流程片段只在真采集意图时命中，发布消息不再中招', () => {
  const fragments = new BrowserDomainAdapter({} as never).contributePromptFragment() ?? []
  const collect = fragments.find((f) => f.id === 'browser-collect-notes')!
  // 真采集意图（词表判 collection）→ 命中
  assert.ok(collect.matches({ userText: '采集@[夜空中的孤岛 - 小红书]头 5 个笔记的图片到@[cos]', route: null }))
  // 发布意图（词表判 transaction）→ 不得命中：此前 hasPlatform（提到小红书）
  // 即 true，发布 run 被注入采集流程并贴上"浏览器逐篇采集"标题
  assert.ok(!collect.matches({ userText: '帮我发一条小红书长文笔记，内容就一句话 今天天气不错', route: null }))
  // 纯观察类浏览器请求同样不注入采集流程
  assert.ok(!collect.matches({ userText: '打开小红书看看首页有什么', route: null }))
})

test('shipped discipline asset parses and renders within budget', () => {
  const loader = new PromptAssetLoader({ roots: [join(process.cwd(), 'assets', 'prompts')] })
  const asset = loader.load('browser/discipline')
  assert.equal(asset.name, 'browser-discipline')
  assert.equal(asset.version, '2')
  assert.deepEqual(asset.variables, [])
  const rendered = loader.render('browser/discipline')
  assert.ok(rendered.includes('交互五步配方'))
  assert.ok(rendered.includes('Power 网页操作配方'))
  assert.ok(rendered.includes('探测页面结构'))
  assert.ok(rendered.includes('power_eval 默认用于结构探测'))
  assert.ok(rendered.includes('代码已授权时才可执行'))
  assert.ok(rendered.includes('若本轮实际列出 browser_power_eval'))
  assert.ok(rendered.includes('只有本轮实际列出 browser_power_eval / browser_power_cdp 时'))
  assert.ok(!rendered.includes('power_eval 只读'))
  assert.ok(rendered.includes('viewport=0'))
  assert.ok(rendered.includes('Page.getFrameTree'))
  assert.ok(rendered.includes('browser_media_download_advanced'))
  assert.ok(rendered.includes('browser_download_collected_media'))
  assert.ok(rendered.includes('riskLevel=high'))
  assert.ok(rendered.includes('Power Mode'))
  assert.ok(!rendered.includes('一律走视觉通道'), 'Power Mode must not be cancelled by a static high-risk-site prompt')
  assert.ok(!rendered.includes('禁用脚本（封号风险）'), 'old high-control script ban must not re-enter the prompt')
  assert.ok(rendered.length <= 2500, 'discipline must fit the 2500-char fragment budget')
})

// ── P1 (2026-07-03, 7/01 reliability contract D) — site-card domain matching ──

const XHS_CARD = { domain: 'xiaohongshu.com', aliases: ['小红书', 'xhs'], text: '小红书采集经验：xsec_token 必带' }

function makeAdapterWithCard(): BrowserDomainAdapter {
  return new BrowserDomainAdapter({} as never, [XHS_CARD])
}

test('site card matches by user-text alias (fallback path unchanged)', () => {
  const fragments = makeAdapterWithCard().contributePromptFragment() ?? []
  const card = fragments.find((f) => f.id === 'site-card-xiaohongshu.com')!
  assert.ok(card.matches({ userText: '帮我在小红书发一篇笔记', route: null }))
  assert.ok(!card.matches({ userText: '今天天气怎么样', route: null }))
})

test('site card matches by active tab domain even when the turn does not name the site', () => {
  const fragments = makeAdapterWithCard().contributePromptFragment() ?? []
  const card = fragments.find((f) => f.id === 'site-card-xiaohongshu.com')!
  // mid-run turn: user just says "继续" but the active tab is still on XHS
  assert.ok(card.matches({
    userText: '继续',
    route: null,
    activeBrowserUrl: 'https://creator.xiaohongshu.com/publish/publish?source=official',
  }))
  // subdomain also matches
  assert.ok(card.matches({ userText: '下一步', route: null, activeBrowserUrl: 'https://www.xiaohongshu.com/explore/abc' }))
})

test('site card does NOT match an unrelated active tab domain', () => {
  const fragments = makeAdapterWithCard().contributePromptFragment() ?? []
  const card = fragments.find((f) => f.id === 'site-card-xiaohongshu.com')!
  assert.ok(!card.matches({ userText: '继续', route: null, activeBrowserUrl: 'https://www.bilibili.com/video/BV1' }))
  assert.ok(!card.matches({ userText: '继续', route: null, activeBrowserUrl: 'not a url' }))
  assert.ok(!card.matches({ userText: '继续', route: null, activeBrowserUrl: null }))
})
