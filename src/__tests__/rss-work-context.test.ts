import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRSSWorkContext } from '../main/modules/rss-engine/work-context'
import { RSSWorkPrivacySchema } from '../shared/rss-sieve'
const now = Date.UTC(2026, 10, 11)
const data = { pages: [{ id: 'p', title: '页面标题', editedAt: now }], projects: [{ title: '项目名', active: true }], calendar: [{ title: '日程标题', startsAt: now + 1000 }], books: [{ title: '书名', reading: true }] }
const enabled = RSSWorkPrivacySchema.parse({ answer: 'enabled', enabled: true, pages: true, calendar: true, books: true })
test('V6 preview is available before consent; sending owns the consent gate', () => {
  const sources = { pages: () => data.pages, projects: () => data.projects, calendar: () => data.calendar, books: () => data.books }
  for (const privacy of [RSSWorkPrivacySchema.parse({}), { ...enabled, enabled: false }, { ...enabled, answer: 'later' as const }]) {
    assert.equal(buildRSSWorkContext(sources, privacy, [], now).text, '页面标题\n项目名\n日程标题\n书名')
  }
})
const ports = { pages: () => data.pages, projects: () => data.projects, calendar: () => data.calendar, books: () => data.books }
test('V6 category switches, object exclusions and title-only output', () => {
  assert.equal(buildRSSWorkContext(ports, enabled, [], now).text, '页面标题\n项目名\n日程标题\n书名')
  assert.equal(buildRSSWorkContext(ports, { ...enabled, pages: false }, [], now).text, '日程标题\n书名')
  assert.equal(buildRSSWorkContext(ports, { ...enabled, calendar: false }, [], now).text, '页面标题\n项目名\n书名')
  assert.equal(buildRSSWorkContext(ports, { ...enabled, books: false }, ['p'], now).text, '项目名\n日程标题')
})
test('V6 windows, title limits and 800-character cap retain complete titles', () => {
  const pages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `${i}${'字'.repeat(60)}`, editedAt: now - i }))
  const result = buildRSSWorkContext({ ...ports, pages: () => [...pages, { id: 'old', title: '过期', editedAt: now - 8 * 86400000 }] }, enabled, [], now).text
  assert.ok(result.length <= 800)
  assert.ok(result.split('\n').filter(x => /^\d/.test(x)).length <= 12)
  assert.ok(!result.includes('过期'))
})
test('V6 calendar includes at most eight upcoming titles and no out-of-window entries', () => {
  const calendar = () => [{title:'过去',startsAt:now-1}, ...Array.from({length:10},(_,i)=>({title:`会议${i}`,startsAt:now+i*1000})), {title:'下周以外',startsAt:now+7*86400000}]
  const result = buildRSSWorkContext({...ports,calendar},{...enabled,pages:false,books:false},[],now).text
  assert.deepEqual(result.split('\n'),Array.from({length:8},(_,i)=>`会议${i}`))
})
