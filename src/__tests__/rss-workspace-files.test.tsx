import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DatabaseManager } from '../main/modules/database'
import { RSSWorkspaceFiles } from '../main/modules/rss-engine/workspace-files'
import { buildRSSNote } from '../shared/rss-note-markdown'
import { collectDocumentWidgets } from '../shared/document-widget-parse'
import NotePreview from '../renderer/components/document/NotePreview'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import type { RSSArticle } from '../shared/rss-workspace'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('saved source notes keep Markdown formatting but cannot activate widgets or local references', () => {
  const source = [
    '## Source heading', 'Text **emphasis**.', '| A | B |\n| - | - |\n| 1 | 2 |',
    '![safe](../photo.png)', '[Related](../related)', '![local](file:///private/example.png)',
    '![[/private/example.png]]', 'thumbnailurl: /private/example.png',
    '```show-widget\n{"widget_code":"<script>bad()</script>"}\n```',
    '{"widget_code":"<script>bare()</script>"}',
    '````markdown\n```show-widget\n{"widget_code":"<script>nested()</script>"}\n```\n````',
    '```mermaid\ngraph TD; A-->B\n```', '```mermaid:x\ngraph TD; A-->B\n```', '```mermaid-example\ngraph TD; A-->B\n```', '```markdown-example\n![local](/private/example.png)\n```', '<iframe src="file:///private/example.html"></iframe>',
  ].join('\n\n')
  const note = buildRSSNote({ title: 'Title', source: 'Source', link: 'https://example.test/news/a', revision: 'v1', summary: '', body: { status: 'ready', markdown: source, sourceUrl: 'https://example.test/news/a' } } as RSSArticle)
  assert.equal(collectDocumentWidgets(note).length, 0)
  const preview = buildStructuredNotePreview(note, '/notes/source.md')
  assert.equal(preview.widgets.length, 0)
  assert.ok(preview.embeds.every((embed) => embed.url.startsWith('https://')), JSON.stringify({ embeds: preview.embeds, note }))
  const html = renderToStaticMarkup(<NotePreview content={note} notePath="/notes/source.md" />)
  assert.match(html, /<strong>emphasis<\/strong>/)
  assert.match(html, /<table/)
  assert.doesNotMatch(html, /ready-rss-source/)
  assert.match(html, /https:\/\/example.test\/photo.png/)
  assert.doesNotMatch(html, /<iframe|<script|src="(?:file|local-file):|data-ready-mermaid="true"/)
})

test('note save never overwrites an existing file and rejects a changed source after choosing a folder', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS note save')) return
  const db = new DatabaseManager(true)
  const root = mkdtempSync(join(tmpdir(), 'rss-note-save-'))
  const source = db.rss.addRSSSource({ name: 'Source', url: 'https://example.test/feed' })
  const row = { id: 'a', source_id: source, guid: 'a', title: 'Title', link: 'https://example.test/a', summary: 'Summary only' }
  db.rss.upsertRSSItems([row])
  const files = new RSSWorkspaceFiles(db.rss.content)
  const input = { itemId: 'a', expectedRevision: db.rss.content.getArticle('a')!.revision }
  try {
    const one = await files.saveNote(input, async () => root)
    const two = await files.saveNote(input, async () => root)
    assert.ok(!one.canceled && !two.canceled)
    assert.notEqual(one.path, two.path)
    assert.match(readFileSync(one.path, 'utf8'), /来源摘要/)
    assert.equal(readFileSync(one.path, 'utf8'), readFileSync(two.path, 'utf8'))
    const before = readdirSync(root)
    await assert.rejects(files.saveNote(input, async () => { db.rss.upsertRSSItems([{ ...row, title: 'Changed' }]); return root }), /变化/)
    assert.deepEqual(readdirSync(root), before)
    assert.equal(db.rss.content.getArticle('a')!.body.markdown, null)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test('current-result export includes every matching page and no unrelated or dismissed item', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS current-result export')) return
  const db = new DatabaseManager(true)
  const root = mkdtempSync(join(tmpdir(), 'rss-query-export-'))
  const source = db.rss.addRSSSource({ name: 'Source', url: 'https://example.test/feed' })
  for (let i = 0; i < 135; i++) db.rss.upsertRSSItems([{ id: String(i), guid: String(i), source_id: source, title: 'match', link: `https://example.test/${i}` }])
  db.rss.upsertRSSItems([{ id: 'other', guid: 'other', source_id: source, title: 'other', link: 'https://example.test/other' }])
  db.rss.dismissRSSItemsFromInbox(['0'])
  const query = db.rss.content.query({ search: 'match', limit: 50 })
  try {
    const files = new RSSWorkspaceFiles(db.rss.content)
    const result = await files.exportQuery({ ...query.query, expectedRevision: query.revision }, async () => root)
    assert.ok(!result.canceled)
    assert.equal(result.total, 134)
    const saved = JSON.parse(readFileSync(result.path, 'utf8'))
    assert.equal(saved.articles.length, 134)
    assert.equal(new Set(saved.articles.map((item: { id: string }) => item.id)).size, 134)
    assert.equal(saved.articles.some((item: { id: string }) => item.id === '0' || item.id === 'other'), false)
    assert.deepEqual(saved.query, query.query)
    assert.equal(saved.revision, query.revision)
    assert.deepEqual(await files.exportQuery({ ...query.query, expectedRevision: query.revision }, async () => null), { canceled: true })
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})


test('save failures clean unconfirmed files and a revision change during disk IO cannot publish', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS file failure cleanup')) return
  const db = new DatabaseManager(true)
  const root = fs.realpathSync(mkdtempSync(join(tmpdir(), 'rss-note-failure-')))
  const source = db.rss.addRSSSource({ name: 'Source', url: 'https://example.test/feed' })
  const row = { id: 'a', source_id: source, guid: 'a', title: 'Title', link: 'https://example.test/a', summary: 'Summary' }
  db.rss.upsertRSSItems([row])
  const files = new RSSWorkspaceFiles(db.rss.content)
  const input = { itemId: 'a', expectedRevision: db.rss.content.getArticle('a')!.revision }
  const originalRead = fs.readFileSync
  const originalWrite = fsPromises.writeFile
  try {
    assert.deepEqual(await files.saveNote(input, async () => null), { canceled: true })
    t.mock.method(fs, 'readFileSync', function (path, ...args) {
      if (String(path).startsWith(root) && String(path).endsWith('.md')) throw Object.assign(new Error('synthetic readback EIO'), { code: 'EIO' })
      return Reflect.apply(originalRead, fs, [path, ...args])
    })
    syncBuiltinESMExports()
    await assert.rejects(files.saveNote(input, async () => root), /synthetic readback EIO/)
    assert.deepEqual(readdirSync(root), [])
    t.mock.restoreAll(); syncBuiltinESMExports()
    t.mock.method(fsPromises, 'writeFile', async function (...args) {
      await Reflect.apply(originalWrite, fsPromises, args)
      db.rss.upsertRSSItems([{ ...row, title: 'New revision' }])
    })
    syncBuiltinESMExports()
    await assert.rejects(files.saveNote(input, async () => root), /变化/)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports()
    db.close(); rmSync(root, { recursive: true, force: true })
  }
})
