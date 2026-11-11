import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { mountPrimitives, ui } from './utils/primitives-ui-harness'
import type { RSSSieveItem } from '../shared/rss-sieve'
import type { RSSDefinition } from '../shared/rss-organization'

// W5 T3/T4 (renderer side): 为你筛过的 shows each article with its reason; 多看 / 少看 records a reason and reloads;
// the first-time question sends nothing until it is answered; 筛子设置 saves 我的关注 against its version, the
// 必须马上知道 switch, and topic order; the weekly calibration is applied only when accepted.
const { RSSSieveView } = await import('../renderer/components/rss/RSSSieveView')
const { RSSSieveSettings } = await import('../renderer/components/rss/RSSSieveSettings')
const { RSSCalibrationCard } = await import('../renderer/components/rss/RSSCalibrationCard')

const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
const item = (id: string, source: string, reason: string, extra: Partial<RSSSieveItem> = {}): RSSSieveItem => ({
  id, revision: 'r1', sourceRevision: 's1', sourceId: `src-${source}`, source, title: `标题 ${id}`, link: `https://example.com/${id}`, summary: '摘要',
  author: null, publishedAt: Date.now() - 3600000, collectedAt: Date.now() - 3600000, coverImage: null, read: false, starred: false, inboxVisible: true,
  bodyStatus: 'missing', classifications: [{ definitionId: 't1', name: 'AI 视频制作', kind: 'topic', included: true, origin: 'model', reason: '' }],
  sieve: { score: 80, eligible: true, pinned: false, reason, factors: [] }, relevance: null, ...extra,
})

function rssStub(overrides: Record<string, unknown> = {}) {
  const calls: { name: string; input: unknown }[] = []
  const record = (name: string, value: (input: unknown) => unknown) => (input: unknown) => { calls.push({ name, input }); return value(input) }
  const api: Record<string, unknown> = {
    sieveQuery: record('sieveQuery', () => ok({ items: [item('a', '少数派', '符合：AI 视频制作'), item('b', '机核', '你常读这个来源')], remaining: [], remainingCount: 0 })),
    getSources: record('getSources', () => ok([{ id: 'src-少数派' }])),
    processingStatus: record('processingStatus', () => ok({ settings: { enabled: true, dailyLimit: 100 }, callsToday: 3, pending: 0, running: 0, unresolved: 0, blocked: null })),
    sievePrivacy: record('sievePrivacy', () => ok({ answer: 'enabled', enabled: true, pages: true, calendar: true, books: true })),
    sieveWorkContext: record('sieveWorkContext', () => ok({ text: '', entries: [{ title: 'RSS 的筛子理论', kind: 'page' }] })),
    sieveConfigurePrivacy: record('sieveConfigurePrivacy', input => ok({ answer: 'later', enabled: false, pages: true, calendar: true, books: true, ...(input as object) })),
    sieveRecordBehavior: record('sieveRecordBehavior', input => ok(input)),
    sieveCalibration: record('sieveCalibration', () => ok(null)),
    onOrganizationChanged: () => () => {},
    toggleStarred: record('toggleStarred', () => ok({ toggled: true })),
    ...overrides,
  }
  return { api, calls }
}

async function mount(t: Parameters<typeof mountPrimitives>[0], api: Record<string, unknown>) {
  const h = await mountPrimitives(t)
  Object.assign(h.dom.window, { electronAPI: { rss: api } })
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
  const button = (name: string) => [...h.body.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)
  return { ...h, settle, button }
}

test('为你筛过的 shows each article with its reason; 少看这类 asks why, records it and reranks', async t => {
  const { api, calls } = rssStub()
  const h = await mount(t, api)
  await h.render(<><RSSSieveView shown onOpen={() => {}} /><ui.FloatHost /></>)
  await h.settle()
  assert.deepEqual([...h.body.querySelectorAll('.rss-sieve__reason')].map(node => node.textContent), ['符合：AI 视频制作', '你常读这个来源'])
  const queries = calls.filter(call => call.name === 'sieveQuery').length
  const less = h.body.querySelector<HTMLElement>('[data-sieve-item="a"] [aria-label="少看这类"]')!
  await h.click(less)
  const reasons = [...h.body.querySelectorAll('[role="menuitem"]')].map(node => node.textContent)
  assert.deepEqual(reasons, ['这个来源：少数派', '这个话题：AI 视频制作', '太浅', '已经知道了'])
  await h.click(h.button('这个来源：少数派')!)
  await h.settle()
  const recorded = calls.find(call => call.name === 'sieveRecordBehavior')!.input as Record<string, unknown>
  assert.equal(recorded.action, 'less'); assert.equal(recorded.reason, 'source'); assert.equal(recorded.itemId, 'a')
  assert.ok(calls.filter(call => call.name === 'sieveQuery').length > queries, 'the next ranking is read right away')
})

test('the first-time question lists exactly what would be sent and sends nothing until answered', async t => {
  const { api, calls } = rssStub({ sievePrivacy: () => ok({ answer: 'unanswered', enabled: false, pages: true, calendar: true, books: true }) })
  const h = await mount(t, api)
  await h.render(<RSSSieveView shown onOpen={() => {}} />)
  await h.settle()
  const list = h.get('[aria-label="将会发送的清单"]')
  assert.equal(list.textContent, 'RSS 的筛子理论')
  assert.equal(calls.some(call => call.name === 'sieveConfigurePrivacy'), false)
  await h.click(h.button('先不用')!)
  await h.settle()
  assert.deepEqual(calls.find(call => call.name === 'sieveConfigurePrivacy')!.input, { answer: 'later', enabled: false })
  assert.equal(h.body.querySelector('[aria-label="让筛子参考你正在做的事"]'), null, 'answered once, not asked again')
})

for (const [why, overrides, text] of [
  ['no sources', { getSources: () => ok([]) }, '还没有订阅来源'],
  ['no model', { processingStatus: () => ok({ settings: { enabled: true, dailyLimit: 100 }, callsToday: 0, pending: 0, running: 0, unresolved: 0, blocked: 'model' }) }, '还没有配置可用的模型'],
  ['allowance used up', { processingStatus: () => ok({ settings: { enabled: true, dailyLimit: 100 }, callsToday: 100, pending: 4, running: 0, unresolved: 0, blocked: 'limit' }) }, '今天的判断次数用完了'],
] as const) {
  test(`an empty list says why: ${why}`, async t => {
    const { api } = rssStub({ sieveQuery: () => ok({ items: [], remaining: [], remainingCount: 0 }), ...overrides })
    const h = await mount(t, api)
    await h.render(<RSSSieveView shown onOpen={() => {}} />)
    await h.settle()
    assert.match(h.get('.rss-sieve__empty').textContent!, new RegExp(text))
  })
}

test('the weekly calibration changes 我的关注 only when accepted, against the version it was written for', async t => {
  const proposal = { week: '2026-11-09', baseVersion: 4, status: 'pending', text: '独立出版与 AI 视频', explanation: '这周你读了很多发行相关的文章。', stale: false }
  const accepted: unknown[] = []
  const { api } = rssStub({
    sieveCalibration: () => ok(accepted.length ? null : proposal),
    sieveAcceptCalibration: (input: unknown) => { accepted.push(input); return ok({ version: 5, text: proposal.text }) },
  })
  const h = await mount(t, api)
  await h.render(<RSSCalibrationCard active />)
  await h.settle()
  assert.equal(h.get('.rss-calibration__text').textContent, '独立出版与 AI 视频')
  await h.click(h.button('采用')!)
  await h.settle()
  assert.deepEqual(accepted, [{ week: '2026-11-09', expectedVersion: 4 }])
  assert.equal(h.body.querySelector('.rss-calibration'), null)
})

test('a calibration written for an older 我的关注 cannot be applied', async t => {
  const { api } = rssStub({ sieveCalibration: () => ok({ week: '2026-11-09', baseVersion: 3, status: 'pending', text: '旧的建议', explanation: null, stale: true }) })
  const h = await mount(t, api)
  await h.render(<RSSCalibrationCard active />)
  await h.settle()
  assert.equal(h.button('采用'), undefined)
  assert.ok(h.button('知道了'))
})

test('筛子设置 saves 我的关注 against its version, the urgent switch, and topic order', async t => {
  const topic = (id: string, name: string, position: number): RSSDefinition => ({ id, kind: 'topic', name, description: '', icon: 'tag', position, visible: true, revision: 2, ruleRevision: 1, filterIds: [] })
  const saved: { name: string; input: unknown }[] = []
  const { api } = rssStub({
    sieveMetrics: () => ok({ from: 0, until: 1, screened: 40, hits: 22, hitRate: 0.55, missed: 2 }),
    sieveTopicNotifications: () => ok([{ topicId: 't1', urgent: false }]),
    sieveNotificationSettings: () => ok({ quietStart: '22:00', quietEnd: '08:00' }),
    sieveSettings: () => ok({ explore: true }),
    sieveFocus: () => ok({ version: 7, text: '独立出版' }),
    sieveSaveFocus: (input: unknown) => { saved.push({ name: 'focus', input }); return ok({ version: 8, text: (input as { text: string }).text }) },
    sieveSaveTopicNotification: (input: unknown) => { saved.push({ name: 'urgent', input }); return ok(input) },
    saveDefinition: (input: unknown) => { saved.push({ name: 'definition', input }); return ok(input) },
  })
  const h = await mount(t, api)
  await h.render(<RSSSieveSettings active onEditTopic={() => {}} definitions={[topic('t1', 'AI 视频制作', 10), topic('t2', '独立出版', 20)]} />)
  await h.settle()
  assert.match(h.get('[aria-label="过去 14 天"]').textContent!, /55%/)
  const focus = h.get<HTMLTextAreaElement>('textarea[aria-label="我的关注"]')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(h.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(focus, '独立出版的发行与定价')
    focus.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }))
  })
  await h.click(h.button('保存')!)
  await h.settle()
  assert.deepEqual(saved.find(entry => entry.name === 'focus')!.input, { text: '独立出版的发行与定价', expectedVersion: 7 })
  await h.click(h.get('[role="switch"][aria-label="AI 视频制作：必须马上知道"]'))
  await h.settle()
  assert.deepEqual(saved.find(entry => entry.name === 'urgent')!.input, { topicId: 't1', urgent: true })
  await h.key(h.get('li[aria-label="AI 视频制作"]'), 'ArrowDown')
  assert.equal(saved.some(entry => entry.name === 'definition'), false, 'plain arrows do not reorder')
  await act(async () => { h.get('li[aria-label="AI 视频制作"]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })) })
  await h.settle()
  const moved = saved.filter(entry => entry.name === 'definition').map(entry => entry.input as { id: string; position: number })
  assert.deepEqual(moved.map(entry => [entry.id, entry.position]), [['t2', 10], ['t1', 20]])
})
