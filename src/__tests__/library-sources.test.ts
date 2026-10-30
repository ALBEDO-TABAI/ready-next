import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZlibSource } from '../main/modules/library-engine/sources/zlib'
import { TreasureIndex } from '../main/modules/library-engine/sources/treasure'

test('C11 zlib uses JSON commands, explicit formats, download files and exit codes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-zlib-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bin = join(dir, 'fake-zlib')
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
if (!a.includes('--json')) process.exit(9);
if (a.includes('fail')) { console.error('network failed'); process.exit(4); }
if (a[0] === 'profile') console.log(JSON.stringify({loggedIn:true}));
if (a[0] === 'search') console.log(JSON.stringify({books:[{id:'1:hash',name:a[1],authors:['作者'],extension:a[a.indexOf('--ext')+1]}]}));
if (a[0] === 'download') { const p=path.join(a[a.indexOf('--dir')+1], 'book.txt'); fs.writeFileSync(p,'正文'); console.log(JSON.stringify({progress:100})); console.log(JSON.stringify({path:p})); }
`)
  await chmod(bin, 0o755)
  const source = new ZlibSource(bin)
  assert.equal((await source.status()).state, 'available')
  assert.equal((await new ZlibSource(join(dir, 'missing')).status()).state, 'missing')
  const hits = await source.search('山海', 'epub')
  assert.equal(hits[0].format, 'epub')
  assert.equal(hits[0].ref, '1:hash')
  assert.equal((await source.search('山海', 'pdf'))[0].format, 'pdf')
  assert.equal(await readFile(await source.download('1:hash', dir, new AbortController().signal), 'utf8'), '正文')
  await assert.rejects(source.search('fail', 'epub'), /network failed|退出码 4/)
  await assert.rejects(source.download('fail', dir, new AbortController().signal), /network failed|退出码 4/)
  await writeFile(bin, '#!/usr/bin/env node\nprocess.exit(3)\n')
  assert.equal((await source.status()).state, 'logged_out')
})

test('C11 treasure searches a local index, merges categories and normalizes width', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-treasure-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'treasure-all-books.json'), JSON.stringify([
    { title: 'ＡＢＣ 山海', author: '甲', category: '文学', link: 'https://url89.ctfile.com/f/one' },
    { title: 'ＡＢＣ 山海', author: '甲', category: '小说', link: 'https://url89.ctfile.com/f/one' },
    { title: '星空', author: '乙', category: '科普', link: 'https://url89.ctfile.com/f/two' },
  ]))
  const index = new TreasureIndex(dir, async () => { throw new Error('must not fetch fixture') })
  assert.equal((await index.search('abc 甲', '')).length, 1)
  assert.equal((await index.search('', '科普'))[0].title, '星空')
  assert.deepEqual((await index.categories()).sort(), ['小说', '文学', '科普'])
})
