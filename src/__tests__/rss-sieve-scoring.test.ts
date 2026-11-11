import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreRSSArticle, RSS_SIEVE_WEIGHTS, smoothPreference } from '../main/modules/rss-engine/sieve-scoring'

const base = { recentTopicInterest:false, relevance: { score: 80, because: 'work' as const, reason: '相关', workRef: '筛子理论', summaryOnly: false, workKind:'page' as const }, sourcePreference: 0.5, topicPreference: 0.5, ageHours: 0, duplicate: false, manual: null, topicName: 'AI', standardIncluded:false }
test('V1 weights, smoothing and every ranking factor are monotone', () => {
  assert.deepEqual(RSS_SIEVE_WEIGHTS, { model: 0.6, source: 20, topic: 15, freshness: 5, duplicate: 20, manual: 100 })
  assert.equal(smoothPreference(0, 0), 0.5)
  assert.ok(smoothPreference(1, 0) > 0.5)
  const score = scoreRSSArticle(base).score
  for (const input of [{ ...base, relevance: { ...base.relevance, score: 90 } }, { ...base, sourcePreference: 0.9 }, { ...base, topicPreference: 0.9 }]) assert.ok(scoreRSSArticle(input).score > score)
  assert.ok(scoreRSSArticle({ ...base, ageHours: 24 }).score < score)
  assert.ok(scoreRSSArticle({ ...base, duplicate: true }).score < score)
  assert.ok(scoreRSSArticle({ ...base, sourcePreference: 0.3 }).score < score)
})
test('V1 reasons use the largest truthfully supported contribution', () => {
  assert.equal(scoreRSSArticle(base).reason, '因为你在写《筛子理论》')
  assert.deepEqual(scoreRSSArticle(base).factors.map(x => x.factor), ['model', 'source'])
  assert.equal(scoreRSSArticle({ ...base, relevance: { ...base.relevance, score: 0 }, sourcePreference: 1 }).reason, '你常读这个来源')
  assert.equal(scoreRSSArticle({ ...base, relevance: { ...base.relevance, score: 0 }, sourcePreference: 0, topicPreference: 1, recentTopicInterest:true }).reason, '和你最近收藏的几篇相近')
  assert.equal(scoreRSSArticle({ ...base, standardIncluded:true, relevance: { ...base.relevance, because: 'standard' } }).reason, '符合：AI')
})
test('V2 manual inclusion outranks model and duplicates; manual exclusion wins', () => {
  assert.equal(scoreRSSArticle({ ...base, manual: false }).eligible, false)
  const pinned = scoreRSSArticle({ ...base, relevance: { ...base.relevance, score: 0 }, duplicate: true, manual: true })
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.reason, '符合：AI')
  assert.ok(pinned.score > scoreRSSArticle(base).score)
})

test('R6 prior source and topic preferences provide no interest claim', () => {
  const input={...base,relevance:{...base.relevance,because:'interest' as const,workRef:null},standardIncluded:false}
  assert.equal(scoreRSSArticle(input).reason,'')
  assert.equal(scoreRSSArticle(input).eligible,false)
  assert.equal(scoreRSSArticle({...input,sourcePreference:0.6}).reason,'你常读这个来源')
})
