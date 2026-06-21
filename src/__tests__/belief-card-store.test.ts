import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BeliefCardStore,
  isAllowedCardPath,
  type BeliefCardFrontmatter,
} from '../main/modules/agent-control/knowledge/belief-card-store'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ready-belief-'))
}

function fm(over: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '小红书采集风险',
    description: '采集小红书的脚本检测风险',
    confidence: 'H',
    tag: 'knowledge',
    created: '2026-06-11',
    status: 'staged',
    ...over,
  }
}

test('path whitelist: normal and site cards allowed, other knowledge subdirs rejected', () => {
  assert.ok(isAllowedCardPath('knowledge/foo.md'))
  assert.ok(isAllowedCardPath('agents/editor/knowledge/foo.md'))
  assert.ok(isAllowedCardPath('knowledge/sites/xiaohongshu.md'))
  assert.ok(isAllowedCardPath('agents/x/knowledge/sites/weibo.md'))
  assert.ok(!isAllowedCardPath('knowledge/other-subdir/foo.md'))
  assert.ok(!isAllowedCardPath('knowledge/sites/sub/foo.md'))
  assert.ok(!isAllowedCardPath('notes/foo.md'))
})

test('path traversal and absolute paths are rejected', () => {
  assert.ok(!isAllowedCardPath('../knowledge/escape.md'))
  assert.ok(!isAllowedCardPath('knowledge/../../etc/passwd.md'))
  assert.ok(!isAllowedCardPath('/abs/knowledge/foo.md'))
})

test('write then read round-trips fields; default read excludes staged', () => {
  const dir = root()
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    const w = store.writeCard({ relPath: 'knowledge/foo.md', frontmatter: fm({ status: 'staged' }), body: '正文内容' })
    assert.ok(w.ok)
    // default (excludes staged) → null
    assert.equal(store.readCard('knowledge/foo.md'), null)
    // explicit includeStaged → returns the card
    const card = store.readCard('knowledge/foo.md', { includeStaged: true })
    assert.ok(card)
    assert.equal(card!.frontmatter.title, '小红书采集风险')
    assert.equal(card!.body, '正文内容')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write rejects a disallowed path', () => {
  const dir = root()
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    const w = store.writeCard({ relPath: 'knowledge/bad/foo.md', frontmatter: fm(), body: 'x' })
    assert.ok(!w.ok)
    assert.match((w as { reason: string }).reason, /not allowed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write rejects malformed frontmatter (bad confidence / tag / missing site)', () => {
  const dir = root()
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    assert.ok(!store.writeCard({ relPath: 'knowledge/a.md', frontmatter: fm({ confidence: 'X' as never }), body: 'x' }).ok)
    assert.ok(!store.writeCard({ relPath: 'knowledge/b.md', frontmatter: fm({ tag: 'bogus' as never }), body: 'x' }).ok)
    // site card without `site` field is rejected
    assert.ok(!store.writeCard({ relPath: 'knowledge/sites/c.md', frontmatter: fm(), body: 'x' }).ok)
    // site card with `site` is accepted
    assert.ok(store.writeCard({ relPath: 'knowledge/sites/c.md', frontmatter: fm({ site: 'xiaohongshu.com' }), body: 'x' }).ok)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listCards default excludes staged; includeStaged returns them', () => {
  const dir = root()
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    store.writeCard({ relPath: 'knowledge/active.md', frontmatter: fm({ status: 'active' }), body: 'a' })
    store.writeCard({ relPath: 'knowledge/staged.md', frontmatter: fm({ status: 'staged' }), body: 's' })
    const visible = store.listCards()
    assert.deepEqual(visible.map((c) => c.relPath), ['knowledge/active.md'])
    const all = store.listCards({ includeStaged: true })
    assert.equal(all.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('routing inventory shows staged and disabled cards without changing active-only routing cards', () => {
  const dir = root()
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    assert.ok(store.writeCard({
      relPath: 'knowledge/routing-writer.md',
      frontmatter: fm({
        title: '路由：写作',
        description: '写作请求',
        status: 'active',
        tag: 'self',
        triggers: ['写作'],
      }),
      body: 'x',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/routing-collector.md',
      frontmatter: fm({
        title: '路由：采集',
        description: '采集请求',
        status: 'staged',
        tag: 'self',
        triggers: ['采集'],
      }),
      body: 'x',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/routing-editor.md',
      frontmatter: fm({
        title: '路由：编辑',
        description: '缺触发词',
        status: 'active',
        tag: 'self',
      }),
      body: 'x',
    }).ok)

    const active = store.listRoutingCards()
    assert.deepEqual(active.map((card) => card.targetAgentId), ['writer'], 'staged and triggerless cards stay out of preroute')

    const inventory = store.listRoutingCardInventory([
      { id: 'writer', status: 'active' },
      { id: 'collector', status: 'active' },
      { id: 'editor', status: 'retired' },
    ])
    assert.deepEqual(
      inventory.map((card) => [card.targetAgentId, card.disabledReason]),
      [
        ['collector', 'card_staged'],
        ['editor', 'missing_triggers'],
        ['writer', null],
      ],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transition staged → active makes the card readable by default', () => {
  const dir = root()
  try {
    const store = new BeliefCardStore({ memoryRoot: dir })
    store.writeCard({ relPath: 'knowledge/p.md', frontmatter: fm({ status: 'staged' }), body: 'p' })
    assert.equal(store.readCard('knowledge/p.md'), null)
    assert.ok(store.transition('knowledge/p.md', 'active'))
    assert.ok(store.readCard('knowledge/p.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanupExpiredStaged deletes only stale staged cards', () => {
  const dir = root()
  try {
    const NOW = new Date('2026-06-30T00:00:00.000Z')
    const store = new BeliefCardStore({ memoryRoot: dir, now: () => NOW })
    store.writeCard({ relPath: 'knowledge/old.md', frontmatter: fm({ status: 'staged', created: '2026-06-01' }), body: 'old' })
    store.writeCard({ relPath: 'knowledge/fresh.md', frontmatter: fm({ status: 'staged', created: '2026-06-28' }), body: 'fresh' })
    store.writeCard({ relPath: 'knowledge/active-old.md', frontmatter: fm({ status: 'active', created: '2026-01-01' }), body: 'a' })
    const removed = store.cleanupExpiredStaged(14)
    assert.deepEqual(removed, ['knowledge/old.md'])
    assert.ok(!existsSync(join(dir, 'knowledge/old.md')))
    assert.ok(existsSync(join(dir, 'knowledge/fresh.md')))
    assert.ok(existsSync(join(dir, 'knowledge/active-old.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unparseable file (no frontmatter) reads as null, not a crash', () => {
  const dir = root()
  try {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'knowledge/broken.md'), 'no frontmatter here', 'utf-8')
    const store = new BeliefCardStore({ memoryRoot: dir })
    assert.equal(store.readCard('knowledge/broken.md', { includeStaged: true }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
