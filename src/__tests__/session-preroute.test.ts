/**
 * EP4-A5 — session preroute: three-tier decision matrix (state-first /
 * precedent / fallback), continue 类永远回原 agent, off mode zero behavior,
 * the closed triggers convention (write-side validation + every matching
 * edge), and the cross-process setting's closed union.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decideSessionPreroute,
  type PrerouteOwnedTaskRef,
  type PrerouteRoutingCard,
} from '../main/modules/agent-control/agents/session-preroute'
import { BeliefCardStore, parseTriggersValue } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  readAgentSessionPrerouteMode,
  writeAgentSessionPrerouteMode,
} from '../main/modules/settings-engine/agent-session-preroute-setting'

const ownedTask = (over: Partial<PrerouteOwnedTaskRef> = {}): PrerouteOwnedTaskRef => ({
  taskId: 'task-1', status: 'blocked', interactionState: null, summary: '采集行情',
  blockerCategory: null, ownerAgentId: 'collector', ...over,
})

const routingCard = (over: Partial<PrerouteRoutingCard> = {}): PrerouteRoutingCard => ({
  relPath: 'knowledge/routing-collector.md', targetAgentId: 'collector',
  triggers: ['小红书', '采集'], ...over,
})

const ACTIVE = new Set(['collector', 'writer'])
const base = {
  recentOwnedTasks: [] as PrerouteOwnedTaskRef[],
  routingCards: [] as PrerouteRoutingCard[],
  isAgentActive: (id: string) => ACTIVE.has(id),
  mode: 'suggest' as const,
}

test('tier matrix: state hit / precedent hit / fallback, and effects per mode', () => {
  // state: continue 类 + open owned task → original agent
  const state = decideSessionPreroute({ ...base, firstMessage: '继续刚才的任务', recentOwnedTasks: [ownedTask()] })
  assert.equal(state.decision.tier, 'state')
  assert.equal((state.decision as { targetAgentId: string }).targetAgentId, 'collector')
  assert.equal(state.effect, 'suggest')

  // precedent: keyword containment on an active routing card
  const precedent = decideSessionPreroute({ ...base, firstMessage: '帮我盯小红书的穿搭行情', routingCards: [routingCard()] })
  assert.equal(precedent.decision.tier, 'precedent')
  assert.deepEqual((precedent.decision as { matchedKeywords: string[] }).matchedKeywords, ['小红书'])

  // fallback: nothing matches → main agent, zero effect
  const fallback = decideSessionPreroute({ ...base, firstMessage: '今天天气怎么样' })
  assert.equal(fallback.decision.tier, 'fallback')
  assert.equal(fallback.decision.targetAgentId, 'butler')
  assert.equal(fallback.effect, 'none')

  // auto mode routes on hits
  assert.equal(decideSessionPreroute({ ...base, mode: 'auto', firstMessage: '小红书行情', routingCards: [routingCard()] }).effect, 'route')
  assert.equal(decideSessionPreroute({ ...base, mode: 'auto', firstMessage: '继续', recentOwnedTasks: [ownedTask()] }).effect, 'route')
})

test('continue 类永远回原 agent — precedent can NEVER hijack a continuation', () => {
  // the continuation text ALSO contains a routing keyword pointing elsewhere
  const result = decideSessionPreroute({
    ...base, mode: 'auto',
    firstMessage: '继续刚才小红书的任务',
    recentOwnedTasks: [ownedTask({ ownerAgentId: 'writer' })],
    routingCards: [routingCard()], // would route to collector
  })
  assert.equal(result.decision.tier, 'state', '状态优先于先例')
  assert.equal((result.decision as { targetAgentId: string }).targetAgentId, 'writer')

  // continuation of an UN-OWNED open task (main agent's) → fallback to the
  // main agent; the routing keyword in the text must not hijack it
  const unowned = decideSessionPreroute({
    ...base, firstMessage: '继续刚才小红书的任务',
    recentOwnedTasks: [ownedTask({ ownerAgentId: null })],
    routingCards: [routingCard()],
  })
  assert.equal(unowned.decision.tier, 'fallback', '无 owner 的延续留在主 agent')
  assert.equal(unowned.effect, 'none')
})

test('off mode: zero behavior regardless of hits', () => {
  const result = decideSessionPreroute({
    ...base, mode: 'off', firstMessage: '小红书行情',
    recentOwnedTasks: [ownedTask()], routingCards: [routingCard()],
  })
  assert.equal(result.effect, 'none')
  assert.equal(result.decision.tier, 'fallback')
  assert.equal((result.decision as { reason: string }).reason, 'routing_off')
})

test('precedent edges: no-triggers / retired target / tie conflict / best-hit wins', () => {
  // no triggers → never participates (C5 legacy repair cards)
  assert.equal(
    decideSessionPreroute({ ...base, firstMessage: '小红书', routingCards: [routingCard({ triggers: null })] }).decision.tier,
    'fallback',
  )
  // retired/unknown target → card skipped
  assert.equal(
    decideSessionPreroute({ ...base, firstMessage: '小红书', routingCards: [routingCard({ targetAgentId: 'ghost' })] }).decision.tier,
    'fallback',
  )
  // tie across different targets → conflict fallback with the cards listed
  const tie = decideSessionPreroute({
    ...base, firstMessage: '整理小红书内容',
    routingCards: [
      routingCard({ triggers: ['小红书'] }),
      routingCard({ relPath: 'knowledge/routing-writer.md', targetAgentId: 'writer', triggers: ['整理'] }),
    ],
  })
  assert.equal(tie.decision.tier, 'fallback')
  assert.equal((tie.decision as { reason: string }).reason, 'precedent_conflict')
  assert.equal((tie.decision as { conflicts?: unknown[] }).conflicts?.length, 2, '冲突卡列给建议条')
  // more matched keywords wins the tie-break
  const best = decideSessionPreroute({
    ...base, firstMessage: '采集小红书行情',
    routingCards: [
      routingCard({ triggers: ['小红书', '采集'] }),
      routingCard({ relPath: 'knowledge/routing-writer.md', targetAgentId: 'writer', triggers: ['行情'] }),
    ],
  })
  assert.equal(best.decision.tier, 'precedent')
  assert.equal((best.decision as { targetAgentId: string }).targetAgentId, 'collector')
})

test('triggers convention: closed list at the write side; malformed cards rejected', () => {
  // parser unit edges
  assert.deepEqual(parseTriggersValue(undefined), { ok: true, triggers: null })
  assert.deepEqual(parseTriggersValue('小红书, 采集'), { ok: true, triggers: ['小红书', '采集'] })
  assert.equal(parseTriggersValue('长'.repeat(33)).ok, false, '单词超 32 字符拒')
  assert.equal(parseTriggersValue(Array.from({ length: 9 }, (_, i) => `k${i}`).join(',')).ok, false, '超 8 个拒')
  assert.equal(parseTriggersValue(', ,').ok, false, '空列表拒')
  for (const bad of ['*', '?', '.*', '[abc]', 'foo|bar', 'a+b']) {
    assert.equal(parseTriggersValue(bad).ok, false, `${bad} is regex/glob-shaped and must be rejected`)
  }

  // store write-side: bad triggers reject the card; good ones roundtrip
  const root = mkdtempSync(join(tmpdir(), 'ready-a5-'))
  try {
    mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
    const store = new BeliefCardStore({ memoryRoot: root })
    const good = store.writeCard({
      relPath: 'knowledge/routing-collector.md',
      frontmatter: {
        title: '路由：采集类', description: '采集请求转 collector', confidence: 'H', tag: 'self',
        created: '2026-06-13', status: 'active', triggers: ['小红书', '采集'],
      },
      body: '确认后此域请求路由至 [[collector]]。',
    })
    assert.ok(good.ok)
    const readBack = store.readCard('knowledge/routing-collector.md')!
    assert.deepEqual(readBack.frontmatter.triggers, ['小红书', '采集'], 'triggers 序列化往返')
    const listed = store.listRoutingCards()
    assert.equal(listed[0].targetAgentId, 'collector', '目标绑定文件名')
    assert.deepEqual(listed[0].triggers, ['小红书', '采集'])

    // malformed triggers line in a hand-written file → card rejected as invalid
    writeFileSync(join(root, 'knowledge', 'routing-bad.md'), [
      '---', 'title: 坏卡', 'description: d', 'confidence: H', 'tag: self',
      'created: 2026-06-13', 'status: active', `triggers: ${'长'.repeat(40)}`, '---', '正文',
    ].join('\n'), 'utf-8')
    assert.equal(store.readCard('knowledge/routing-bad.md'), null, '坏 triggers = 坏卡，不进任何读面')
    // staged routing cards never reach listRoutingCards (precedent 永不见 staged)
    store.writeCard({
      relPath: 'knowledge/routing-writer.md',
      frontmatter: {
        title: '路由：写作', description: 'd', confidence: 'H', tag: 'self',
        created: '2026-06-13', status: 'staged', triggers: ['写作'],
      },
      body: 'x',
    })
    assert.ok(!store.listRoutingCards().some((card) => card.targetAgentId === 'writer'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_auto_routing setting: closed union, default suggest, bad value falls back', () => {
  const kv = new Map<string, string>()
  const repo = {
    getSetting: (key: string) => kv.get(key),
    setSetting: (key: string, value: string) => { kv.set(key, value) },
  }
  assert.equal(readAgentSessionPrerouteMode(repo), 'suggest', '默认 suggest')
  writeAgentSessionPrerouteMode(repo, 'auto')
  assert.equal(readAgentSessionPrerouteMode(repo), 'auto')
  kv.set('agent.sessionPrerouteMode', 'turbo')
  assert.equal(readAgentSessionPrerouteMode(repo), 'suggest', '坏值回退默认')
  assert.throws(() => writeAgentSessionPrerouteMode(repo, 'turbo' as never), /illegal mode/)
})
