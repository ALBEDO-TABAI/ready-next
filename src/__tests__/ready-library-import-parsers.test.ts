import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { parseNotion } from '../main/modules/document-import/notion'
import { parseInkwell } from '../main/modules/document-import/inkwell'
import { readZip } from '../main/modules/document-import/zip'
import { notionFixture, inkwellFixture } from './fixtures/document-import/sources'

test('DB6 Notion: hierarchy, Markdown, CSV identity, duplicate names, media and explicit gaps', async () => {
  const plan = parseNotion(await notionFixture())
  assert.equal(plan.pages.length, 7); assert.equal(plan.assets.length, 1)
  const home = plan.pages.find(page => page.path === '首页.md')!
  assert.match(home.body, /> 💡 提醒\n> 第二行/); assert.match(home.body, /- \*\*展开\*\*\n {2}隐藏内容/)
  assert.match(home.body, /\| 1 \| 2 \|/); assert.match(home.body, /```md\n\[不转换\]\(missing.md\)/)
  assert.match(home.body, /\[\[\.\/首页\/子页\|子页\]\]/)
  assert.ok(plan.pages.some(page => page.path === '首页/子页.md'))
  assert.equal(plan.pages.filter(page => page.title === '同名').length, 2)
  const row = plan.pages.find(page => page.title === '事项')!
  assert.equal(row.values.import_1, '00123'); assert.equal(row.values.import_2, '逗号,换行\n第二行'); assert.match(row.body, /行页面正文/)
  assert.ok(plan.issues.some(issue => issue.message.includes('missing.png')))
  assert.ok(plan.issues.some(issue => issue.message.includes('字段类型')))
})

test('DB6 Inkwell: actual backup shape, blocks, all view types, typed fields and embedded attachments', () => {
  const source = Buffer.from(JSON.stringify(inkwellFixture())), plan = parseInkwell(source, '/tmp/workspace-backup.json')
  assert.equal(plan.pages.length, 4); assert.equal(plan.issues.length, 0, JSON.stringify(plan.issues))
  const database = plan.pages.find(page => page.database)!, row = plan.pages.find(page => page.row)!
  assert.deepEqual(database.database!.views.map(view => view.type), ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'])
  assert.equal(database.database!.views[0].filters![0].value, false)
  assert.equal(database.database!.fields.import_status.type, 'select'); assert.equal(row.values.import_n, 12); assert.equal(row.values.import_done, false); assert.equal(row.values.import_phone, '00123')
  assert.deepEqual(row.values.import_tags, ['甲', '乙']); assert.equal(row.values.import_created, '2023-11-14T22:13:20.000Z'); assert.deepEqual(row.values.import_date, { start: '2026-10-30', end: '2026-10-31' })
  const home = plan.pages.find(page => page.title === '首页')!
  assert.match(home.body, /> 提醒/); assert.match(home.body, / {2}子内容/); assert.match(home.body, /const x = 1/); assert.match(home.body, /\| 甲 \| 乙 \|/)
  assert.equal(plan.assets[0].path, '首页.assets/image.png')
  assert.match(plan.pages.find(page => page.title === '子页')!.body, /\[\[\.\.\/首页\|首页\]\]/)
})

test('DB6 ZIP refuses traversal, symlinks, duplicate names, oversized expansion and corrupt bytes', async () => {
  for (const name of ['../escape.md', '/escape.md', 'C:/escape.md', 'a/../../escape.md', 'a\\escape.md']) {
    const zip = new JSZip(); zip.file(name, '# unsafe')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }); assert.throws(() => readZip(bytes), /Unsafe/)
  }
  const zip = new JSZip(); zip.file('link', 'target', { unixPermissions: 0xa1ff })
  assert.throws(() => readZip(Buffer.from('invalid')))
  const link = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }); assert.throws(() => readZip(link), /Unsafe/)
  const bomb = new JSZip(); bomb.file('bomb.md', 'a'.repeat(500000)); const compressed = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); assert.throws(() => readZip(compressed), /limit/)
  const duplicate = new JSZip(); duplicate.file('A.md', 'a'); duplicate.file('a.md', 'b'); const duplicates = await duplicate.generateAsync({ type: 'nodebuffer' }); assert.throws(() => readZip(duplicates), /Unsafe/)
  const bad = await notionFixture(); bad[50] ^= 1; assert.throws(() => readZip(bad))
})


test('DB6 Inkwell unsupported behavior and missing blocks are enumerated, internal application links are rewritten', () => {
  const backup = inkwellFixture()
  backup.blocks.push({ id: 'broken', type: 'embed', parent: 'home', parentTable: 'block', title: [['保留文字']], content: [], props: {}, alive: true, created: 1, edited: 1 })
  backup.blocks.find(block => block.id === 'home')!.content.push('broken', 'missing-block')
  const link = backup.blocks.find(block => block.id === 'link')!
  const raw = JSON.parse(JSON.stringify(backup))
  raw.blocks.find((block: { id: string }) => block.id === link.id).title = [['返回', { link: 'inkwell://page/home' }]]
  const plan = parseInkwell(Buffer.from(JSON.stringify(raw)), '/tmp/source.json')
  assert.ok(plan.issues.some(issue => issue.message.includes('embed')))
  assert.ok(plan.issues.some(issue => issue.message.includes('missing-block')))
  assert.match(plan.pages.find(page => page.title === '首页')!.body, /保留文字/)
  assert.match(plan.pages.find(page => page.title === '子页')!.body, /\[\[\.\.\/首页\|返回\]\]/)
})

test('DB6 Notion preserves directory-only ancestors and attachment bytes without inventing missing page content', async () => {
  const zip = new JSZip(); zip.file('导出目录/页面.md', '# 正文'); zip.file('导出目录/file.bin', Buffer.from([0, 255, 16]))
  const plan = parseNotion(await zip.generateAsync({ type: 'nodebuffer' }))
  assert.ok(plan.pages.some(page => page.path === '导出目录.md'))
  assert.ok(plan.pages.some(page => page.path === '导出目录/页面.md'))
  assert.ok(plan.issues.some(issue => issue.message.includes('没有父页面正文')))
  assert.deepEqual(Buffer.from(plan.assets[0].data, 'base64'), Buffer.from([0, 255, 16]))
})

test('DB6 Inkwell rejects multiply-owned block trees before recursive expansion', () => {
  const backup = inkwellFixture()
  backup.blocks.find(block => block.id === 'toggle')!.content.push('heading')
  assert.throws(() => parseInkwell(Buffer.from(JSON.stringify(backup)), '/tmp/source.json'), /ownership/)
})
