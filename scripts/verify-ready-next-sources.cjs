// Claude runs this after building this checkout. It requires real Electron windows; no simulated pass.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { _electron } = require('playwright')

// A deterministic two-page PDF with a real selectable text layer; no network or extra dependency.
function pdfFixture() {
  const stream = 'BT /F1 18 Tf 50 720 Td (PDF source selection remains after restart.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n', offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return pdf
}

async function main() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-sources-')))
  const vault = path.join(temporary, 'vault'), profile = path.join(temporary, 'profile'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  const text = '甲乙丙丁戊己庚辛壬癸，来源页应保留这段文字。'
  const bookFile = path.join(temporary, '来源验收书.txt'); fs.writeFileSync(bookFile, text + '\n\n' + '这是分页用的其他文字。'.repeat(200))
  const pdfFile = path.join(vault, '来源验收.pdf'); fs.writeFileSync(pdfFile, pdfFixture())
  let port
  const server = http.createServer((request, response) => {
    if (request.url === '/feed') {
      response.setHeader('content-type', 'application/rss+xml; charset=utf-8')
      response.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>本地验收</title><link>http://127.0.0.1:${port}/</link><description>离线夹具</description><item><guid>source-proof</guid><title>来源验收文章</title><link>http://127.0.0.1:${port}/article</link><description>${text}</description></item></channel></rss>`)
    } else {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<html><head><title>来源验收网页</title><style>body{padding:80px;font:24px sans-serif}::target-text{background:rgb(255,0,255);color:black}</style></head><body><p>前面的上下文。</p><p id="quote">${text}</p><p>后面的上下文。</p></body></html>`)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = server.address().port
  const webURL = `http://127.0.0.1:${port}/page`
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  let app, page
  const poll = async (check, message) => {
    const deadline = Date.now() + 45000
    while (!await check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  const mode = async value => page.evaluate(mode => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode, placement: 'open', presentation: 'immediate' } })), value)
  const launch = async () => {
    app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    await poll(() => { page = app.windows().find(window => window.url().includes('/renderer/index.html')); return !!page }, 'Ready Next renderer missing')
    await poll(() => page.evaluate(() => Boolean(window.electronAPI?.sourceAnnotations)), 'Source preload missing')
  }
  const openFile = async file => {
    await mode('document')
    // Right after a restart the shortcuts may not be listening yet, and a focused editor ignores them: retry ⌘K.
    const search = page.getByRole('combobox', { name: '搜索所有对象和命令' })
    for (let attempt = 0; attempt < 20 && !await search.isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
      await search.waitFor({ timeout: 1500 }).catch(() => {})
    }
    await search.fill(path.basename(file, '.md'))
    await page.getByRole('listbox').getByRole('button').filter({ hasText: path.basename(file) }).first().click()
    // Pages always open in the page view.
    await poll(() => page.locator('.note-preview-body:visible').count().then(n => n > 0), 'Source preview missing')
  }
  const markFile = folder => {
    const directory = path.join(vault, folder)
    return fs.existsSync(directory) && fs.readdirSync(directory).filter(name => name.endsWith('.md')).map(name => path.join(directory, name)).find(file => fs.readFileSync(file, 'utf8').includes('^hl-'))
  }
  // Selects characters 1–6 of the first text in the surface, or the given words wherever they appear in it.
  const select = async (surface, selector, words = null) => {
    await surface.locator(selector).first().evaluate((element, words) => {
      const walker = document.createTreeWalker(words ? element.closest('.rss-reader-body') ?? element : element, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      if (words) while (node && !node.textContent.includes(words)) node = walker.nextNode()
      if (!node || node.textContent.length < 6) throw new Error('Selection fixture missing')
      const start = words ? node.textContent.indexOf(words) : 1
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + (words ? words.length : 5))
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.dispatchEvent(new Event('selectionchange'))
    }, words)
  }
  try {
    await launch()
    await page.evaluate(async root => {
      const result = await window.electronAPI.vault.set(root); if (result.status !== 'ready') throw new Error('Vault unavailable')
      localStorage.setItem('ready-workspace-root', root); localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
    await app.close(); await launch(); await mode('document')
    // Mode changes go through the workbench transition; repeat the request until the document shell shows.
    for (let attempt = 0; attempt < 100 && !await page.locator('.ink-doc-app').isVisible().catch(() => false); attempt++) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
      await page.waitForTimeout(200)
    }
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    const imported = await page.evaluate(file => window.electronAPI.library.importFiles([file]), bookFile)
    assert.ok(imported.success && imported.data.imported.length === 1)
    await page.locator('[data-library-entry="true"]').click()
    const spine = page.locator('.rn-library .spine').first()
    await poll(() => spine.isVisible(), 'Book missing from shelf')
    const box = await spine.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const cover = page.getByRole('button', { name: '翻看封面' }); await cover.click({ force: true })
    // The open book follows the pointer, so a pointer click chases a moving button; click it directly.
    await page.getByRole('button', { name: '开始阅读' }).evaluate(button => (button).click())
    await poll(() => page.locator('.rd-book .leaf .pg-flow p').count().then(n => n > 0), 'Book page missing')
    // Real mouse drag exercises the book reader's pointer/selection gate.
    const drag = await page.locator('.rd-book .leaf .pg-flow p').first().evaluate(element => {
      const node = element.firstChild, a = document.createRange(), b = document.createRange()
      a.setStart(node, 1); a.setEnd(node, 2); b.setStart(node, 5); b.setEnd(node, 6)
      const first = a.getBoundingClientRect(), last = b.getBoundingClientRect()
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 }
    })
    await page.mouse.move(drag.x1, drag.y1); await page.mouse.down(); await page.mouse.move(drag.x2, drag.y2, { steps: 12 }); await page.mouse.up()
    await page.getByRole('dialog', { name: '划线', exact: true }).getByRole('button', { name: '黄', exact: true }).click()
    await poll(() => Boolean(markFile('阅读')), 'Book mark not saved')

    const feed = await page.evaluate(url => window.electronAPI.rss.addSource({ name: '本地验收', url }), `http://127.0.0.1:${port}/feed`)
    assert.equal(feed.success, true, JSON.stringify(feed))
    await mode('rss')
    await page.getByText('来源验收文章', { exact: true }).first().click()
    await poll(() => page.locator('.rss-reader-body [data-ready-reading-run]').count().then(n => n > 0), 'RSS body missing')
    // The reader can re-render right after opening (read state); select again until the menu sees the selection.
    const rssHighlight = page.getByRole('button', { name: '划线到来源页', exact: true })
    for (let attempt = 0; ; attempt++) {
      // The reader shows the article fetched from its link; the quote is its second paragraph.
      await select(page, '.rss-reader-body [data-ready-reading-run]', '乙丙丁戊己')
      if (!await rssHighlight.isVisible()) await page.getByRole('button', { name: '引用', exact: true }).click()
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !await rssHighlight.isEnabled().catch(() => false)) await page.waitForTimeout(100)
      if (await rssHighlight.isEnabled().catch(() => false)) { await rssHighlight.click(); break }
      assert.ok(attempt < 4, 'RSS selection never reached the highlight menu')
      await page.waitForTimeout(500)
    }
    await poll(() => Boolean(markFile('文章')), 'RSS mark not saved')

    await mode('browser')
    const opened = await page.evaluate(url => window.electronAPI.browser.createTab(url), webURL); assert.equal(opened.success, true)
    let web
    await poll(() => { web = app.context().pages().find(p => p.url() === webURL); return !!web }, 'Native browser page missing')
    await page.getByRole('button', { name: 'FastCard', exact: true }).click()
    await select(web, '#quote')
    await page.getByRole('button', { name: '划线到来源页', exact: true }).click()
    await poll(() => Boolean(markFile('网页')), 'Web mark not saved')

    const files = ['阅读', '文章', '网页'].map(markFile)
    // Binary PDFs are not full-text search entries. Open one through a real ReadyRef in a fixture page.
    const pdfEntry = await page.evaluate(async ({ file, root }) => {
      const object = await window.electronAPI.objects.resolvePath(file)
      const uri = `ready://doc/file/${encodeURIComponent(object.objectId)}#${encodeURIComponent('pdf:' + JSON.stringify({ page: 1 }))}`
      const result = await window.electronAPI.documentPages.operate({ type: 'create', root, parentPath: root, operationId: 'pdf-source-entry', title: 'PDF 验收入口', content: `[打开 PDF](${uri})` })
      if (!result.ok) throw new Error(result.message)
      return result.value.path
    }, { file: pdfFile, root: vault })
    await openFile(pdfEntry)
    // Links in an editable page follow on ⌘/Ctrl-click; a plain click places the caret.
    await page.getByRole('link', { name: '打开 PDF', exact: true }).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
    await poll(() => page.locator('[data-pdf-text-state="ready"] .react-pdf__Page__textContent').count().then(n => n > 0), 'PDF text layer missing')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await select(page, '[data-page="2"] .react-pdf__Page__textContent')
    await page.getByRole('button', { name: '划线到来源页', exact: true }).click()
    let pdfSource
    await poll(() => {
      pdfSource = fs.readdirSync(path.join(vault, '文章')).filter(name => name.endsWith('.md')).map(name => path.join(vault, '文章', name))
        .find(file => { const content = fs.readFileSync(file, 'utf8'); return content.includes('DF so') && content.includes('^hl-') })
      return Boolean(pdfSource)
    }, 'PDF annotation was not saved to its source page')
    files.push(pdfSource)
    const saved = files.map(file => fs.readFileSync(file, 'utf8'))
    for (let i = 0; i < files.length; i++) {
      await openFile(files[i])
      // The page body loads after the tab switches; wait for this page's quote.
      await poll(() => page.locator('[data-ready-block-editor]:visible').first().textContent().then(text => text.includes(i === 3 ? 'DF so' : '乙丙丁戊己')), `Source page ${i} body missing`)
      await page.screenshot({ path: path.join(evidence, `source-${i}.png`) })
      await page.locator('[data-ready-block-editor]:visible').first().getByRole('link', { name: '原文', exact: true }).first().click()
      if (i === 0) await poll(() => page.locator('[data-book-location]').count().then(n => n > 0), 'Book return highlight missing')
      if (i === 1) await poll(() => page.evaluate(() => window.getSelection()?.toString().includes('乙丙丁戊己')), 'RSS return highlight missing')
      // Electron does not apply text fragments to loadURL navigations; Ready highlights the quote itself.
      if (i === 2) await poll(() => app.evaluate(async ({ webContents }) => {
        const target = webContents.getAllWebContents().filter(w => w.getURL().includes('/page') && w.getURL().includes(':~:text=')).at(-1)
        if (!target) return false
        const quoted = await target.executeJavaScript("(() => { const h = CSS.highlights.get('ready-source-quote'); return h ? [...h][0].toString() : '' })()").catch(() => '')
        if (quoted !== '乙丙丁戊己') return false
        const pixels = (await target.capturePage()).toBitmap()
        let count = 0
        // Bitmaps are BGRA; the amber highlight over white is about rgb(255, 229, 140).
        for (let at = 0; at < pixels.length; at += 4) if (pixels[at] > 115 && pixels[at] < 170 && pixels[at + 1] > 205 && pixels[at + 2] > 240) count++
        return count > 20
      }), 'Web quote highlight missing')
      if (i === 3) {
        await poll(() => page.locator('[data-page="2"] [data-ready-pdf-highlight]').evaluateAll(marks => marks.map(mark => mark.textContent).join('') === 'DF so' && marks.every(mark => {
          const style = getComputedStyle(mark), rect = mark.getBoundingClientRect()
          return style.position !== 'absolute' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && rect.width > 0 && rect.height > 0
        })), 'PDF return highlight missing or not visibly painted')
      }
      await page.screenshot({ path: path.join(evidence, `return-${i}.png`) })
    }
    await app.close(); await launch()
    for (let i = 0; i < files.length; i++) {
      assert.equal(fs.readFileSync(files[i], 'utf8'), saved[i]); await openFile(files[i])
      await poll(() => page.locator('[data-ready-block-editor]:visible').first().textContent().then(text => text.includes(i === 3 ? 'DF so' : '乙丙丁戊己')), `Source page ${i} body missing after restart`)
    }
    await page.locator('[data-ready-block-editor]:visible').first().getByRole('link', { name: '原文', exact: true }).first().click()
    await poll(() => page.locator('[data-page="2"] [data-ready-pdf-highlight]').allTextContents().then(parts => parts.join('') === 'DF so'), 'PDF return highlight missing after restart')
    fs.writeFileSync(path.join(evidence, 'sources.json'), JSON.stringify({ files, saved }, null, 2))
    console.log(`PASS book/RSS/web/PDF selections, source pages, return highlights and restart readback. Evidence: ${evidence}`)
  } finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)) }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { pdfFixture }
