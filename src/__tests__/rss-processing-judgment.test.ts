import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRSSJudgment, type RSSJudgmentInput } from '../main/modules/rss-engine/processing-judgment'

const input: RSSJudgmentInput = {
  definitions: [{ id: 'topic', description: '制作工具' }],
  source: { title: '新工具', titleTruncated: false, url: 'https://example.test/article', urlTruncated: false,
    author: null, authorTruncated: false, publishedAt: null, text: '新工具可以剪辑视频。', textKind: 'source_summary',
    bodyStatus: 'missing', offset: 0, totalLength: 10, truncated: false },
}
const response = {
  relevance: { score: 90, because: 'standard', reason: '符合标准', workRef: null },
  decisions: [{ definitionId: 'topic', included: true, reason: '用于制作', evidence: '可以剪辑视频' }],
}
const json = JSON.stringify(response)

test('W5 V4 accepts only bare JSON or a complete json/unlabelled fence, with surrounding whitespace', () => {
  const expected = parseRSSJudgment(json, input)
  assert.equal(expected.relevance.score, 70, 'summary-only relevance remains capped')
  for (const text of [` \n${json}\t`, `\n\`\`\`json\n${json}\n\`\`\`\n`, `\`\`\`\r\n${json}\r\n\`\`\``]) {
    assert.deepEqual(parseRSSJudgment(text, input), expected)
  }
})

test('W5 V4 rejects prose, multiple blocks, partial fences and other fence languages', () => {
  for (const text of [
    `结果：${json}`, `${json}\n以上是判断。`, `结果：\n\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`json\n${json}\n\`\`\`\n说明`, `\`\`\`json\n${json}`, `${json}\n\`\`\``,
    `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`javascript\n${json}\n\`\`\``, `\`\`\`json ${json}\`\`\``, `${json}\n${json}`,
  ]) assert.throws(() => parseRSSJudgment(text, input), undefined, text)
})

test('W5 V4 fenced JSON retains strict structure, definition identity and source evidence checks', () => {
  const decision = response.decisions[0]
  for (const invalid of [
    { ...response, extra: true }, { ...response, relevance: { ...response.relevance, score: '90' } },
    { ...response, decisions: [{ ...decision, extra: true }] }, { ...response, decisions: [] },
    { ...response, decisions: [decision, decision] }, { ...response, decisions: [{ ...decision, definitionId: 'other' }] },
    { ...response, decisions: [{ ...decision, evidence: null }] }, { ...response, decisions: [{ ...decision, evidence: '不在原文' }] },
    { ...response, relevance: { ...response.relevance, because: 'work', workRef: '未提供的工作' } },
  ]) {
    const text = JSON.stringify(invalid)
    assert.throws(() => parseRSSJudgment(text, input))
    assert.throws(() => parseRSSJudgment(`\`\`\`json\n${text}\n\`\`\``, input))
  }
})
