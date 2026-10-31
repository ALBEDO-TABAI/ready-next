import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFtsSearchText, parseSearchQuery } from '../main/modules/search-engine/query'

describe('search-engine query planner', () => {
  it('classifies a mix of tag / wikilink / term tokens', () => {
    const parsed = parseSearchQuery('#alpha [[plan]] keyword')
    assert.deepEqual(parsed.tags, ['alpha'])
    assert.deepEqual(parsed.wikilinks, ['plan'])
    assert.equal(parsed.ftsMatch, '"keyword"')
    assert.equal(parsed.tokens.length, 3)
  })

  it('keeps quoted phrases intact (ASCII)', () => {
    const parsed = parseSearchQuery('"hello world" tail')
    assert.equal(parsed.ftsMatch, '"hello world" "tail"')
    assert.deepEqual(
      parsed.tokens.map((t) => t.kind),
      ['phrase', 'term'],
    )
  })

  it('NFKC-normalizes fullwidth # / [] prefix forms', () => {
    const parsed = parseSearchQuery('＃ａｌｐｈａ')
    assert.deepEqual(parsed.tags, ['alpha'])
    assert.equal(parsed.ftsMatch, null)
  })

  it('expands CJK terms into bigram FTS match', () => {
    const parsed = parseSearchQuery('机器学习')
    // "机器学习" → bigrams "机器" "器学" "学习"
    assert.equal(parsed.ftsMatch, '"机器" "器学" "学习"')
  })

  it('adds matching CJK bigrams to indexed FTS text', () => {
    const indexed = buildFtsSearchText('北岸夜跑预算共 4.0 万元')
    assert.match(indexed, /北岸/)
    assert.match(indexed, /岸夜/)
    assert.match(indexed, /夜跑/)
    assert.match(indexed, /跑预/)
    assert.match(indexed, /预算/)
  })

  it('a single Chinese character searches as a prefix of the indexed bigrams and runs', () => {
    assert.equal(parseSearchQuery('周').ftsMatch, '"周"*')
    assert.equal(parseSearchQuery('A周').ftsMatch, '"A" "周"*')
  })

  it('keeps letter/number runs glued to Chinese as their own tokens on both sides', () => {
    assert.equal(parseSearchQuery('M5验收目标').ftsMatch, '"M5" "验收" "收目" "目标"')
    assert.equal(parseSearchQuery('Q4计划').ftsMatch, '"Q4" "计划"')
    const indexed = buildFtsSearchText('M5验收目标 与 2026年度总结')
    for (const token of ['M5', '2026', '验收', '目标', '年度']) assert.match(indexed, new RegExp(`(^|\\s)${token}(\\s|$)`))
  })

  it('collapses CJK phrases before bigram expansion', () => {
    const parsed = parseSearchQuery('"机器 学习"')
    assert.equal(parsed.ftsMatch, '"机器" "器学" "学习"')
  })

  it('returns null ftsMatch when only prefix tokens supplied', () => {
    const parsed = parseSearchQuery('#tag1 [[note]]')
    assert.equal(parsed.ftsMatch, null)
    assert.deepEqual(parsed.tags, ['tag1'])
    assert.deepEqual(parsed.wikilinks, ['note'])
  })

  it('strips zero-width characters prior to tokenization', () => {
    const parsed = parseSearchQuery('alp​ha') // contains zero-width space between "alp" and "ha"
    assert.equal(parsed.ftsMatch, '"alpha"')
  })

  it('ignores empty quotes and blank tags', () => {
    const parsed = parseSearchQuery('"" # real')
    assert.equal(parsed.tokens.length, 1)
    assert.equal(parsed.tokens[0].value, 'real')
    assert.equal(parsed.ftsMatch, '"real"')
  })

  it('extracts src: prefix into sources list', () => {
    const parsed = parseSearchQuery('src:bookmark foo')
    assert.deepEqual(parsed.sources, ['bookmark'])
    assert.equal(parsed.ftsMatch, '"foo"')
  })

  it('supports multiple src: filters combined with tags', () => {
    const parsed = parseSearchQuery('src:rss src:document #topic')
    assert.deepEqual(parsed.sources, ['rss', 'document'])
    assert.deepEqual(parsed.tags, ['topic'])
    assert.equal(parsed.ftsMatch, null)
  })
})
