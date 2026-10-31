// Build first (electron-vite build). Real-Electron acceptance for the Library (书房):
// import an EPUB and a TXT into a throwaway vault, open the Library from the document
// sidebar, open a book, read and turn a page. Screenshots go to READY_LIBRARY_SHOTS
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

// L5: exercise the visible chooser against fixture-only native dialog replies.
// Originals are restored immediately; no test endpoint or production bypass exists.
async function checkArchiveImport(app, page, fixtures, vaultRoot) {
  const source = path.join(fixtures, '藏书阁夹具')
  fs.mkdirSync(path.join(source, 'files'), { recursive: true })
  fs.mkdirSync(path.join(source, 'covers'))
  const text = '第一章\n甲乙丙丁戊己庚辛'
  fs.writeFileSync(path.join(source, 'files', 'archive.txt'), text)
  const record = { id: 'archive', title: '藏书阁迁移夹具', author: '测试作者', tags: ['迁移'], source: 'local', status: 'ready', addedAt: 1700000000000,
    file: { name: '原书.txt', ext: 'txt', size: Buffer.byteLength(text) },
    progress: { chapter: 0, offset: 5, pct: 0.5, at: 1700000000000 },
    bookmarks: [{ chapter: 0, offset: 5, label: '旧书签', at: 1700000000000 }],
    highlights: [
      { id: 'one', chapter: 0, from: 3, to: 5, text: '甲乙', color: 'pink', note: '原批注', at: 1700000000000 },
      { id: 'two', chapter: 0, from: 99, to: 101, text: '丙丁', color: 'pen', at: 1700000000000 },
      { id: 'three', chapter: 0, from: 30, to: 33, text: '找不到', color: 'blue', at: 1700000000000 },
    ] }
  const json = JSON.stringify({ version: 1, books: [record, { ...record, id: 'missing', title: '缺失文件夹具' }] })
  fs.writeFileSync(path.join(source, 'library.json'), json)
  await app.evaluate(({ dialog }, directory) => {
    globalThis.__archiveDialogs = { open: dialog.showOpenDialog, confirm: dialog.showMessageBox }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }, source)
  try {
    await page.getByRole('button', { name: '从藏书阁导入…', exact: true }).click()
    const modal = page.getByRole('dialog', { name: '从藏书阁导入', exact: true })
    await modal.getByText('桌面版建议位置', { exact: false }).waitFor()
    await modal.getByRole('button', { name: '选择目录并导入' }).click()
    await modal.getByText('导入结束：成功 1 本，跳过 0 本，失败 1 本；未定位划线 1 条。', { exact: true }).waitFor()
    await modal.getByText('查看失败项', { exact: true }).click()
    ok('archive failure reason is visible', await modal.getByText('缺失文件夹具：', { exact: false }).isVisible())
    await page.screenshot({ path: path.join(shots, 'archive-report.png') })
    const state = await page.evaluate(() => window.electronAPI.library.get())
    const book = state.success && state.data.books.find(b => b.source.ref === '藏书阁:archive')
    ok('archive book reaches shelf', !!book)
    if (!book) throw new Error('archive fixture book missing')
    const md = fs.readFileSync(book.notePath, 'utf8')
    ok('archive source preserves annotations and unlocated text', md.includes('原批注') && md.includes('未定位') && md.includes('找不到'))
    ok('archive anchors exist', fs.existsSync(path.join(vaultRoot, '.ready', 'anchors', `${book.id}.highlights.json`)))
    const reading = await page.evaluate(async id => ({ position: await window.electronAPI.library.getPosition(id), bookmarks: await window.electronAPI.library.listBookmarks(id) }), book.id)
    ok('archive reading records persist', reading.position.success && reading.position.data.offset === 5 && reading.bookmarks.success && reading.bookmarks.data.length === 1)
    await modal.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '从藏书阁导入…', exact: true }).click()
    await modal.getByRole('button', { name: '选择目录并导入' }).click()
    await modal.getByText('导入结束：成功 0 本，跳过 1 本，失败 1 本；未定位划线 0 条。', { exact: true }).waitFor()
    ok('archive retry does not duplicate source blocks', fs.readFileSync(book.notePath, 'utf8') === md)
    ok('archive source bytes unchanged', fs.readFileSync(path.join(source, 'library.json'), 'utf8') === json && fs.readFileSync(path.join(source, 'files', 'archive.txt'), 'utf8') === text)
    await modal.getByRole('button', { name: '关闭', exact: true }).click()
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__archiveDialogs.open
      dialog.showMessageBox = globalThis.__archiveDialogs.confirm
      delete globalThis.__archiveDialogs
    })
  }
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
  const anchors = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.ready', 'anchors', `${book.id}.highlights.json`), 'utf8'))
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
  await checkQuoteReturn(page, book, id, selected)
}

// L4: use the reader's copied reference, the real document editor and return capsule.
async function checkQuoteReturn(page, book, id, selected) {
  const point = await page.evaluate(id => {
    const folio = Number(document.querySelector('.rn-library .rd-dock span').textContent.split('/')[0].trim())
    const mark = document.querySelector(`.rn-library .rd-book .leaf .sheet[data-pi="${folio - 1}"] mark[data-hl="${id}"]`)
    if (!mark) throw new Error('visible quote mark missing')
    const box = mark.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }, id)
  await page.mouse.click(point.x, point.y)
  await page.getByRole('button', { name: '复制引用', exact: true }).click()
  const reference = await page.evaluate(() => navigator.clipboard.readText())
  ok('reader copies a source-block embed', reference === `![[${path.basename(book.notePath, '.md')}#^${id}]]`, reference)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t')
  // Pages are the normal view; Markdown source editing lives in the page menu.
  const setSource = async on => {
    const editor = page.locator('textarea.document-source-textarea:visible').first()
    if (await editor.isVisible().catch(() => false) === on) return
    await page.getByLabel('文档顶栏', { exact: true }).getByRole('button', { name: '页面选项', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Markdown 源码', exact: true }).click()
    if (on) await editor.waitFor()
  }
  await setSource(true)
  const sourceEditor = page.getByRole('textbox', { name: 'Markdown source editor' })
  await sourceEditor.fill(`# 引用验收\n\n${reference}`)
  await setSource(false)
  const card = page.locator('[data-library-quote="true"]')
  await card.getByRole('button', { name: '回到原文', exact: true }).waitFor()
  await page.screenshot({ path: path.join(shots, '6b-quote-card.png') })
  ok('document preview renders book, author and quote', (await card.textContent()).includes(book.title) && (await card.textContent()).includes(book.author) && (await card.textContent()).includes(selected))
  const before = await page.locator('[data-ready-document-scroll-key]').getAttribute('data-ready-document-scroll-key')
  await card.getByRole('button', { name: '回到原文', exact: true }).click()
  await page.waitForFunction(selected => {
    const folios = document.querySelector('.rn-library .rd-dock span')?.textContent.split('/')[0].match(/\d+/g)?.map(Number) ?? []
    return folios.some(folio => [...document.querySelectorAll(`.rn-library .rd-book .leaf .sheet[data-pi="${folio - 1}"] [data-book-location]`)].map(m => m.textContent).join('').replace(/\s+/g, ' ').trim() === selected)
  }, selected)
  ok('quote opens the original range and briefly highlights it', true)
  await page.getByRole('button', { name: /^返回 / }).click()
  await card.getByRole('button', { name: '回到原文', exact: true }).waitFor()
  ok('return restores the originating document tab', await page.locator('[data-ready-document-scroll-key]').getAttribute('data-ready-document-scroll-key') === before)
  await setSource(true)
  ok('source view preserves the embed text', await sourceEditor.inputValue() === `# 引用验收\n\n${reference}`)
  await page.screenshot({ path: path.join(shots, '7-quote-return.png') })
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

    const documentDeadline = Date.now() + 30000
    while (!await page.locator('.ink-doc-app').isVisible()) {
      if (Date.now() >= documentDeadline) throw new Error('Document mode must open before the library entry is available')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(150)
    }
    // The vault also has a 阅读 page (the library database); open the reading room through its own entry.
    await page.locator('[data-library-entry="true"]').click()
    await page.locator('.rn-library').waitFor({ timeout: 20000 })
    await page.locator('.rn-library .spine').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(shots, '1-shelf.png') })
    ok('the shelf shows both books', await page.locator('.rn-library .spine').count() >= 2)
    await checkArchiveImport(app, page, fixtures, vault.root)

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
