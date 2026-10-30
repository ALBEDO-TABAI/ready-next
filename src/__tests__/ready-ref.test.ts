import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCalendarDeepLink } from '../shared/calendar/desktop'
import { ReadyRefSchema, isReadyUri, parseReadyUri, toReadyUri, type ReadyRef } from '../shared/ready-ref'

const special = '中文 空格#?/%%2F+&=😀'
const refs: ReadyRef[] = [
  { kind: 'page', id: special, anchor: `#标题 ${special}` },
  { kind: 'page', id: '.', anchor: `^块${special}` },
  { kind: 'page', id: '..' },
  { kind: 'file', id: special, anchor: `page=3 ${special}` },
  { kind: 'file', id: 'f' },
  { kind: 'canvas', id: special, node: special },
  { kind: 'canvas', id: 'c' },
  { kind: 'event', id: special, occurrence: '2026-11-03T15:00:00+09:00' },
  { kind: 'event', id: 'e' },
  { kind: 'day', date: '2024-02-29', at: '00:00', remind: 0 },
  { kind: 'day', date: '2026-11-03', at: '23:59', remind: 10 },
  { kind: 'day', date: '2026-11-03' },
  { kind: 'day', date: '2026-11-03', remind: 15 },
  { kind: 'day', date: '2026-11-03', at: '15:00' },
  { kind: 'book-location', book: special, loc: `c12:3381+21 ${special}` },
  { kind: 'rss-item', id: special },
  { kind: 'web', url: 'https://example.test/中文%20路径?q=a+b&next=%2F#位置' },
  { kind: 'web', url: 'http://example.test/' },
  { kind: 'conversation', id: special, run: special },
  { kind: 'conversation', id: 'c' },
  { kind: 'fastcard', id: special },
]

test('C1: every ReadyRef kind round trips without losing Unicode or reserved characters', () => {
  for (const ref of refs) {
    assert.deepEqual(ReadyRefSchema.parse(ref), ref)
    const uri = toReadyUri(ref)
    assert.ok(uri.startsWith('ready://'))
    assert.equal(isReadyUri(uri), true)
    assert.deepEqual(parseReadyUri(uri), { ok: true, ref }, uri)
  }
})

test('C1: public URI spellings match the contract, independently of the serializer', () => {
  const cases: [string, ReadyRef][] = [
    ['ready://doc/page/p#%23%E6%A0%87%E9%A2%98', { kind: 'page', id: 'p', anchor: '#标题' }],
    ['ready://doc/file/f#page%3D3', { kind: 'file', id: 'f', anchor: 'page=3' }],
    ['ready://canvas/c#node=n%2F1', { kind: 'canvas', id: 'c', node: 'n/1' }],
    ['ready://calendar/event/e#occurrence=1793660400', { kind: 'event', id: 'e', occurrence: '1793660400' }],
    ['ready://calendar/day/2026-11-03?at=15:00&remind=10', { kind: 'day', date: '2026-11-03', at: '15:00', remind: 10 }],
    ['ready://read/book/b#c12:3381+21', { kind: 'book-location', book: 'b', loc: 'c12:3381+21' }],
    ['ready://rss/item/i', { kind: 'rss-item', id: 'i' }],
    ['ready://web?url=https%3A%2F%2Fexample.test%2F%3Fq%3Da%2Bb', { kind: 'web', url: 'https://example.test/?q=a+b' }],
    ['ready://agent/conversation/c#run=r', { kind: 'conversation', id: 'c', run: 'r' }],
    ['ready://fastcard/f', { kind: 'fastcard', id: 'f' }],
  ]
  for (const [uri, ref] of cases) assert.deepEqual(parseReadyUri(uri), { ok: true, ref })
  assert.equal(toReadyUri({ kind: 'page', id: '中 /#?%', anchor: '^块#' }),
    'ready://doc/page/%E4%B8%AD%20%2F%23%3F%25#%5E%E5%9D%97%23')
})

test('C1: invalid URIs return explicit errors without throwing or claiming validity', () => {
  const cases: [string, string][] = [
    ['https://doc/page/p', 'invalid_scheme'],
    ['ready-rss://i', 'invalid_scheme'],
    ['ready:/doc/page/p', 'invalid_scheme'],
    ['ready://unknown/p', 'unknown_module'],
    ['ready://doc/unknown/p', 'invalid_path'],
    ['ready://doc/page/', 'missing_id'],
    ['ready://canvas', 'missing_id'],
    ['ready://read/book/#loc', 'missing_id'],
    ['ready://calendar/event/', 'missing_id'],
    ['ready://calendar/day/2023-02-29', 'invalid_date'],
    ['ready://calendar/day/2026-04-31', 'invalid_date'],
    ['ready://calendar/day/2026-13-01', 'invalid_date'],
    ['ready://calendar/day/20261103', 'invalid_date'],
    ['ready://calendar/day/2026-11-03?at=24:00', 'invalid_time'],
    ['ready://calendar/day/2026-11-03?at=12:60', 'invalid_time'],
    ['ready://calendar/day/2026-11-03?at=9:00', 'invalid_time'],
    ['ready://calendar/day/2026-11-03?at=', 'invalid_time'],
    ...['-1', '1.5', 'NaN', 'Infinity', '', '1e2', '9007199254740992'].map((value): [string, string] =>
      [`ready://calendar/day/2026-11-03?remind=${value}`, 'invalid_remind']),
    ['ready://web?url=javascript%3Aalert(1)', 'invalid_web_url'],
    ['ready://web?url=file%3A%2F%2F%2Ftmp%2Fx', 'invalid_web_url'],
    ['ready://web?url=https%3A%2F%2F', 'invalid_web_url'],
    ['ready://web', 'invalid_web_url'],
    ['ready://doc/page/%', 'invalid_encoding'],
    ['ready://doc/page/p#%E0%A4', 'invalid_encoding'],
    ['ready://web?url=https%3A%2F%2Fexample.test%2F%FF', 'invalid_encoding'],
    ['ready://read/book/b', 'invalid_ref'],
    ['ready://canvas/c#wrong=n', 'invalid_fragment'],
    ['ready://canvas/c#node=', 'invalid_ref'],
    ['ready://rss/item/i#ignored', 'invalid_fragment'],
    ['ready://doc/page/a/b', 'invalid_path'],
    ['ready://calendar/day/2026-11-03?at=10:00&at=11:00', 'invalid_query'],
    ['ready://calendar/day/2026-11-03?unknown=1', 'invalid_query'],
    ['ready://rss/item/i?ignored=1', 'invalid_query'],
  ]
  for (const [uri, code] of cases) {
    const result = parseReadyUri(uri)
    assert.equal(result.ok, false, uri)
    if (result.ok) assert.fail(`Unexpected success: ${uri}`)
    assert.equal(result.error.code, code, uri)
    assert.ok(result.error.message.length > 0)
    assert.equal(isReadyUri(uri), false, uri)
  }
})

test('C1: schema and serializer reject invalid references at their boundary', () => {
  for (const input of [
    { kind: 'page', id: '' }, { kind: 'page', id: '\uD800' },
    { kind: 'file', id: 'f', anchor: '' }, { kind: 'event', id: 'e', occurrence: '' },
    { kind: 'day', date: '2026-02-30' }, { kind: 'day', date: '2026-11-03', at: '25:00' },
    { kind: 'day', date: '2026-11-03', remind: -1 },
    { kind: 'day', date: '2026-11-03', remind: 0.5 },
    { kind: 'web', url: 'ftp://example.test' }, { kind: 'book-location', book: 'b', loc: '' },
    { kind: 'rss-item', id: 'i', run: 'wrong-kind' },
  ]) assert.equal(ReadyRefSchema.safeParse(input).success, false, JSON.stringify(input))
  assert.throws(() => toReadyUri({ kind: 'day', date: '2026-02-30' }))
})

test('C1: calendar day and event targets agree with the existing deep-link parser', () => {
  for (const ref of [
    { kind: 'day', date: '2024-02-29' },
    { kind: 'day', date: '2026-11-03', at: '15:00', remind: 10 },
    { kind: 'event', id: special },
    { kind: 'event', id: special, occurrence: '1793660400' },
  ] satisfies ReadyRef[]) {
    const uri = toReadyUri(ref)
    const parsed = parseReadyUri(uri)
    assert.deepEqual(parsed, { ok: true, ref })
    // The current calendar API exposes only the base target; C1 also preserves the qualifiers above.
    assert.deepEqual(parseCalendarDeepLink(uri), ref.kind === 'day'
      ? { kind: 'day', date: ref.date }
      : { kind: 'event', eventId: ref.id })
  }
  for (const date of ['2023-02-29', '2026-04-31']) {
    const uri = `ready://calendar/day/${date}`
    assert.throws(() => parseCalendarDeepLink(uri))
    assert.equal(parseReadyUri(uri).ok, false)
  }
  assert.equal(parseCalendarDeepLink('ready://calendar/event/'), null)
  assert.equal(parseReadyUri('ready://calendar/event/').ok, false)
})
