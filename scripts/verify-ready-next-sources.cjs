// Claude runs this after building this checkout. It requires real Electron windows; no simulated pass.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { _electron } = require('playwright')

async function main() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-sources-')))
  const vault = path.join(temporary, 'vault'), profile = path.join(temporary, 'profile'), evidence = path.join(temporary, 'evidence')
  fs.mkdirSync(vault); fs.mkdirSync(evidence)
  const text = '甲乙丙丁戊己庚辛壬癸，来源页应保留这段文字。'
  const bookFile = path.join(temporary, '来源验收书.txt'); fs.writeFileSync(bookFile, text + '\n\n' + '这是分页用的其他文字。'.repeat(200))
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
  delete env.ELECTRON_RUN_AS_NODE; delete env.READY_START_HIDDEN
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
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await page.getByRole('combobox', { name: '搜索所有对象和命令' }).fill(path.basename(file, '.md'))
    await page.getByRole('listbox').getByRole('button').filter({ hasText: path.basename(file) }).first().click()
    // Pages open in the page view already; switch only when the source editor is showing.
    await page.waitForTimeout(500)
    if (!await page.locator('.note-preview-body:visible').count()) await page.getByRole('button', { name: '预览', exact: true }).click({ force: true })
    await poll(() => page.locator('.note-preview-body:visible').count().then(n => n > 0), 'Source preview missing')
  }
  const markFile = folder => {
    const directory = path.join(vault, folder)
    return fs.existsSync(directory) && fs.readdirSync(directory).filter(name => name.endsWith('.md')).map(name => path.join(directory, name)).find(file => fs.readFileSync(file, 'utf8').includes('^hl-'))
  }
  const select = async (surface, selector) => {
    await surface.locator(selector).first().evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), node = walker.nextNode()
      if (!node || node.textContent.length < 6) throw new Error('Selection fixture missing')
      const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 6)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.dispatchEvent(new Event('selectionchange'))
    })
  }
  try {
    await launch()
    await page.evaluate(async root => {
      const result = await window.electronAPI.vault.set(root); if (result.status !== 'ready') throw new Error('Vault unavailable')
      localStorage.setItem('ready-workspace-root', root); localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
    await app.close(); await launch(); await mode('document')
    await page.locator('.ink-doc-app').waitFor({ state: 'visible' })
    const imported = await page.evaluate(file => window.electronAPI.library.importFiles([file]), bookFile)
    assert.ok(imported.success && imported.data.imported.length === 1)
    await page.locator('[data-library-entry="true"]').click()
    const spine = page.locator('.rn-library .spine').first()
    await poll(() => spine.isVisible(), 'Book missing from shelf')
    const box = await spine.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const cover = page.getByRole('button', { name: '翻看封面' }); await cover.click({ force: true })
    await page.getByRole('button', { name: '开始阅读' }).click()
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
      await select(page, '.rss-reader-body [data-ready-reading-run]')
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
    const saved = files.map(file => fs.readFileSync(file, 'utf8'))
    for (let i = 0; i < files.length; i++) {
      await openFile(files[i])
      assert.ok((await page.locator('[data-ready-block-editor]:visible').first().textContent()).includes('乙丙丁戊己'))
      await page.screenshot({ path: path.join(evidence, `source-${i}.png`) })
      await page.locator('[data-ready-block-editor]:visible').first().getByRole('link', { name: '原文', exact: true }).first().click()
      if (i === 0) await poll(() => page.locator('[data-book-location]').count().then(n => n > 0), 'Book return highlight missing')
      if (i === 1) await poll(() => page.evaluate(() => window.getSelection()?.toString().includes('乙丙丁戊己')), 'RSS return highlight missing')
      if (i === 2) await poll(() => app.evaluate(async ({ webContents }) => {
        const target = webContents.getAllWebContents().filter(w => w.getURL().includes('/page')).at(-1)
        if (!target) return false
        const pixels = (await target.capturePage()).toBitmap()
        let count = 0
        for (let at = 0; at < pixels.length; at += 4) if (pixels[at] === 255 && pixels[at + 1] === 0 && pixels[at + 2] === 255) count++
        return count > 20
      }), 'Web text-fragment highlight missing')
      await page.screenshot({ path: path.join(evidence, `return-${i}.png`) })
    }
    await app.close(); await launch()
    for (let i = 0; i < files.length; i++) {
      assert.equal(fs.readFileSync(files[i], 'utf8'), saved[i]); await openFile(files[i])
      assert.ok((await page.locator('[data-ready-block-editor]:visible').first().textContent()).includes('乙丙丁戊己'))
    }
    fs.writeFileSync(path.join(evidence, 'sources.json'), JSON.stringify({ files, saved }, null, 2))
    console.log(`PASS book/RSS/web selections, source pages, return highlights and restart readback. Evidence: ${evidence}`)
  } finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
