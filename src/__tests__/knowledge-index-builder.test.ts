/**
 * EP2-C1 — knowledge-index-builder pure functions: backlinks/index rebuild,
 * invalid/orphan/duplicate detection, staged expiry (injected clock).
 * v1 is fully deterministic — zero LLM involvement (03 §6 分期原则).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildKnowledgeGraphPlan,
  stripBacklinksBlock,
  extractForwardLinks,
} from '../main/modules/agent-control/knowledge/knowledge-index-builder'
import type { BeliefCard } from '../main/modules/agent-control/knowledge/belief-card-store'

const NOW = new Date('2026-06-12T12:00:00.000Z')

function card(
  relPath: string,
  overrides: Partial<BeliefCard['frontmatter']> = {},
  body = '正文',
): { relPath: string; card: BeliefCard } {
  return {
    relPath,
    card: {
      relPath,
      frontmatter: {
        title: overrides.title ?? relPath.replace(/^.*\//, '').replace(/\.md$/, ''),
        description: overrides.description ?? '描述',
        confidence: overrides.confidence ?? 'M',
        tag: overrides.tag ?? 'knowledge',
        created: overrides.created ?? '2026-06-01',
        status: overrides.status ?? 'active',
        ...(overrides.source ? { source: overrides.source } : {}),
      },
      body,
    },
  }
}

test('stripBacklinksBlock removes the auto block and extractForwardLinks ignores links inside it', () => {
  const body = [
    '正文里链接 [[alpha]]。',
    '',
    '<!-- backlinks:auto -->',
    'Backlinks: [[ghost-from-old-block]]',
    '<!-- /backlinks:auto -->',
  ].join('\n')
  const stripped = stripBacklinksBlock(body)
  assert.ok(!stripped.includes('backlinks:auto'))
  assert.ok(stripped.includes('[[alpha]]'))
  assert.deepEqual(extractForwardLinks(body), ['alpha'], 'auto-block links must not count as forward edges')
})

test('backlinks rebuild is idempotent and auto-block links never feed the graph', () => {
  const a = card('knowledge/a.md', {}, '关联 [[b]]')
  const b = card('knowledge/b.md', {}, [
    '正文无外链。',
    '<!-- backlinks:auto -->',
    'Backlinks: [[a]]',
    '<!-- /backlinks:auto -->',
  ].join('\n'))
  const plan = buildKnowledgeGraphPlan([a, b], { now: NOW })

  const bodyB = plan.cardBodies.find((item) => item.relPath === 'knowledge/b.md')
  assert.ok(bodyB, 'b gains a rebuilt backlinks block (a links to it)')
  assert.ok(bodyB!.body.includes('[[a]]'))
  const bodyA = plan.cardBodies.find((item) => item.relPath === 'knowledge/a.md')
  assert.ok(!bodyA || !/backlinks:auto -->[\s\S]*\[\[/.test(bodyA.body), 'a has no backlinks (stale auto-block link did not count)')

  // idempotence: apply the plan, rebuild, nothing changes
  const applied = [
    { ...a, card: { ...a.card, body: bodyA ? bodyA.body : a.card.body } },
    { ...b, card: { ...b.card, body: bodyB!.body } },
  ]
  const second = buildKnowledgeGraphPlan(applied, { now: NOW })
  assert.equal(second.cardBodies.length, 0, 'second rebuild is a no-op')
  assert.equal(second.indexMarkdown, plan.indexMarkdown, 'index is stable across rebuilds')
})

test('index.md groups by tag, sorts confidence descending, stamps Updated, and renders active only', () => {
  const cards = [
    card('knowledge/pref-low.md', { tag: 'preference', confidence: 'L', title: 'PREF_LOW' }),
    card('knowledge/know-high.md', { confidence: 'H', title: 'KNOW_HIGH' }),
    card('knowledge/know-mid.md', { confidence: 'M', title: 'KNOW_MID' }),
    card('knowledge/staged.md', { status: 'staged', title: 'STAGED_CARD' }),
    card('knowledge/rejected.md', { status: 'rejected', title: 'REJECTED_CARD' }),
  ]
  const plan = buildKnowledgeGraphPlan(cards, { now: NOW })
  assert.ok(plan.indexMarkdown.includes('Updated: 2026-06-12'))
  assert.ok(plan.indexMarkdown.indexOf('KNOW_HIGH') < plan.indexMarkdown.indexOf('KNOW_MID'), 'H before M')
  assert.ok(plan.indexMarkdown.indexOf('## knowledge') < plan.indexMarkdown.indexOf('## preference'), 'tag group order is stable')
  assert.ok(!plan.indexMarkdown.includes('STAGED_CARD'))
  assert.ok(!plan.indexMarkdown.includes('REJECTED_CARD'))
})

test('staged cards expire after 14 days against the injected clock — never earlier', () => {
  const cards = [
    card('knowledge/old-staged.md', { status: 'staged', created: '2026-05-28' }), // 15 days
    card('knowledge/fresh-staged.md', { status: 'staged', created: '2026-05-31' }), // 12 days
    card('knowledge/old-active.md', { status: 'active', created: '2026-01-01' }),
  ]
  const plan = buildKnowledgeGraphPlan(cards, { now: NOW })
  assert.deepEqual(plan.expiredStaged, ['knowledge/old-staged.md'])
})

test('near-duplicates get marked possible-duplicate-of the older card, never deleted, never re-marked', () => {
  const older = card('knowledge/topic-a.md', { title: '同一主题', created: '2026-05-01' })
  const newer = card('knowledge/topic-b.md', { title: '同一主题', created: '2026-06-01' })
  const plan = buildKnowledgeGraphPlan([older, newer], { now: NOW })
  assert.deepEqual(plan.possibleDuplicates, [
    { relPath: 'knowledge/topic-b.md', duplicateOf: 'topic-a' },
  ])
  assert.ok(!plan.expiredStaged.includes('knowledge/topic-b.md'), 'duplicates are marked, not deleted')

  // already-marked card is not re-marked (idempotence)
  const marked = card('knowledge/topic-b.md', {
    title: '同一主题',
    created: '2026-06-01',
    source: 'possible-duplicate-of [[topic-a]]',
  })
  const second = buildKnowledgeGraphPlan([older, marked], { now: NOW })
  assert.equal(second.possibleDuplicates.length, 0)
})

test('orphan links and invalid cards are reported without mutation', () => {
  const a = card('knowledge/a.md', {}, '指向 [[不存在的卡]] 与 [[b]]')
  const b = card('knowledge/b.md')
  const broken = { relPath: 'knowledge/broken.md', card: null }
  const plan = buildKnowledgeGraphPlan([a, b, broken], { now: NOW })
  assert.deepEqual(plan.orphanLinks, [{ from: 'knowledge/a.md', slug: '不存在的卡' }])
  assert.deepEqual(plan.invalidCards, ['knowledge/broken.md'])
})
