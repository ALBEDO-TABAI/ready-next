import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDocumentGraph, normalizeSearchText } from '../shared/document-graph-parse'

describe('shared document-graph-parse', () => {
  it('extracts hash tags, skips markdown headings, supports hierarchical tags', () => {
    const source = [
      '# Heading one',
      '#### fourth heading #shouldnot_match',
      '',
      'Body mentions #alpha and then #beta/gamma.',
      '句末 #中文标签 should still match.',
    ].join('\n')
    const result = parseDocumentGraph(source)
    assert.ok(result.tags.includes('alpha'))
    assert.ok(result.tags.includes('beta/gamma'))
    assert.ok(result.tags.includes('中文标签'))
    assert.ok(!result.tags.includes('shouldnot_match'), '#### heading must not leak tags')
  })

  it('ignores hash inside words', () => {
    const result = parseDocumentGraph('see http://example.com/page#section and ab#xy')
    assert.ok(!result.tags.includes('section'))
    assert.ok(!result.tags.includes('xy'))
  })

  it('parses wikilinks with anchor and alias', () => {
    const result = parseDocumentGraph('see [[foo]] and [[bar#intro|Alias Name]] and [[baz|display]].')
    const targets = result.wikilinks.map((ref) => ref.target)
    assert.deepEqual(targets, ['foo', 'bar', 'baz'])
    const bar = result.wikilinks.find((ref) => ref.target === 'bar')
    assert.equal(bar?.anchor, 'intro')
    assert.equal(bar?.alias, 'Alias Name')
  })

  it('parses markdown links and flags internal vs external', () => {
    const source = [
      'External: [site](https://example.com)',
      'Internal: [notes](./notes.md)',
      'Root abs: [readme](/readme.md)',
      'Hash anchor should be ignored: [here](#top)',
    ].join('\n')
    const result = parseDocumentGraph(source)
    const byUrl = new Map(result.mdlinks.map((link) => [link.url, link]))
    assert.equal(byUrl.get('https://example.com')?.internal, false)
    assert.equal(byUrl.get('./notes.md')?.internal, true)
    assert.equal(byUrl.get('/readme.md')?.internal, true)
    assert.equal(byUrl.get('#top')?.internal, false)
  })

  it('classifies image/video/audio attachments from markdown image syntax', () => {
    const source = [
      '![shot](./a.png)',
      '![clip](./b.mp4)',
      '![tune](./c.mp3)',
      '![pack](./d.zip)',
    ].join('\n')
    const result = parseDocumentGraph(source)
    const byRef = new Map(result.attachments.map((ref) => [ref.ref, ref.kind]))
    assert.equal(byRef.get('./a.png'), 'image')
    assert.equal(byRef.get('./b.mp4'), 'video')
    assert.equal(byRef.get('./c.mp3'), 'audio')
    assert.equal(byRef.get('./d.zip'), 'file')
  })

  it('promotes wikilink with binary extension to attachment', () => {
    const result = parseDocumentGraph('see [[diagram.png]] and [[notes]].')
    assert.deepEqual(
      result.attachments.map((ref) => ({ kind: ref.kind, ref: ref.ref })),
      [{ kind: 'image', ref: 'diagram.png' }],
    )
  })

  it('merges frontmatter tags into tag set', () => {
    const source = [
      '---',
      'title: My note',
      'tags:',
      '  - projectA',
      '  - research',
      '---',
      '',
      'Body #inline-tag.',
    ].join('\n')
    const result = parseDocumentGraph(source)
    assert.deepEqual(result.tags.slice(0, 2), ['projectA', 'research'])
    assert.ok(result.tags.includes('inline-tag'))
    assert.equal(result.frontmatter?.title, 'My note')
  })

  it('normalizes NFKC width variants and strips zero-width characters', () => {
    const source = [
      '＃ａｌｐｈａ in body.',
      'Also plain #alpha here.',
      'Zero​width​chars should not block #beta.',
    ].join('\n')
    const result = parseDocumentGraph(source)
    assert.ok(result.tags.includes('alpha'), 'fullwidth #alpha should normalize to #alpha')
    assert.ok(result.tags.includes('beta'))
    assert.ok(!result.body.includes('​'), 'zero-width characters should be stripped')
  })

  it('normalizeSearchText is idempotent with normalize', () => {
    assert.equal(normalizeSearchText('＃ａｂｃ'), '#abc')
    assert.equal(normalizeSearchText('hello​world'), 'helloworld')
  })

  it('appends widget text so fence content becomes searchable in body', () => {
    const source = [
      'Heading.',
      '',
      '```show-widget',
      '{"title":"秋日赛程","widget_code":"<div/>","component_spec":{"component":"info_card","props":{"headline":"Week 1 Kickoff","points":["battle on mid"]}}}',
      '```',
      '',
      'Trailing text.',
    ].join('\n')
    const result = parseDocumentGraph(source)
    assert.ok(result.widgetText.includes('秋日赛程'))
    assert.ok(result.widgetText.includes('Week 1 Kickoff'))
    assert.ok(result.widgetText.includes('battle on mid'))
    assert.ok(result.body.includes('秋日赛程'))
    assert.ok(!result.body.includes('```show-widget'), 'widget fence must be stripped from body')
  })

  it('does not lift tag-like strings from widget JSON into the tag list', () => {
    const source = [
      '```show-widget',
      '{"title":"note","widget_code":"<div/>","component_spec":{"component":"info_card","props":{"headline":"#fakeTag #notReal"}}}',
      '```',
      '',
      'Real body #real-tag.',
    ].join('\n')
    const result = parseDocumentGraph(source)
    assert.ok(result.tags.includes('real-tag'))
    assert.ok(!result.tags.includes('fakeTag'))
    assert.ok(!result.tags.includes('notReal'))
  })
})
