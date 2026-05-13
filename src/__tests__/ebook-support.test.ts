import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import JSZip from 'jszip'

import { BINARY_EXTENSIONS } from '../main/modules/document-engine/binary-extensions'
import { decideFileForIndex } from '../main/modules/search-engine/adapters'
import { importEpubAsMarkdown } from '../main/modules/document-engine/ebook-importer'
import { toLocalFileUrl } from '../renderer/utils/dragDrop'

async function writeMinimalEpub(path: string, options?: { unsafe?: boolean; image?: boolean; footnote?: boolean }): Promise<void> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Minimal Book</dc:title>
  </metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    ${options?.image ? '<item id="cover" href="cover.png" media-type="image/png"/>' : ''}
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`)
  zip.file('OEBPS/chapter.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>
    <h1>Hello</h1>
    <p>Readable text.</p>
    ${options?.image ? '<p><img src="cover.png" alt="Cover"/></p>' : ''}
    ${options?.footnote ? '<p>Claim<a epub:type="noteref" href="#fn1">1</a></p><aside epub:type="footnote" id="fn1"><p>Footnote text.</p></aside>' : ''}
    ${options?.unsafe ? '<script>globalThis.__readyEbookUnsafe = true</script><p><a href=javascript:alert(1) onclick=alert(2)>bad</a><img src=javascript:alert(3) onerror=alert(4) /></p>' : ''}
  </body>
</html>`)
  if (options?.image) {
    zip.file('OEBPS/cover.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' })
  await writeFile(path, buffer)
}

test('ebook extensions are binary so indexing skips them', async () => {
  for (const ext of ['.epub', '.mobi', '.azw', '.azw3', '.fb2', '.cbz']) {
    assert.equal(BINARY_EXTENSIONS.has(ext), true, `${ext} should be binary`)
    const decision = await decideFileForIndex(`/Users/alice/Documents/projects/book${ext}`, {
      size: 1024,
      isFile: () => true,
    })
    assert.deepEqual(decision, { accept: false, reason: 'binary_ext' })
  }
})

test('local-file URL helper keeps macOS absolute paths as pathnames', () => {
  const url = toLocalFileUrl('/Users/user/实验田/测试/book #1.epub')
  assert.equal(url, 'local-file:///Users/user/%E5%AE%9E%E9%AA%8C%E7%94%B0/%E6%B5%8B%E8%AF%95/book%20%231.epub')
  const parsed = new URL(url)
  assert.equal(parsed.host, '')
  assert.equal(decodeURIComponent(parsed.pathname), '/Users/user/实验田/测试/book #1.epub')
})

test('renderer CSP allows ebook preview resource loading paths', async () => {
  const html = await readFile(new URL('../renderer/index.html', import.meta.url), 'utf-8')
  const csp = html.match(/Content-Security-Policy[\s\S]*?content=\"([^\"]+)\"/)?.[1] || ''
  assert.match(csp, /connect-src[^;]*local-file:/)
  assert.match(csp, /style-src[^;]*blob:/)
  assert.match(csp, /img-src[^;]*blob:/)
})

test('importEpubAsMarkdown writes index.md and assets without overwriting existing import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-import-'))
  try {
    const epubPath = join(dir, 'Minimal Book.epub')
    await writeMinimalEpub(epubPath, { image: true })

    const first = await importEpubAsMarkdown(epubPath)
    assert.equal(first.success, true, first.error)
    assert.ok(first.outputDir)
    assert.ok(first.indexPath)
    assert.equal(first.assetCount, 1)
    assert.equal(existsSync(join(first.outputDir!, 'assets', 'cover.png')), true)
    const markdown = await readFile(first.indexPath!, 'utf-8')
    assert.match(markdown, /^# Minimal Book/m)
    assert.match(markdown, /Readable text\./)
    assert.match(markdown, /assets\/cover\.png/)

    const second = await importEpubAsMarkdown(epubPath)
    assert.equal(second.success, true, second.error)
    assert.notEqual(second.outputDir, first.outputDir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('importEpubAsMarkdown strips scripts and javascript links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-unsafe-'))
  try {
    const epubPath = join(dir, 'Unsafe.epub')
    await writeMinimalEpub(epubPath, { unsafe: true })
    const result = await importEpubAsMarkdown(epubPath)
    assert.equal(result.success, true, result.error)
    const markdown = await readFile(result.indexPath!, 'utf-8')
    assert.doesNotMatch(markdown, /__readyEbookUnsafe/)
    assert.doesNotMatch(markdown, /javascript:/)
    assert.doesNotMatch(markdown, /onclick/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('importEpubAsMarkdown converts EPUB footnotes to markdown notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-footnote-'))
  try {
    const epubPath = join(dir, 'Footnote.epub')
    await writeMinimalEpub(epubPath, { footnote: true })
    const result = await importEpubAsMarkdown(epubPath)
    assert.equal(result.success, true, result.error)
    const markdown = await readFile(result.indexPath!, 'utf-8')
    assert.match(markdown, /Claim\[\^1\]/)
    assert.match(markdown, /\[\^1\]: Footnote text\./)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('importEpubAsMarkdown rejects non-EPUB formats', async () => {
  const result = await importEpubAsMarkdown('/Users/alice/Documents/projects/book.mobi')
  assert.equal(result.success, false)
  assert.equal(result.errorCode, 'UNSUPPORTED_EBOOK_IMPORT')
})
