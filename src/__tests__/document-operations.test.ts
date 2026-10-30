import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDocumentOperation } from '../shared/document-operations'

test('frontmatter edits preserve BOM, CRLF, comments, untouched fields and body bytes', () => {
  const before = '\uFEFF---\r\n# header\r\ntitle: \'Keep\' # untouched\r\ndate: old # date\r\nlist: [a, b]\r\n---\r\n\r\n正文  \r\n'
  const operation = { type: 'setFrontmatterFields' as const, set: { date: 'new' } }
  const after = applyDocumentOperation(before, operation)
  assert.equal(after, before.replace('date: old', 'date: new'))
  assert.equal(applyDocumentOperation(before, operation), after)
  assert.equal(applyDocumentOperation(after, operation), after)
})

test('frontmatter can be added and fields removed without rebuilding other bytes', () => {
  assert.equal(applyDocumentOperation('\uFEFFbody\r\n', { type: 'setFrontmatterFields', set: { date: 'today' } }), '\uFEFF---\r\ndate: today\r\n---\r\nbody\r\n')
  assert.equal(applyDocumentOperation('---\n# stay\na: 1\nb: 2 # stay\n---\nbody', { type: 'setFrontmatterFields', set: {}, remove: ['a'] }), '---\n# stay\nb: 2 # stay\n---\nbody')
})

test('append targets a heading section, ignores code fences, and falls back to EOF', () => {
  const source = '# A\n\nfirst\n## child\nchild body\n# B\nlast\n'
  assert.equal(applyDocumentOperation(source, { type: 'appendBlock', underHeading: 'A', markdown: 'added' }), '# A\n\nfirst\n## child\nchild body\n\nadded\n\n# B\nlast\n')
  assert.equal(applyDocumentOperation('```\n# A\n```\n', { type: 'appendBlock', underHeading: 'A', markdown: 'added' }), '```\n# A\n```\n\nadded\n')
})

test('replaceRange rejects stale text and invalid offsets instead of guessing', () => {
  const operation = { type: 'replaceRange' as const, start: 1, end: 3, expectedText: 'bc', replacement: 'XY' }
  assert.equal(applyDocumentOperation('abcd', operation), 'aXYd')
  assert.throws(() => applyDocumentOperation('abXd', operation), /expectedText/)
  assert.throws(() => applyDocumentOperation('abcd', { ...operation, start: -1 }), /range/)
})

test('block collections and multiline scalars are replaced without joining the following field', () => {
  const source = '---\ntags:\n  - old\n  - obsolete\n# next comment\ntitle: untouched\n---\nbody'
  assert.equal(applyDocumentOperation(source, { type: 'setFrontmatterFields', set: { tags: ['new'] } }), '---\ntags:\n  - new\n# next comment\ntitle: untouched\n---\nbody')
  assert.equal(applyDocumentOperation('---\nsummary: |\n  old text\ntitle: keep\n---\nbody', { type: 'setFrontmatterFields', set: { summary: 'new' } }), '---\nsummary: new\ntitle: keep\n---\nbody')
})

test('Tag Forge preserves raw punctuation, BOM, widgets and CRLF outside its fields', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { writeControlledTags, revisionOf } = await import('../main/modules/tag-forge/tag-forge-writer')
  const root = await mkdtemp(join(tmpdir(), 'tag-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'note.md')
  const body = '# 原文\r\n\r\n全角，标点。\r\n```show-widget\r\n{"title":"卡片"}\r\n```\r\n'
  const before = '\uFEFF---\r\n# comment\r\ntitle: untouched\r\n---\r\n' + body
  await writeFile(path, before)
  const result = await writeControlledTags({ path, workspaceRoot: root, expectedRevision: revisionOf(before), selectedTags: [], previousAutomaticLabels: [], suppressedAutomaticLabels: [], defaultWorkflowState: '待整理' })
  assert.equal(result.content.endsWith(body), true)
  assert.equal(result.content.startsWith('\uFEFF---\r\n# comment\r\ntitle: untouched\r\n'), true)
  assert.equal(await readFile(path, 'utf8'), result.content)
})

test('replaceRanges is version-bound and atomic, with explicit range failures', () => {
  const content = '甲😀乙\r\n尾'
  const operation = { type: 'replaceRanges' as const, expectedVersion: 3, ranges: [
    { start: 0, end: 1, expectedText: '甲', replacement: '新' },
    { start: 6, end: 7, expectedText: '尾', replacement: '末' },
  ] }
  assert.equal(applyDocumentOperation(content, operation, 3), '新😀乙\r\n末')
  assert.throws(() => applyDocumentOperation(content, operation, 4), { code: 'version_conflict' })
  assert.throws(() => applyDocumentOperation(content, operation), { code: 'version_conflict' })
  for (const [ranges, code] of [
    [[operation.ranges[0], { ...operation.ranges[1], expectedText: '错' }], 'stale_range'],
    [[{ start: -1, end: 1, expectedText: '', replacement: '' }], 'invalid_range'],
    [[{ start: 1, end: 2, expectedText: '\ud83d', replacement: '' }], 'split_surrogate'],
    [[{ start: 0, end: 3, expectedText: '甲😀', replacement: '' }, { start: 1, end: 3, expectedText: '😀', replacement: '' }], 'overlapping_ranges'],
    [[{ start: 0, end: 0, expectedText: '', replacement: 'a' }, { start: 0, end: 0, expectedText: '', replacement: 'b' }], 'overlapping_ranges'],
  ] as const) {
    assert.throws(() => applyDocumentOperation(content, { ...operation, ranges: [...ranges] }, 3), { code })
    assert.equal(content, '甲😀乙\r\n尾')
  }
})
