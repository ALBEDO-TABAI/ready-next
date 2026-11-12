// Electron Node mode only (tsx), against the explicitly supplied throwaway profile of verify-ready-next-capture.cjs.
// Seed:     node seed.cjs <profile>                            — a 资讯 article with a saved body (opening it fetches
//                                                               nothing) and a cached image card.
// Readback: node seed.cjs <profile> <expectations.json> <vault> — every capture's content and source, read from
//                                                               ready.db and from disk with the app's own ReadyRef encoding.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const { RSSStore } = require('../../src/main/modules/database/rss-store.ts')
const { RSSContentStore } = require('../../src/main/modules/database/rss-content-store.ts')
const { RSSOrganizationStore } = require('../../src/main/modules/database/rss-organization-store.ts')
const { toReadyUri } = require('../../src/shared/ready-ref.ts')
const { readDocumentSource } = require('../../src/shared/document-operations.ts')

const profile = process.argv[2]
if (!profile || !path.basename(path.dirname(profile)).startsWith('w6c-')) throw new Error('Expected capture test profile')
const ARTICLE_BODY = '资讯正文的第一段：一个好的筛子，应该先理解你在做什么。\n\n资讯正文的第二段：再决定把什么放到你面前。'
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sha256 = createHash('sha256').update(bytes).digest('hex'), key = sha256 + '.png'

function seed(db) {
  const rss = new RSSStore(() => db)
  const source = rss.addRSSSource({ name: '收下验收资讯', url: 'https://example.invalid/feed' })
  db.prepare('UPDATE rss_sources SET enabled=0 WHERE id=?').run(source)
  rss.upsertRSSItems([{ id: 'capture-article', source_id: source, guid: 'capture-article', title: '资讯文章', link: 'https://example.invalid/article', summary: '资讯文章的摘要：先理解你在做什么。' }])
  // A saved body, as after a real fetch: the reader opens it without going to the network.
  const content = new RSSContentStore(() => db, new RSSOrganizationStore(() => db, () => null))
  const claim = content.beginLoad('capture-article')
  if (!claim || !content.finishLoad(claim, { status: 'ready', markdown: ARTICLE_BODY, sourceUrl: 'https://example.invalid/article' })) throw new Error('article body seed failed')
  fs.mkdirSync(path.join(profile, 'fastcard-media'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'fastcard-media', key), bytes)
  db.prepare('INSERT INTO fastcard_items(id,payload_json,position) VALUES(?,?,?)').run('fixture-image', JSON.stringify({
    id: 'fixture-image', kind: 'image', createdAt: 1, title: '验收图片', media: { status: 'cached', key, sha256, mime: 'image/png', bytes: bytes.length },
  }), 1)
}

const matches = (uri, expected) => expected.uri ? uri === expected.uri : uri.startsWith(expected.uriPrefix)
function readback(db, expectations, vault) {
  const cards = db.prepare('SELECT id, payload_json FROM fastcard_items').all().map(row => JSON.parse(row.payload_json))
  const read = file => fs.readFileSync(path.join(vault, file), 'utf8')
  const failures = [], passes = []
  for (const expected of expectations) {
    let ok = false, detail = ''
    if (expected.where === 'fastcard') {
      const card = cards.find(card => card.text === expected.text)
      ok = Boolean(card?.source?.ref && matches(toReadyUri(card.source.ref), expected))
      detail = card ? `source ${card.source?.ref ? toReadyUri(card.source.ref) : 'missing'}` : 'card missing'
    } else if (expected.where === 'canvas') {
      const canvas = JSON.parse(read(expected.file))
      const node = canvas.nodes.find(node => expected.text ? node.text === expected.text
        : node.ready?.ref?.id === expected.refId || (node.ready?.sources ?? []).some(source => source.uri.includes(expected.refId)))
      const uris = (node?.ready?.sources ?? []).map(source => source.uri).concat(node?.ready?.ref ? [toReadyUri(node.ready.ref)] : [])
      ok = Boolean(node && uris.some(uri => matches(uri, expected)))
      detail = node ? `sources ${uris.join(' ')}` : 'node missing'
    } else if (expected.where === 'document') {
      const text = read(expected.file)
      const links = [...text.matchAll(/\]\(<?(ready:\/\/[^)>\s]+)>?\)/g)].map(match => match[1].replaceAll('&#x26;', '&'))
      ok = (!expected.text || text.includes(`> ${expected.text}`)) && links.some(uri => matches(uri, expected))
      detail = `links ${links.join(' ')}`
    } else if (expected.where === 'page') {
      const source = readDocumentSource(read(expected.file))
      ok = source.frontmatter.ready_source === expected.uri && source.body.includes(expected.text)
      detail = `ready_source ${source.frontmatter.ready_source}`
    }
    ;(ok ? passes : failures).push(`${expected.cell} → ${expected.where}${ok ? '' : ` (${detail})`}`)
  }
  for (const line of passes) console.log(`READBACK ${line}`)
  if (failures.length) throw new Error(`Readback failed:\n${failures.join('\n')}`)
}

const db = new Database(path.join(profile, 'ready.db'))
try {
  if (process.argv[3]) readback(db, JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), process.argv[4])
  else seed(db)
} finally { db.close() }
