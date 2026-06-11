import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SiteCardReader } from '../main/modules/agent-control/knowledge/site-card-reader'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import { BrowserDomainAdapter } from '../main/modules/agent-control/domain-adapters/browser-domain-adapter'

const BUNDLED = join(process.cwd(), 'assets', 'site-cards')

function siteFm(over: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '站点',
    description: 'd',
    confidence: 'M',
    tag: 'knowledge',
    created: '2026-06-11',
    status: 'active',
    site: 'example.com',
    ...over,
  }
}

test('risk level comes from the code authority, not the card (high-control = high)', () => {
  const reader = new SiteCardReader({ bundledRoots: [BUNDLED] })
  const xhs = reader.render('xiaohongshu.com')
  assert.ok(xhs)
  assert.equal(xhs!.riskLevel, 'high') // isHighControlPlatformText('xiaohongshu.com') → high
  assert.ok(xhs!.body.includes('反爬'))
})

test('a non-high-control domain resolves to low even if card says otherwise', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-sitecard-'))
  try {
    mkdirSync(root, { recursive: true })
    // bundled-style card with a hand-written (ignored) riskLevel
    writeFileSync(
      join(root, 'example.com.md'),
      ['---', 'title: 示例', 'description: d', 'confidence: M', 'tag: knowledge',
        'created: 2026-06-11', 'status: active', 'site: example.com', 'riskLevel: high', '---',
        '', '经验正文', ''].join('\n'),
    )
    const warnings: unknown[] = []
    const reader = new SiteCardReader({ bundledRoots: [root], warn: (e) => warnings.push(e) })
    const card = reader.render('example.com')
    assert.equal(card!.riskLevel, 'low') // authority wins
    assert.equal(warnings.length, 1) // hand-written high ≠ authority low → warn
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('user override beats bundled; bundled untouched', () => {
  const userRoot = mkdtempSync(join(tmpdir(), 'ready-sitecard-user-'))
  try {
    const store = new BeliefCardStore({ memoryRoot: userRoot })
    const w = store.writeCard({
      relPath: 'knowledge/sites/xiaohongshu.com.md',
      frontmatter: siteFm({ site: 'xiaohongshu.com', title: '用户自定义小红书' }),
      body: '用户自己的经验 MARKER',
    })
    assert.ok(w.ok)
    const reader = new SiteCardReader({ bundledRoots: [BUNDLED], userKnowledgeRoot: store.rootPath })
    const card = reader.render('xiaohongshu.com')
    assert.equal(card!.source, 'user')
    assert.ok(card!.body.includes('用户自己的经验 MARKER'))
    assert.equal(card!.riskLevel, 'high') // authority still applies to user cards
  } finally {
    rmSync(userRoot, { recursive: true, force: true })
  }
})

test('listDomains includes all five bundled seeds, each frontmatter-valid', () => {
  const reader = new SiteCardReader({ bundledRoots: [BUNDLED] })
  const domains = reader.listDomains()
  for (const d of ['xiaohongshu.com', 'weibo.com', 'bilibili.com', 'zhihu.com', 'taobao.com']) {
    assert.ok(domains.includes(d), `missing seed ${d}`)
  }
  // each seed must pass the K1 belief-card frontmatter contract
  const store = new BeliefCardStore({ memoryRoot: mkdtempSync(join(tmpdir(), 'ready-validate-')) })
  for (const d of domains) {
    const card = reader.render(d)
    assert.ok(card, `${d} renders`)
    // re-validate by writing it through the store's whitelist+validator
    const res = store.writeCard({
      relPath: `knowledge/sites/${d}.md`,
      frontmatter: siteFm({ site: d }),
      body: card!.body,
    })
    assert.ok(res.ok, `${d} passes belief-card validation`)
  }
})

test('adapter emits a per-domain site-card fragment that matches domain mention with store risk line', () => {
  const adapter = new BrowserDomainAdapter({} as never, '', [
    { domain: 'xiaohongshu.com', aliases: ['xiaohongshu', '小红书'], text: '[风险等级: high（以代码 store 为准）]\n反爬经验' },
  ])
  const frags = adapter.contributePromptFragment() ?? []
  const card = frags.find((f) => f.id === 'site-card-xiaohongshu.com')
  assert.ok(card)
  assert.ok(card!.matches({ userText: '帮我采集小红书博主的笔记', route: null }))
  assert.ok(!card!.matches({ userText: '今天股市怎么样', route: null }))
  assert.ok(card!.refs[0].text!.includes('风险等级: high'))
})
