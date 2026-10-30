// Build first (electron-vite build). Real-Electron acceptance for the Library (书房):
// import an EPUB and a TXT into a throwaway vault, open the Library from the files
// panel, open a book, read and turn a page. Screenshots go to READY_LIBRARY_SHOTS
// (default: outputs/ready-next/library). The daily Ready data is never opened.
const { _electron } = require('playwright')
const JSZip = require('jszip')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const shots = path.resolve(process.env.READY_LIBRARY_SHOTS || 'outputs/ready-next/library')
const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` — ${detail}`}`)
  if (!pass) process.exitCode = 1
}

const paragraph = (n) => `<p>第${n}段。黑暗森林里每个文明都是带枪的猎人，像幽灵般潜行于林间，轻轻拨开挡路的树枝，竭力不让脚步发出一点儿声音，连呼吸都必须小心翼翼。</p>`
async function writeEpub(file) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">ready-next-fixture</dc:identifier><dc:title>验收用书</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language><dc:subject>科幻</dc:subject></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`)
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">第一章 林间</a></li><li><a href="c2.xhtml">第二章 猎人</a></li></ol></nav></body></html>')
  for (const [name, title] of [['c1', '第一章 林间'], ['c2', '第二章 猎人']]) {
    const body = Array.from({ length: 40 }, (_, i) => paragraph(i + 1)).join('')
    zip.file(`OEBPS/${name}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h2>${title}</h2>${body}</body></html>`)
  }
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' }))
}

// Resting pages may be covered by WebGL. Inspect both the DOM and the actual SVG
// captured at Image.src (the exact foreignObject used to upload each page texture).
async function checkVisibleLines(page, label) {
  const checks = await page.evaluate(async () => {
    const folios = document.querySelector('.rn-library .rd-dock span').textContent.split('/')[0].match(/\d+/g).map(Number)
    const inspect = (sheet, win) => {
      const body = sheet.querySelector('.pg-body'), flow = sheet.querySelector('.pg-flow')
      const box = body.getBoundingClientRect(), scale = box.height / 682
      const range = sheet.ownerDocument.createRange()
      const walker = sheet.ownerDocument.createTreeWalker(flow, NodeFilter.SHOW_TEXT)
      let bottom = box.top
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) if (rect.width && rect.height) bottom = Math.max(bottom, rect.bottom)
      }
      return { overflow: (bottom - box.bottom) / scale, lead: parseFloat(win.getComputedStyle(flow).lineHeight),
        firstParagraph: (flow.querySelector('p').getBoundingClientRect().top - box.top) / scale }
    }
    const out = []
    for (const folio of folios) {
      const index = String(folio - 1)
      const sheet = document.querySelector(`.rn-library .rd-book .sheet[data-pi="${index}"]`)
      if (!sheet?.querySelector('.pg-flow p')) continue // front matter is not body text
      const dom = inspect(sheet, window)
      out.push({ page: folio, source: 'DOM', ...dom })
      const svg = window.__libraryRasters.get(index)
      if (!svg) {
        if (document.querySelector('.rn-library .rd-book.gl3d')) throw new Error(`visible texture ${folio} was not captured`)
        continue
      }
      const frame = document.createElement('iframe')
      frame.style.cssText = 'position:fixed;left:-20000px;width:2400px;height:3400px;visibility:hidden'
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      try {
        const loaded = new Promise(resolve => { frame.onload = resolve })
        frame.src = url
        document.body.appendChild(frame)
        await loaded
        await frame.contentDocument.fonts.ready
        const raster = inspect(frame.contentDocument.querySelector('.sheet'), frame.contentWindow)
        out.push({ page: folio, source: 'texture', ...raster, leadDifference: raster.lead - dom.lead,
          paragraphDifference: raster.firstParagraph - dom.firstParagraph })
      } finally { frame.remove(); URL.revokeObjectURL(url) }
    }
    return out
  })
  ok(`${label}: visible body lines fit DOM and texture pages`, checks.length > 0 && checks.every(c => c.overflow <= 0.5 && Math.abs(c.leadDifference || 0) <= 0.5 && Math.abs(c.paragraphDifference || 0) <= 1), JSON.stringify(checks))
  return checks
}

// L2 / C6: real mouse drag, source-file readback and a freshly mounted reader.
async function checkHighlights(page, book, vaultRoot) {
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()
  const drag = await page.evaluate(() => {
    const folios = document.querySelector('.rn-library .rd-dock span').textContent.split('/')[0].match(/\d+/g).map(Number)
    for (const folio of folios) {
      const paragraph = document.querySelector(`.rn-library .rd-book .leaf .sheet[data-pi="${folio - 1}"] .pg-flow p`)
      const node = paragraph?.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE || node.textContent.length < 10) continue
      const first = document.createRange(), last = document.createRange()
      first.setStart(node, 0); first.setEnd(node, 1)
      last.setStart(node, 7); last.setEnd(node, 8)
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect()
      if (a.width && b.width) return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }
    }
    throw new Error('no visible text range for highlight drag')
  })
  const folioBefore = await page.locator('.rn-library .rd-dock').textContent()
  await page.mouse.move(drag.x1, drag.y1)
  await page.mouse.down()
  await page.mouse.move(drag.x2, drag.y2, { steps: 12 })
  await page.mouse.up()
  await page.getByRole('dialog', { name: '划线', exact: true }).waitFor()
  const selected = await page.evaluate(() => getSelection().toString().replace(/\s+/g, ' ').trim())
  ok('drag selects text without turning pages', selected.length >= 3 && await page.locator('.rn-library .rd-dock').textContent() === folioBefore, selected)
  await page.getByRole('button', { name: '黄', exact: true }).click()
  await page.getByRole('dialog', { name: '划线', exact: true }).waitFor({ state: 'hidden' })
  const source = fs.readFileSync(book.notePath, 'utf8')
  const id = source.match(/^\^(hl-[\w-]+)$/m)?.[1]
  ok('drag writes the quote block into the source note', id && source.includes('> [!quote|yellow]') && source.includes(`> ${selected}`), source)
  if (!id) throw new Error('highlight id missing from source note')
  const anchors = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.ready', 'anchors', `${book.id}.json`), 'utf8'))
  ok('sidecar is published after the source block', anchors.version === 1 && anchors.highlights[id]?.quote.exact === selected)
  const restoredOnVisiblePage = async () => page.waitForFunction(({ id, selected }) => {
    const folios = document.querySelector('.rn-library .rd-dock span')?.textContent.split('/')[0].match(/\d+/g)?.map(Number) ?? []
    const text = [...new Set(folios)].flatMap(folio => [...document.querySelectorAll(`.rn-library .rd-book .leaf .sheet[data-pi="${folio - 1}"] mark[data-hl="${id}"]`)].map(mark => mark.textContent)).join('').replace(/\s+/g, ' ').trim()
    return text === selected
  }, { id, selected })
  await restoredOnVisiblePage()
  await page.screenshot({ path: path.join(shots, '5-highlight.png') })

  await page.getByRole('button', { name: '回到书架', exact: true }).click()
  const spine = page.locator('.rn-library .spine', { hasText: book.title }).first()
  const box = await spine.boundingBox()
  if (!box) throw new Error('reopened book spine is missing')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(1500)
  const cover = await page.getByRole('button', { name: '翻看封面' }).boundingBox()
  if (!cover) throw new Error('reopened cover is missing')
  await page.mouse.click(cover.x + cover.width / 2, cover.y + cover.height / 2)
  await page.getByRole('button', { name: '开始阅读', exact: true }).click()
  await page.locator('.rn-library [aria-label="阅读器"]').waitFor()
  await restoredOnVisiblePage()
  ok('reopening the reader restores the same highlight on the visible page', true)
  await page.getByRole('button', { name: '排版', exact: true }).click()
  await page.getByRole('slider', { name: '字号', exact: true }).fill('24')
  await page.locator('.rn-library .reading-status').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '单页', exact: true }).click()
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()
  await page.locator('.rn-library [aria-label="阅读器"]').focus()
  await page.keyboard.press('n')
  await page.locator('.rd-notes-list .rd-note-item > button').filter({ hasText: selected }).first().click()
  await page.getByRole('button', { name: '关闭面板', exact: true }).click()
  await restoredOnVisiblePage()
  ok('font and single-page changes retain the highlighted words on the visible page', true)
  await page.screenshot({ path: path.join(shots, '6-highlight-reopened.png') })
}

function electronEnv(extra) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

;(async () => {
  fs.mkdirSync(shots, { recursive: true })
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-library-'))
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-library-books-'))
  const epub = path.join(fixtures, '验收用书.epub')
  const txt = path.join(fixtures, '雨天随笔.txt')
  await writeEpub(epub)
  fs.writeFileSync(txt, ['第一章 雨', ...Array.from({ length: 60 }, (_, i) => `雨下了一整天，第${i + 1}行字安静地落在纸上。`), '第二章 晴', ...Array.from({ length: 60 }, (_, i) => `天晴以后，第${i + 1}行字晒干了。`)].join('\n'))
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env: electronEnv({ READY_USER_DATA_DIR: profile }), timeout: 45000 })
    let page
    const deadline = Date.now() + 90000
    while (!page && Date.now() < deadline) {
      page = app.windows().find(w => w.url().includes('/renderer/index.html'))
      if (!page) await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!page) throw new Error('renderer did not start')
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('/renderer/index.html')) w.setSize(1600, 1000)
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('crash', () => console.log('RENDERER CRASHED'))
    page.on('console', message => { if (message.type() === 'error') console.log(`console.error: ${message.text().slice(0, 300)}`) })
    await app.evaluate(({ app: electronApp }) => {
      electronApp.on('render-process-gone', (_event, _contents, details) => console.log(`render-process-gone ${JSON.stringify(details)}`))
      electronApp.on('child-process-gone', (_event, details) => console.log(`child-process-gone ${JSON.stringify(details)}`))
    })
    app.process().stdout?.on('data', data => { const text = String(data); if (/process-gone|CRASH|Fatal|Check failed/i.test(text)) console.log(`main: ${text.trim().slice(0, 400)}`) })
    app.process().stderr?.on('data', data => { const text = String(data); if (/process-gone|CRASH|Fatal|Check failed|GPU|WebGL/i.test(text)) console.log(`main-err: ${text.trim().slice(0, 400)}`) })

    await page.evaluate(() => {
      window.__libraryRasters = new Map()
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
      Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set(value) {
        if (value.startsWith('data:image/svg+xml;charset=utf-8,')) {
          const svg = decodeURIComponent(value.slice(value.indexOf(',') + 1))
          const index = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('.sheet')?.getAttribute('data-pi')
          if (index !== null && index !== undefined) window.__libraryRasters.set(index, svg)
        }
        descriptor.set.call(this, value)
      } })
    })
    const vault = await page.evaluate(() => window.electronAPI.vault.createDefault())
    ok('vault is ready inside the throwaway profile', vault.status === 'ready' && fs.realpathSync(vault.root).startsWith(fs.realpathSync(profile)), JSON.stringify(vault))
    const imported = await page.evaluate(paths => window.electronAPI.library.importFiles(paths), [epub, txt])
    ok('two books import into the vault', imported.success && imported.data.imported.length === 2 && imported.data.failed.length === 0, JSON.stringify(imported))
    const epubBook = imported.success && imported.data.imported.find(b => b.format === 'epub')
    ok('EPUB metadata reaches the source note', epubBook && epubBook.title === '验收用书' && epubBook.author === '测试作者', JSON.stringify(epubBook))
    ok('the source note lives under 阅读/ in the vault', epubBook && fs.existsSync(path.join(vault.root, '阅读', '验收用书.md')))

    await page.getByRole('button', { name: '阅读', exact: true }).first().click()
    await page.locator('.rn-library').waitFor({ timeout: 20000 })
    await page.locator('.rn-library .spine').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(shots, '1-shelf.png') })
    ok('the shelf shows both books', await page.locator('.rn-library .spine').count() >= 2)

    // Spines sway and tilt, so Playwright's stability check never settles; click the spine's centre.
    const spine = page.locator('.rn-library .spine', { hasText: '验收用书' }).first()
    const box = await spine.boundingBox()
    if (!box) throw new Error('EPUB spine has no box')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.getByRole('button', { name: '开始阅读' }).waitFor({ timeout: 20000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(shots, '2-book-open.png') })
    // As in 藏书阁, the pulled book faces you; clicking the cover opens it before 开始阅读 is reachable.
    const cover = await page.getByRole('button', { name: '翻看封面' }).boundingBox()
    if (!cover) throw new Error('cover has no box')
    await page.mouse.click(cover.x + cover.width / 2, cover.y + cover.height / 2)
    await page.waitForTimeout(1800)
    await page.screenshot({ path: path.join(shots, '2b-cover-opened.png') })
    await page.getByRole('button', { name: '开始阅读' }).click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: path.join(shots, '3-reader.png') })
    await checkVisibleLines(page, 'chapter opening')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1500)
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(shots, '4-reader-turned.png') })
    await checkVisibleLines(page, 'continuation')
    await page.waitForTimeout(1500)
    const books = await page.evaluate(() => window.electronAPI.library.get())
    const opened = books.success && books.data.status === 'ready' && books.data.books.find(b => b.format === 'epub')
    const position = opened ? await page.evaluate(id => window.electronAPI.library.getPosition(id), opened.id) : null
    ok('turning pages saves a reading position', position?.success && position.data && (position.data.offset > 0 || position.data.chapter > 0), JSON.stringify(position))
    await page.getByRole('button', { name: '排版', exact: true }).click()
    await page.getByRole('slider', { name: '行距', exact: true }).fill('2.2')
    await page.waitForTimeout(2000)
    const spaced = await checkVisibleLines(page, 'line spacing 2.2')
    ok('line spacing changes body layout', spaced.length > 0 && spaced.every(c => Math.abs(c.lead - 18 * 2.2) < 0.5), JSON.stringify(spaced))
    await checkHighlights(page, epubBook, vault.root)
    ok('no uncaught renderer errors', errors.length === 0, errors.join(' | '))
  } catch (error) {
    ok('library acceptance completed', false, error instanceof Error ? error.stack : String(error))
  } finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    fs.rmSync(fixtures, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  const failed = results.filter(r => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} passed · screenshots: ${shots}`)
  process.exit(failed ? 1 : 0)
})()
