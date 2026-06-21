import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import JSZip from 'jszip'

import { BINARY_EXTENSIONS } from '../main/modules/document-engine/binary-extensions'
import { decideFileForIndex } from '../main/modules/search-engine/adapters'
import { importEpubAsMarkdown } from '../main/modules/document-engine/ebook-importer'
import { toLocalFileUrl } from '../renderer/utils/dragDrop'
import { EBOOK_INLINE_IMAGE_TITLE, EBOOK_MARKDOWN_MARKER } from '../shared/ebook'

async function writeMinimalEpub(
  path: string,
  options?: { unsafe?: boolean; image?: boolean; inlineImage?: boolean; footnote?: boolean; title?: string | null },
): Promise<void> {
  const zip = new JSZip()
  const titleMarkup = options?.title === null
    ? ''
    : `<dc:title>${options?.title ?? 'Minimal Book'}</dc:title>`
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
    ${titleMarkup}
  </metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    ${options?.image ? '<item id="cover" href="cover.png" media-type="image/png"/>' : ''}
    ${options?.inlineImage ? '<item id="glyph" href="glyph.png" media-type="image/png"/>' : ''}
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
    ${options?.inlineImage ? '<p>Missing<img src="glyph.png"/>Glyph<img src="glyph.png"/>Done</p>' : ''}
    ${options?.footnote ? '<p>Claim<a epub:type="noteref" href="#fn1">1</a></p><aside epub:type="footnote" id="fn1"><p>Footnote text.</p></aside>' : ''}
    ${options?.unsafe ? '<script>globalThis.__readyEbookUnsafe = true</script><p><a href=javascript:alert(1) onclick=alert(2)>bad</a><img src=javascript:alert(3) onerror=alert(4) /></p>' : ''}
  </body>
</html>`)
  if (options?.image) {
    zip.file('OEBPS/cover.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  if (options?.inlineImage) {
    zip.file('OEBPS/glyph.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' })
  await writeFile(path, buffer)
}

async function writeTocEpub(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>层级书</dc:title>
  </metadata>
  <manifest>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="part2" href="Text/part0020.xhtml" media-type="application/xhtml+xml"/>
    <item id="part2-1" href="Text/part0021.xhtml" media-type="application/xhtml+xml"/>
    <item id="part2-2" href="Text/part0022.xhtml" media-type="application/xhtml+xml"/>
    <item id="part3" href="Text/part0030.xhtml" media-type="application/xhtml+xml"/>
    <item id="part3-1" href="Text/part0031.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="Text/cover.png" media-type="image/png"/>
  </manifest>
  <spine toc="toc">
    <itemref idref="part2"/>
    <itemref idref="part2-1"/>
    <itemref idref="part2-2"/>
    <itemref idref="part3"/>
    <itemref idref="part3-1"/>
  </spine>
</package>`)
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint id="part2" playOrder="1">
      <navLabel><text>第二部</text></navLabel>
      <content src="Text/part0020.xhtml"/>
      <navPoint id="part2-1" playOrder="2">
        <navLabel><text>一</text></navLabel>
        <content src="Text/part0021.xhtml#b017"/>
      </navPoint>
      <navPoint id="part2-2" playOrder="3">
        <navLabel><text>二</text></navLabel>
        <content src="Text/part0022.xhtml#b018"/>
      </navPoint>
    </navPoint>
    <navPoint id="part3" playOrder="4">
      <navLabel><text>第三部</text></navLabel>
      <content src="Text/part0030.xhtml"/>
      <navPoint id="part3-1" playOrder="5">
        <navLabel><text>一</text></navLabel>
        <content src="Text/part0031.xhtml#b021"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`)
  zip.file('OEBPS/Text/part0020.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二部</title></head><body><p><img src="cover.png" alt="part"/></p></body></html>`)
  zip.file('OEBPS/Text/part0021.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>一</title></head><body><h2 id="b017">一</h2><p>第二部第一章正文。</p></body></html>`)
  zip.file('OEBPS/Text/part0022.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>二</title></head><body><h2 id="b018">二</h2><p>第二部第二章正文。</p></body></html>`)
  zip.file('OEBPS/Text/part0030.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第三部</title></head><body><p>第三部封面。</p></body></html>`)
  zip.file('OEBPS/Text/part0031.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>一</title></head><body><h2 id="b021">一</h2><p>第三部第一章正文。</p></body></html>`)
  zip.file('OEBPS/Text/cover.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
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
  const csp = html.match(/Content-Security-Policy[\s\S]*?content="([^"]+)"/)?.[1] || ''
  assert.match(csp, /connect-src[^;]*local-file:/)
  assert.match(csp, /style-src[^;]*blob:/)
  assert.match(csp, /img-src[^;]*blob:/)
})

test('importEpubAsMarkdown writes a book-named markdown file and assets without overwriting existing import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-import-'))
  try {
    const epubPath = join(dir, 'Minimal Book.epub')
    await writeMinimalEpub(epubPath, { image: true })

    const first = await importEpubAsMarkdown(epubPath)
    assert.equal(first.success, true, first.error)
    assert.ok(first.outputDir)
    assert.ok(first.indexPath)
    assert.equal(first.outputDir, dir)
    assert.equal(basename(first.indexPath!), 'Minimal Book.md')
    assert.equal(existsSync(join(dir, 'Minimal Book')), false)
    assert.equal(first.assetCount, 1)
    assert.equal(existsSync(join(dir, 'Minimal Book.assets', 'cover.png')), true)
    const markdown = await readFile(first.indexPath!, 'utf-8')
    assert.match(markdown, new RegExp(EBOOK_MARKDOWN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(markdown, /^# Minimal Book/m)
    assert.doesNotMatch(markdown, /^# Hello/m)
    assert.match(markdown, /^## Hello/m)
    assert.match(markdown, /Readable text\./)
    assert.match(markdown, /Minimal Book\.assets\/cover\.png/)
    assert.doesNotMatch(markdown, /\n---\n/)

    const second = await importEpubAsMarkdown(epubPath)
    assert.equal(second.success, true, second.error)
    assert.notEqual(second.indexPath, first.indexPath)
    assert.equal(second.outputDir, dir)
    assert.equal(basename(second.indexPath!), 'Minimal Book 2.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('importEpubAsMarkdown reuses repeated inline image assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-inline-image-'))
  try {
    const epubPath = join(dir, 'Inline Glyph.epub')
    await writeMinimalEpub(epubPath, { image: true, inlineImage: true, title: 'Inline Glyph' })

    const result = await importEpubAsMarkdown(epubPath)
    assert.equal(result.success, true, result.error)
    assert.equal(result.assetCount, 2)
    assert.equal(existsSync(join(dir, 'Inline Glyph.assets', 'cover.png')), true)
    assert.equal(existsSync(join(dir, 'Inline Glyph.assets', 'glyph.png')), true)
    assert.equal(existsSync(join(dir, 'Inline Glyph.assets', 'glyph-2.png')), false)

    const markdown = await readFile(result.indexPath!, 'utf-8')
    assert.match(markdown, /!\[Cover\]\(<Inline Glyph\.assets\/cover\.png>\)/)
    assert.equal(
      (markdown.match(new RegExp(`!\\[\\]\\(<Inline Glyph\\.assets\\/glyph\\.png> "${EBOOK_INLINE_IMAGE_TITLE}"\\)`, 'g')) || []).length,
      2,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('importEpubAsMarkdown falls back to source name when EPUB title is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-title-fallback-'))
  try {
    const epubPath = join(dir, 'Source Book.epub')
    await writeMinimalEpub(epubPath, { title: null })
    const result = await importEpubAsMarkdown(epubPath)
    assert.equal(result.success, true, result.error)
    assert.equal(result.outputDir, dir)
    assert.equal(basename(result.indexPath!), 'Source Book.md')
    assert.equal(existsSync(join(dir, 'Source Book')), false)
    assert.equal(existsSync(join(dir, 'Source Book.assets')), false)
    const markdown = await readFile(result.indexPath!, 'utf-8')
    assert.match(markdown, /^# Source Book/m)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('importEpubAsMarkdown sanitizes unsafe and long markdown file names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-title-sanitize-'))
  try {
    const unsafeTitle = `${'A'.repeat(140)}/Bad:Name*?`
    const epubPath = join(dir, 'Unsafe Name.epub')
    await writeMinimalEpub(epubPath, { title: unsafeTitle })
    const result = await importEpubAsMarkdown(epubPath)
    assert.equal(result.success, true, result.error)
    const fileName = basename(result.indexPath!)
    assert.equal(fileName.endsWith('.md'), true)
    assert.equal(fileName.length <= 123, true)
    const forbiddenChars = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
    assert.equal(
      Array.from(fileName).some((char) => forbiddenChars.has(char) || char.charCodeAt(0) < 32),
      false,
    )
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

test('importEpubAsMarkdown preserves toc.ncx part and chapter hierarchy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ready-ebook-toc-'))
  try {
    const epubPath = join(dir, '层级书.epub')
    await writeTocEpub(epubPath)

    const result = await importEpubAsMarkdown(epubPath)
    assert.equal(result.success, true, result.error)
    const markdown = await readFile(result.indexPath!, 'utf-8')

    assert.match(markdown, /^## 第二部$/m)
    assert.match(markdown, /^### 一$/m)
    assert.match(markdown, /第二部第一章正文。/)
    assert.match(markdown, /^## 第三部$/m)
    assert.match(markdown, /第三部第一章正文。/)
    assert.doesNotMatch(markdown, /^第二部$/m)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('importEpubAsMarkdown rejects non-EPUB formats', async () => {
  const result = await importEpubAsMarkdown('/Users/alice/Documents/projects/book.mobi')
  assert.equal(result.success, false)
  assert.equal(result.errorCode, 'UNSUPPORTED_EBOOK_IMPORT')
})
