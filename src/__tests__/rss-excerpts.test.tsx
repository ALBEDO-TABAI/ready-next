import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { MarkdownContent } from '../renderer/components/document/MarkdownContent'
import { readingRuns, readingExcerpt } from '../shared/rss-reading'
import { RSSReadExcerptSchema } from '../shared/rss-excerpt'
import { RSSReferenceSchema, rssCitationUrl, parseRSSCitationUrl } from '../shared/rss-reference'
import { selectedReadingRange, revealReadingRange } from '../renderer/modules/rss/reading-selection'
import { DatabaseManager } from '../main/modules/database'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { renderInline } from '../renderer/components/agent/chat-panel/markdown'

const markdown = '[^z]: First note &amp; detail.\n\n# Heading\n\nRepeated phrase.\n\nA &amp; B **bold** [link](https://example.test)  \nnext `inline\ncode`.\n\nRepeated phrase.\n\n| X | Y |\n| - | - |\n| one | two |\n\n```js\nlet x = 1;\n\n```\n\nSee note[^z].\n\n<script>not executed</script>'
function domFor(text: string) {
  return new JSDOM(`<div id="body">${renderToStaticMarkup(<MarkdownContent readingAnchors content={text} externalBaseUrl="https://example.test" onOpenLink={() => {}} />)}</div>`)
}

test('the shared reading projection equals rendered text runs including entities, code, hard breaks, tables and reordered footnotes', () => {
  const dom = domFor(markdown)
  try {
    const actual = [...dom.window.document.querySelectorAll<HTMLElement>('[data-ready-reading-run]')].map((node) => ({ id: Number(node.dataset.readyReadingRun), block: Number(node.dataset.readyReadingBlock), text: node.textContent }))
    assert.deepEqual(actual, readingRuns(markdown))
    assert.equal(actual.at(-1)!.text, 'First note & detail.')
    assert.equal(dom.window.document.querySelector('script'), null)
    const block = dom.window.document.querySelector('.note-preview-code-block code')!
    assert.equal(block.textContent, 'let x = 1;\n\n', 'the copy/display code keeps its existing generated terminal newline outside the anchor')
  } finally { dom.window.close() }
})

test('a repeated passage and element-boundary selections retain exact occurrence and paragraph ownership', () => {
  const dom = domFor(markdown), body = dom.window.document.getElementById('body')!
  try {
    const repeated = [...body.querySelectorAll<HTMLElement>('[data-ready-reading-run]')].filter((node) => node.textContent === 'Repeated phrase.')
    const range = dom.window.document.createRange(); range.setStart(repeated[1].firstChild!, 9); range.setEnd(repeated[1].firstChild!, 15)
    const selection = dom.window.getSelection()!; selection.addRange(range)
    const captured = selectedReadingRange(body, selection)
    assert.equal(captured.selection!.start.run, Number(repeated[1].dataset.readyReadingRun))
    assert.equal(readingExcerpt(markdown, captured.selection!), 'phrase')
    assert.equal(readingExcerpt(markdown, captured.paragraph!), 'Repeated phrase.')
    const paragraph = [...body.querySelectorAll('p')].find((p) => p.textContent?.startsWith('A & B'))!
    range.selectNodeContents(paragraph); selection.removeAllRanges(); selection.addRange(range)
    const whole = selectedReadingRange(body, selection)
    assert.equal(readingExcerpt(markdown, whole.selection!), 'A & B bold link\nnext inline code.')
    for (const element of body.querySelectorAll<HTMLElement>('[data-ready-reading-run]')) element.scrollIntoView = () => {}
    revealReadingRange(body, captured.selection!)
    assert.equal(selection.toString(), 'phrase')
    assert.equal(selection.anchorNode, repeated[1].firstChild)
  } finally { dom.window.close() }
})

test('Main and reference reads stay inside the selected text, reject stale versions and do not read or fetch the article', async () => {
  const db = new DatabaseManager(true)
  try {
    const source = db.rss.addRSSSource({ name: 'Source', url: 'https://example.test/feed' })
    db.rss.upsertRSSItems([{ id: 'quote', source_id: source, guid: 'quote', title: 'Quote', link: 'https://example.test/article', summary: 'Only summary' }])
    const value = `# Header\n\n${'selected 😀 text '.repeat(1600)}\n\nDO NOT INCLUDE THIS PARAGRAPH`
    db.rss.content.finishLoad(db.rss.content.beginLoad('quote')!, { status: 'ready', markdown: value, sourceUrl: 'https://example.test/article' })
    const article = db.rss.content.getArticle('quote')!, selected = readingRuns(value)[1]
    const read = RSSReadExcerptSchema.parse({ format: 'reading-v1', itemId: 'quote', expectedRevision: article.revision,
      range: { start: { run: selected.id, offset: 0 }, end: { run: selected.id, offset: selected.text.length } }, length: 111 })
    let offset: number | null = 0, text = ''
    while (offset !== null) { const part = db.rss.content.readExcerpt({ ...read, offset }); text += part.text; offset = part.nextOffset; assert.doesNotMatch(part.text, /[\uD800-\uDBFF]$/) }
    assert.equal(text, selected.text); assert.doesNotMatch(text, /DO NOT INCLUDE/)
    db.rss.events.move({ itemId: 'quote', expectedArticleRevision: article.revision, expectedMembershipRevision: 0, targetEventId: null, quote: 'DO NOT INCLUDE THIS PARAGRAPH' })
    const id = '11111111-1111-4111-8111-111111111111'
    const reference = RSSReferenceSchema.parse({ kind: 'excerpt', read })
    const context = { getContent: () => db.rss.content, references: [{ id, name: 'Selected text', reference }] }
    const result = JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: id }, context))
    assert.equal('summary' in result.data.article, false); assert.equal('event' in result.data.article, false); assert.equal('classifications' in result.data.article, false)
    assert.doesNotMatch(JSON.stringify(result), /DO NOT INCLUDE|Only summary/)
    assert.equal(result.ok, true); assert.equal(result.data.totalLength, selected.text.length)
    assert.deepEqual(parseRSSCitationUrl(result.citationUrl), reference)
    assert.equal(db.rss.content.getArticle('quote')!.read, false)
    const invalid = JSON.parse(await executeRSSTool('rss_read_reference', { referenceId: id, offset: selected.text.length + 1 }, context))
    assert.equal(invalid.ok, false)
    const denied = JSON.parse(await executeRSSTool('rss_read_excerpt', read, { ...context, readAccessDenied: true })); assert.equal(denied.ok, false)
    db.rss.content.finishLoad(db.rss.content.beginLoad('quote')!, { status: 'ready', markdown: 'Changed body', sourceUrl: 'https://example.test/article' })
    assert.throws(() => db.rss.content.readExcerpt(read), /article_changed/)
  } finally { db.close() }
})

test('invalid reading anchors and Unicode boundaries fail rather than matching another occurrence', () => {
  const value = '😀 word', run = readingRuns(value)[0]
  assert.throws(() => readingExcerpt(value, { start: { run: run.id, offset: 1 }, end: { run: run.id, offset: 3 } }), /surrogate/)
  assert.throws(() => readingExcerpt(value, { start: { run: 999, offset: 0 }, end: { run: run.id, offset: 3 } }), /unavailable/)
  assert.throws(() => readingExcerpt(value, { start: { run: run.id, offset: 0 }, end: { run: run.id, offset: 99 } }), /range/)
  assert.equal(RSSReferenceSchema.safeParse({ kind: 'excerpt', read: { format: 'reading-v2', itemId: 'x', expectedRevision: 'x', range: {} } }).success, false)
})

test('only valid internal citation URLs become navigation controls; source Markdown never gains that capability', () => {
  const reference = RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'id(quoted)', expectedRevision: 'v1' } })
  if (reference.kind !== 'article') throw new Error('wrong reference')
  const url = rssCitationUrl(reference)
  assert.deepEqual(parseRSSCitationUrl(url), reference)
  const callback = () => {}
  assert.match(renderToStaticMarkup(<>{renderInline(`[Source](${url})`, callback)}</>), /rss-citation-link/)
  assert.doesNotMatch(renderToStaticMarkup(<>{renderInline('[Fake](ready-rss://reference?data=broken)', callback)}</>), /<button|<a/)
  assert.doesNotMatch(renderToStaticMarkup(<MarkdownContent readingAnchors content={`[Fake](${url})`} externalBaseUrl="https://example.test" onOpenLink={() => {}} />), /href=|<button/)
})


test('reading-v1 keeps previously saved entity and emphasis coordinates stable', () => {
  const source = 'Start &amp; **bold** end.'
  assert.deepEqual(readingRuns(source), [
    { id: 0, block: 0, text: 'Start & ' }, { id: 14, block: 0, text: 'bold' }, { id: 20, block: 0, text: ' end.' },
  ])
  assert.equal(readingExcerpt(source, { start: { run: 0, offset: 6 }, end: { run: 14, offset: 2 } }), '& bo')
  const literal = 'a <b>b</b>.', runs = readingRuns(literal)
  assert.ok(runs.every((run) => run.block === 0), 'inert inline HTML stays in its paragraph')
  assert.equal(readingExcerpt(literal, { start: { run: 0, offset: 0 }, end: { run: runs.at(-1)!.id, offset: runs.at(-1)!.text.length } }), literal)
})
