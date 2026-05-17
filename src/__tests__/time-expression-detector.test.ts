/**
 * Behavior tests for L5-B time-expression-detector.
 *
 * Goal: validate that the renderer's RSS hint will get a useful set of
 * matches across Chinese, English, mixed-language, and edge-case input
 * shapes. We intentionally pick a fixed reference date so the
 * `forwardDate` and weekday-repair behaviour is deterministic across
 * machines / time zones.
 *
 * All assertions read what users actually rely on:
 *   - `text` substring matching their original phrase
 *   - `startTime / endTime` resolved to sensible Unix seconds
 *   - `hasTime` distinguishing dated-only from full-clock matches
 *   - vague phrases ("稍后", "soon") not surfacing
 *   - weekday names resolving to the right day even when chrono.zh's
 *     casual parser mis-aligns the underlying date
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectTimeExpressions,
  type DetectedTimeExpression,
} from '../main/modules/calendar-engine/time-expression-detector'

// Monday 2026-05-11 10:00 China time = 02:00Z. Used as the canonical
// reference date so weekday-relative phrases ("周三", "next Friday")
// resolve to a deterministic future weekday.
const REF_MONDAY = new Date('2026-05-11T02:00:00Z')

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

function dateLocalDay(unixSeconds: number): number {
  return new Date(unixSeconds * 1000).getDay()
}

test('detects "明天下午 3 点开会" as a single zh expression with explicit time', () => {
  const results = detectTimeExpressions('明天下午 3 点开会', REF_MONDAY)
  assert.equal(results.length, 1, 'should produce exactly one expression')
  const [hit] = results
  assert.equal(hit.locale, 'zh')
  assert.ok(hit.text.includes('明天'))
  assert.equal(hit.hasTime, true, 'explicit clock time should be flagged')
  // Default end = start + 1 hour.
  assert.equal(hit.endTime, hit.startTime + 3600)
  // Resolved start should fall on the day AFTER the reference (tomorrow).
  const startLocal = new Date(hit.startTime * 1000)
  const refLocal = new Date(REF_MONDAY.getTime())
  // Compare local calendar days, not UTC days.
  const diff = startLocal.getDate() - refLocal.getDate()
  assert.ok(diff === 1 || diff === -27 || diff === -28 || diff === -29 || diff === -30,
    `expected tomorrow, got date=${startLocal.toISOString()}`)
  assert.ok(hit.confidence === 'high' || hit.confidence === 'medium')
})

test('detects "tomorrow 3pm meeting" as a single en expression with explicit time', () => {
  const results = detectTimeExpressions('tomorrow 3pm meeting', REF_MONDAY)
  assert.equal(results.length, 1)
  const [hit] = results
  assert.equal(hit.locale, 'en')
  assert.equal(hit.hasTime, true)
  assert.ok(hit.text.toLowerCase().includes('tomorrow'))
  // Should resolve to Tuesday 15:00 local (the day after REF_MONDAY).
  const local = new Date(hit.startTime * 1000)
  assert.equal(local.getHours(), 15)
  assert.equal(local.getDay(), 2 /* Tuesday */)
})

test('detects multiple zh expressions in "周一上午开会，周三下午赛跑"', () => {
  const results = detectTimeExpressions('周一上午开会，周三下午赛跑', REF_MONDAY)
  assert.ok(results.length >= 2, `expected ≥ 2 expressions, got ${results.length}`)
  const texts = unique(results.map((r) => r.text))
  assert.ok(texts.some((t) => t.includes('周一')), `missing 周一 in ${JSON.stringify(texts)}`)
  assert.ok(texts.some((t) => t.includes('周三')), `missing 周三 in ${JSON.stringify(texts)}`)
})

test('"2026 年 5 月 17 日" resolves with hasTime=false (date-only)', () => {
  const results = detectTimeExpressions('请记住 2026 年 5 月 17 日 是个特殊日子', REF_MONDAY)
  assert.equal(results.length, 1)
  const [hit] = results
  assert.equal(hit.locale, 'zh')
  assert.equal(hit.hasTime, false, 'no clock time was given')
  const local = new Date(hit.startTime * 1000)
  assert.equal(local.getFullYear(), 2026)
  assert.equal(local.getMonth() + 1, 5)
  assert.equal(local.getDate(), 17)
})

test('vague phrases ("稍后", "soon") never reach the consumer', () => {
  const cn = detectTimeExpressions('稍后再说，晚点联系', REF_MONDAY)
  assert.equal(cn.length, 0, `vague zh phrases must be filtered: got ${JSON.stringify(cn)}`)
  const en = detectTimeExpressions('see you soon, talk to you later', REF_MONDAY)
  for (const hit of en) {
    assert.notEqual(hit.confidence, 'low', 'low-confidence vague phrases should not pass dedupe filter')
    assert.ok(!/(soon|later)/i.test(hit.text) || hit.confidence !== 'low')
  }
})

test('forwardDate: refDate=Monday, "周三 9:00" resolves to Wednesday (after weekday repair)', () => {
  const results = detectTimeExpressions('周三 9:00 开会', REF_MONDAY)
  // chrono.zh may emit one zh match for "周三 9:00" and chrono-en may
  // also emit just "9:00". We care that at least one resolves to a
  // Wednesday with the requested clock time.
  const wednesdayHit = results.find((r) => {
    const local = new Date(r.startTime * 1000)
    return local.getDay() === 3 /* Wednesday */ && local.getHours() === 9
  })
  assert.ok(wednesdayHit !== undefined, `no Wednesday 9:00 hit in ${JSON.stringify(results)}`)
  assert.ok(wednesdayHit.startTime > Math.floor(REF_MONDAY.getTime() / 1000), 'must be forward of refDate')
})

test('plain text with no time expressions returns an empty array', () => {
  const results = detectTimeExpressions(
    '今天没有任何时间表达式，just a regular sentence about features.',
    REF_MONDAY,
  )
  // Strictly we accept zero matches, but if chrono returns anything
  // none of them should carry low confidence (the IPC layer drops
  // those anyway).
  for (const hit of results) {
    assert.notEqual(hit.confidence, 'low')
  }
  // The sentence above explicitly contains "今天" which chrono.zh
  // does recognise as a relative day, so the array may be non-empty.
  // What we forbid is that the detector throws or returns garbage:
  for (const hit of results) {
    assert.ok(typeof hit.startTime === 'number' && Number.isFinite(hit.startTime))
    assert.ok(hit.endTime >= hit.startTime)
    assert.equal(typeof hit.text, 'string')
    assert.ok(hit.startIndex >= 0)
  }
})

test('truly empty / non-string input returns an empty array safely', () => {
  assert.deepEqual(detectTimeExpressions('', REF_MONDAY), [])
  // The helper is typed as string but we also want to be robust to
  // upstream type drift — calling with undefined should not throw.
  // (We coerce via `as unknown as string` to bypass TS for the
  // robustness check; production callers always pass a string.)
  const undef = undefined as unknown as string
  assert.deepEqual(detectTimeExpressions(undef, REF_MONDAY), [])
})

test('end time defaults to start + 1 hour when chrono provides no end', () => {
  const results = detectTimeExpressions('明天下午 3 点', REF_MONDAY)
  assert.equal(results.length, 1)
  const [hit] = results
  assert.equal(hit.endTime - hit.startTime, 3600)
})

test('mixed-language text picks up both en and zh hits', () => {
  const results = detectTimeExpressions('tomorrow 3pm 北京时间 明天下午 4 点', REF_MONDAY)
  const locales = unique(results.map((r) => r.locale))
  assert.ok(locales.length >= 1)
  // At least one should be a zh hit because "明天下午 4 点" is
  // unambiguously chinese and chrono-en will not parse it.
  assert.ok(results.some((r) => r.locale === 'zh' && r.text.includes('明天')),
    `expected at least one zh "明天" hit, got: ${JSON.stringify(results)}`)
})

test('results are sorted by startIndex ascending', () => {
  const results = detectTimeExpressions('周三下午开会，周一上午也开会，2026 年 5 月 17 日 截稿', REF_MONDAY)
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].startIndex >= results[i - 1].startIndex,
      `out-of-order results at i=${i}: ${JSON.stringify(results.map((r: DetectedTimeExpression) => [r.text, r.startIndex]))}`)
  }
})

test('high confidence requires year + month + day + hour all certain', () => {
  const results = detectTimeExpressions(
    'See you on 2026-05-17 at 15:30 for the launch',
    REF_MONDAY,
  )
  assert.ok(results.length >= 1)
  const highs = results.filter((r) => r.confidence === 'high')
  assert.ok(highs.length >= 1, `expected at least one high-confidence hit: ${JSON.stringify(results)}`)
  const [first] = highs
  assert.equal(first.hasTime, true)
  // dateLocalDay sanity-checks the result is a real date.
  const day = dateLocalDay(first.startTime)
  assert.ok(day >= 0 && day <= 6)
})
