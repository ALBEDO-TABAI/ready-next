import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import { buildBeliefCardSettingsSnapshot } from '../main/modules/agent-control/knowledge/belief-card-settings-view'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-belief-settings-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  mkdirSync(join(root, 'agents', 'collector', 'knowledge', 'sites'), { recursive: true })
  return root
}

function fm(over: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '卡片',
    description: '描述',
    confidence: 'M',
    tag: 'knowledge',
    created: '2026-06-13',
    status: 'staged',
    ...over,
  }
}

test('belief-card settings snapshot surfaces staged, agent-scoped, site cards, and risk suggestions without a site denylist', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/new-learning.md',
      frontmatter: fm({ title: '新学到的事' }),
      body: '等待确认。',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'agents/collector/knowledge/sites/xiaohongshu.com.md',
      frontmatter: fm({
        title: '小红书经验',
        status: 'active',
        site: 'xiaohongshu.com',
        source: 'possible-risk-update-of:knowledge/sites/xiaohongshu.com.md',
      }),
      body: '风险建议。',
    }).ok)

    const snapshot = buildBeliefCardSettingsSnapshot(store)
    assert.equal(snapshot.summary.total, 2)
    assert.equal(snapshot.summary.staged, 1)
    assert.equal(snapshot.summary.active, 1)
    assert.equal(snapshot.summary.agentScoped, 1)
    assert.equal(snapshot.summary.siteCards, 1)
    assert.equal(snapshot.summary.highRiskSiteCards, 0)
    assert.equal(snapshot.summary.riskSuggestions, 1)
    assert.equal(snapshot.cards[0].status, 'staged', '待确认卡优先展示')
    const site = snapshot.cards.find((card) => card.site === 'xiaohongshu.com')
    assert.equal(site?.siteRiskLevel, null)
    assert.equal(site?.siteRiskAuthority, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
