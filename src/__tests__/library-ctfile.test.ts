import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { epubFromZip } from '../main/modules/library-engine/sources/ctfile-archive'
import { downloadCtfile, parseLink } from '../main/modules/library-engine/sources/ctfile'

test('C11 range reader selects EPUB and never requests the other formats payload', async () => {
  const zip = new JSZip(); zip.file('book.epub', 'EPUB content'); zip.file('book.mobi', Buffer.alloc(300000, 3))
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  const ranges: [number, number][] = []
  const result = await epubFromZip({ size: bytes.length, read: async (a, b) => { ranges.push([a, b]); return bytes.subarray(a, b + 1) } })
  assert.equal(result.name, 'book.epub'); assert.equal(result.bytes.toString(), 'EPUB content')
  assert.ok(ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0) < bytes.length / 3)
  const noEpub = new JSZip(); noEpub.file('book.mobi', 'not epub')
  const other = await noEpub.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(epubFromZip({ size: other.length, read: async (a, b) => other.subarray(a, b + 1) }), /没有 EPUB/)
  assert.throws(() => parseLink('https://ctfile.com.evil.example/f/book'))
})

test('C11 share workflow sends only the human answer, waits, downloads EPUB and reports errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ctfile-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const zip = new JSZip(); zip.file('book.epub', 'epub bytes')
  const archive = await zip.generateAsync({ type: 'nodebuffer' })
  let requests = 0, answers = 0
  const messages: string[] = []
  const request: typeof fetch = async (input, options) => {
    const url = String(input)
    if (url.includes('/resource?')) return Response.json({ code: 200, data: { file: { file_name: 'book.zip', file_size_bytes: archive.length, file_id: '1', userid: '2', file_chk: 'check' } } })
    if (url.endsWith('/download')) {
      requests++
      if (requests === 1) return Response.json({ code: 218, data: { remaining_seconds: 1 } })
      if (requests === 2) return Response.json({ code: 217 })
      const body = JSON.parse(String(options?.body)); assert.equal(body.captcha_answer, 'HUMAN'); assert.equal(body.challenge, 'challenge')
      return Response.json({ code: 200, data: { downurl: 'https://download.ctfile.com/book.zip' } })
    }
    if (url.includes('/captcha?')) return Response.json({ code: 200, data: { challenge: 'challenge', image_url: 'https://urlapi.ctfile.com/image' } })
    if (url.endsWith('/image')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    const range = new Headers(options?.headers).get('range')?.match(/bytes=(\d+)-(\d+)/); assert.ok(range)
    const a = Number(range[1]), b = Number(range[2])
    return new Response(new Uint8Array(archive.subarray(a, b + 1)), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${archive.length}` } })
  }
  const file = await downloadCtfile('https://url89.ctfile.com/f/book?p=123', dir, new AbortController().signal, {
    progress: (_n, message) => { if (message) messages.push(message) }, extracting: () => {}, captcha: async image => { assert.match(image, /^data:image\/png;base64,/); answers++; return 'HUMAN' },
  }, request)
  assert.equal(answers, 1); assert.ok(messages.some(m => m.includes('等 1 秒')))
  assert.equal(await readFile(file, 'utf8'), 'epub bytes')
})

test('C11 non-ZIP archives use the system bsdtar and extract only the EPUB to memory', async t => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { writeFile, mkdir, readdir } = await import('node:fs/promises')
  const { epubFromArchive } = await import('../main/modules/library-engine/sources/ctfile-archive')
  const dir = await mkdtemp(join(tmpdir(), 'ready-archive-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const contents = join(dir, 'contents'); await mkdir(contents)
  await writeFile(join(contents, 'book.epub'), 'selected epub'); await writeFile(join(contents, 'book.mobi'), 'do not extract')
  const tar = process.platform === 'darwin' ? '/usr/bin/tar' : process.platform === 'win32' ? 'tar.exe' : 'bsdtar'
  const archive = join(dir, 'fixture.tar')
  await promisify(execFile)(tar, ['-cf', archive, '-C', contents, 'book.epub', 'book.mobi'])
  const work = join(dir, 'work'); await mkdir(work)
  const result = await epubFromArchive(await readFile(archive), work, new AbortController().signal)
  assert.equal(result.name, 'book.epub'); assert.equal(result.bytes.toString(), 'selected epub')
  assert.deepEqual(await readdir(work), ['download.archive'])
})
