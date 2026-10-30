import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReadyUri, toReadyUri } from '../shared/ready-ref'
import { RSSReferenceSchema, rssReferencePath, parseRSSCitationUrl, rssReferenceFromReadyRef } from '../shared/rss-reference'

const references = [
  { kind: 'article', read: { itemId: '文章/?', expectedRevision: 'v1', offset: 12, length: 100 } },
  { kind: 'excerpt', read: { itemId: '文章/?', expectedRevision: 'v1', format: 'reading-v1', range: { start: { run: 10, offset: 2 }, end: { run: 10, offset: 8 } }, offset: 1, length: 3 } },
  { kind: 'digest', read: { reportId: "report/(1)'", offset: 10, limit: 2 } },
  { kind: 'query', query: { scope: 'library', filter: 'starred', collectionId: 'collection', sourceId: 'source', from: 10, until: 20, expectedRevision: 3 } },
]

test('C1 R45 RSS navigation preserves versions, exact ranges, digest pages and complete query scope', () => {
  for (const input of references) {
    const reference = RSSReferenceSchema.parse(input)
    const uri = rssReferencePath(reference)
    assert.match(uri, /^ready:\/\/rss\//)
    const parsed = parseReadyUri(uri)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) throw new Error('invalid reference')
    assert.equal(toReadyUri(parsed.ref), uri)
    assert.deepEqual(rssReferenceFromReadyRef(parsed.ref), reference)
    if (reference.kind !== 'query') assert.deepEqual(parseRSSCitationUrl(uri), reference)
  }
  assert.equal(parseRSSCitationUrl('ready-rss://reference?data=broken'), null)
  assert.equal(parseRSSCitationUrl('ready://rss/item/id'), null, 'plain navigation has no frozen reading scope')
})

test('C1 R45 rejects conflicting or incomplete RSS scope instead of silently widening it', () => {
  for (const uri of [
    'ready://rss/item/id?excerpt=%7B%7D',
    'ready://rss/item/id?article=%7B%7D',
    'ready://rss/digest/id?offset=-1&limit=2',
    'ready://rss/query?query=%7B%7D',
  ]) assert.equal(parseReadyUri(uri).ok, false, uri)
})

test('C1 R45 old protocols exist only in one-time migrations', async () => {
  // allow-source-grep: structural retirement gate, not a substitute for generator/navigation/migration behavior tests.
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await inspect(path)
      else if (/\.[cm]?[jt]sx?$/.test(path) && !/migration/.test(path)) {
        const source = await readFile(path, 'utf8')
        assert.doesNotMatch(source, /(?:browser-tab|doc-tab|document-quote|ready-rss|rss-reference|bookmark):(?:\/\/|['"])/, path)
      }
    }
  }
  const { fileURLToPath } = await import('node:url')
  await inspect(fileURLToPath(new URL('../', import.meta.url)))
})
