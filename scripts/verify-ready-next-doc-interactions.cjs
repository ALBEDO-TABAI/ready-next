#!/usr/bin/env node
// Document interactions, round nine (design language plan §1.8): real-window check.
// Hidden window only (READY_START_HIDDEN=1 is forced here), throwaway profile, HOME, TMPDIR and test vault.
// Build first (npx electron-vite build). Usage: node scripts/verify-ready-next-doc-interactions.cjs [--shots <dir>]
//
// Covers, in the real page view: a to-do ticked on 今日 unticks again; task boxes toggle both ways (also inside a
// callout) and save; the table grows from its bottom and right edges, a column and a row are inserted in the middle
// and deleted from their handles, a cell edits in place; @ and /链接页面 search the library and insert a link; a page
// row dragged from the sidebar shows a drop line and lands where it was dropped; a list entry moves by its marker;
// a quote, a callout and a code block edit in place; the import dialog names Notion only.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const shotsArg = process.argv.indexOf('--shots')
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-doc-interactions-')))
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : path.join(base, 'shots')
// Everything the app may touch lives under the throwaway directory, before the harness copies process.env.
process.env.READY_START_HIDDEN = '1'
process.env.HOME = path.join(base, 'home')
process.env.TMPDIR = path.join(base, 'tmp')
for (const dir of [process.env.HOME, process.env.TMPDIR, shots]) fs.mkdirSync(dir, { recursive: true })
const harness = require('./design-matrix/harness.cjs')

const results = []
const ok = (name, pass, detail = '') => { results.push({ name, pass: !!pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail ? ` — ${detail}` : ''}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, timeout = 8000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try { const value = await check(); if (value) return value } catch { /* silent-catch: the condition is retried until the deadline */ }
    if (Date.now() > deadline) return false
    await sleep(120)
  }
}
/** One named step: a thrown error is that step's failure, and the run continues with the next one. */
async function step(name, run) {
  try { const detail = await run(); ok(name, detail !== false, typeof detail === 'string' ? detail : '') }
  catch (error) { ok(name, false, String(error && error.message || error).split('\n')[0]) }
}

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
const FIXTURE = [
  '第一段正文', '',
  '- [ ] 待办甲', '- [x] 待办乙', '',
  '> [!tip] 提示标题', '> 提示正文一行', '>', '> - [ ] 框内待办', '',
  '> 引用第一行', '> 引用第二行', '',
  '| 阶段 | 负责人 |', '| --- | --- |', '| 初稿 | 白 |', '| 定稿 | 编辑 |', '',
  '## 索引', '',
  '- [[链接目标]]', '- [[第二页]]', '',
  '```js', 'const a = 1', '```', '',
  '> [!todo]+ 折叠框', '> - [ ] 折叠待办', '',
  '结尾段', '',
].join('\n')

async function main() {
  const profile = path.join(base, 'profile'), vault = path.join(base, '测试资料库')
  fs.mkdirSync(vault, { recursive: true })
  const file = path.join(vault, '互动夹具.md'), todoFile = path.join(vault, '本周待办.md')
  fs.writeFileSync(file, FIXTURE)
  fs.writeFileSync(path.join(vault, '链接目标.md'), '# 链接目标\n\n## 章节一\n\n引用正文\n')
  fs.writeFileSync(path.join(vault, '第二页.md'), '第二页的正文\n')
  fs.writeFileSync(path.join(vault, '拖入的页面.md'), '拖进索引里的页面\n')
  fs.writeFileSync(path.join(vault, '属性夹具.md'), '---\ntags: [甲, 乙]\n状态: 草稿\n---\n\n属性页的正文\n')
  fs.writeFileSync(todoFile, `- [ ] 确认印厂排期 📅 ${today}\n`)
  const read = () => fs.readFileSync(file, 'utf8')
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

  let { app, page } = await harness.launch(profile)
  try {
    await page.evaluate(async root => {
      const result = await window.electronAPI.vault.set(root)
      if (result?.status !== 'ready') throw new Error(`vault not ready: ${JSON.stringify(result).slice(0, 200)}`)
      localStorage.setItem('ready-workspace-root', root)
      localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
  } finally { await harness.close(app) }
  ;({ app, page } = await harness.launch(profile))
  try {
    await page.evaluate(root => window.electronAPI.document.reindexWorkspace(root), vault)
    const shot = name => page.screenshot({ path: path.join(shots, `${name}.png`) })
    const saved = async (check, label) => {
      await page.keyboard.press(`${mod}+s`)
      const pass = await waitFor(() => check(read()))
      if (!pass) throw new Error(`${label}: the file reads\n${read()}`)
    }

    // ── 1. 今日: a to-do ticked by mistake unticks ─────────────────────────────────────────────────────────────
    await step('今日: a ticked to-do unticks again, and the page file reads [ ] again', async () => {
      await page.locator('[data-shell-band="top"] button[aria-label="今日"]').click()
      const row = page.locator('[data-today-block="upcoming"] .today-row', { hasText: '确认印厂排期' })
      await row.waitFor({ timeout: 20000 })
      await row.locator('[role="checkbox"]').click()
      if (!await waitFor(() => fs.readFileSync(todoFile, 'utf8').includes('- [x] 确认印厂排期'))) throw new Error('ticking did not write [x]')
      await row.locator('[role="checkbox"][aria-checked="true"]').waitFor({ timeout: 5000 })
      await shot('01-today-ticked')
      await row.locator('[role="checkbox"]').click({ timeout: 3000 })
      if (!await waitFor(() => fs.readFileSync(todoFile, 'utf8').includes('- [ ] 确认印厂排期'))) throw new Error(`unticking left ${JSON.stringify(fs.readFileSync(todoFile, 'utf8'))}`)
      await row.locator('[role="checkbox"][aria-checked="false"]').waitFor({ timeout: 5000 })
    })

    // ── open the fixture page ────────────────────────────────────────────────────────────────────────────────
    await harness.requestMode(page, 'document')
    await page.locator('[data-shell-navigator="document"] section[aria-label="页面"] .ink-sb-label-btn', { hasText: '互动夹具' }).first().click()
    const panel = page.locator('[data-workbench-mode-panel="document"][data-mode-visual-state="current"]')
    const editor = panel.locator('[data-ready-block-editor]:visible').first()
    await editor.waitFor({ timeout: 20000 })
    await sleep(600)
    await shot('02-page-before')
    const rich = text => editor.locator('[data-rich-start]').filter({ hasText: new RegExp(`^${text}$`) })

    // ── 2. task boxes ────────────────────────────────────────────────────────────────────────────────────────
    await step('page: a task box ticks and unticks on click, and each state is saved', async () => {
      const box = name => editor.locator('[role="listitem"]', { hasText: name }).locator('[role="checkbox"]').first()
      await box('待办乙').click({ timeout: 3000 })
      await saved(text => text.includes('- [ ] 待办乙'), 'unticking 待办乙')
      await box('待办甲').click({ timeout: 3000 })
      await saved(text => text.includes('- [x] 待办甲'), 'ticking 待办甲')
      await box('待办甲').click({ timeout: 3000 })
      await saved(text => text.includes('- [ ] 待办甲') && text.includes('- [ ] 待办乙'), 'unticking 待办甲')
    })
    await step('page: a task box inside a callout toggles both ways', async () => {
      const box = editor.locator('[data-block-type="callout"]').locator('[role="checkbox"], input[type="checkbox"]').first()
      await box.click({ timeout: 3000 })
      await saved(text => text.includes('> - [x] 框内待办'), 'ticking inside the callout')
      await editor.locator('[data-block-type="callout"]').locator('[role="checkbox"], input[type="checkbox"]').first().click({ timeout: 3000 })
      await saved(text => text.includes('> - [ ] 框内待办'), 'unticking inside the callout')
    })

    // ── 3 / 4. the table ─────────────────────────────────────────────────────────────────────────────────────
    const table = editor.locator('[data-ready-table]').first()
    const cell = (row, column) => table.locator(`[data-table-cell="${row}:${column}"]`)
    const visible = async locator => (await locator.count()) > 0 && await locator.first().evaluate(el => Number(getComputedStyle(el).opacity) > 0.5 && getComputedStyle(el).visibility !== 'hidden')
    await step('table: a cell edits in place by clicking it', async () => {
      await cell(1, 1).click({ timeout: 3000 })
      await page.keyboard.press('End'); await page.keyboard.insertText('老师')
      await saved(text => text.includes('| 初稿 | 白老师 |'), 'typing in a cell')
    })
    await step('table: the add-row control shows near the bottom edge and adds a row', async () => {
      const add = table.getByRole('button', { name: '添加一行', exact: true })
      if (await visible(add)) throw new Error('the add-row control is visible before the pointer comes near')
      await table.scrollIntoViewIfNeeded(); await page.mouse.move(5, 5); await sleep(300)
      const box = await table.locator('table').boundingBox()
      await page.mouse.move(box.x + 40, box.y + box.height - 6, { steps: 4 })
      if (!await waitFor(() => visible(add), 3000)) throw new Error('the add-row control did not appear')
      await shot('03-table-add-row')
      await add.click()
      await saved(text => /\| 定稿 \| 编辑 \|\n\|\s+\|\s+\|\n/.test(text), 'adding a row')
    })
    await step('table: the add-column control shows near the right edge and adds a column', async () => {
      const add = table.getByRole('button', { name: '添加一列', exact: true })
      await page.mouse.move(5, 5); await sleep(200)
      const box = await table.locator('table').boundingBox()
      await page.mouse.move(box.x + box.width - 6, box.y + 12, { steps: 4 })
      if (!await waitFor(() => visible(add), 3000)) throw new Error('the add-column control did not appear')
      await shot('04-table-add-column')
      await add.click()
      await saved(text => /\| 阶段 \| 负责人 \|\s+\|\n\| --- \| --- \| --- \|/.test(text), 'adding a column')
    })
    await step('table: a column is inserted in the middle from the column handle, then deleted', async () => {
      await cell(0, 0).hover()
      const handle = table.getByRole('button', { name: '列操作', exact: true }).first()
      if (!await waitFor(() => visible(handle), 3000)) throw new Error('the column handle did not appear')
      await shot('05-table-column-handle')
      await handle.click()
      await shot('06-table-column-menu')
      await page.getByRole('menuitem', { name: '在右侧插入列', exact: true }).click()
      await saved(text => /\| 阶段 \|\s+\| 负责人 \|/.test(text) && /\| 初稿 \|\s+\| 白老师 \|/.test(text), 'inserting a column after the first')
      await cell(0, 1).click(); await page.keyboard.insertText('备注')
      await saved(text => text.includes('| 阶段 | 备注 | 负责人 |'), 'typing in the new header cell')
      await cell(0, 1).hover()
      await table.getByRole('button', { name: '列操作', exact: true }).first().click()
      await page.getByRole('menuitem', { name: '删除列', exact: true }).click()
      await saved(text => /\| 阶段 \| 负责人 \|/.test(text) && !text.includes('备注'), 'deleting the inserted column')
    })
    await step('table: a row is inserted in the middle from the row handle, then deleted', async () => {
      await cell(1, 0).hover()
      const handle = table.getByRole('button', { name: '行操作', exact: true }).first()
      if (!await waitFor(() => visible(handle), 3000)) throw new Error('the row handle did not appear')
      await handle.click()
      await page.getByRole('menuitem', { name: '在下方插入行', exact: true }).click()
      await saved(text => /\| 初稿 \| 白老师 \|[^\n]*\n\|\s+\|\s+\|[^\n]*\n\| 定稿/.test(text), 'inserting a row after the first body row')
      await cell(2, 0).hover()
      await table.getByRole('button', { name: '行操作', exact: true }).first().click()
      await page.getByRole('menuitem', { name: '删除行', exact: true }).click()
      await saved(text => /\| 初稿 \| 白老师 \|[^\n]*\n\| 定稿/.test(text), 'deleting the inserted row')
      await page.mouse.move(5, 5)
      await shot('07-table-after')
    })

    // ── 5. links: @, /链接页面, drag from the sidebar, moving an entry ───────────────────────────────────────
    const caretAtEnd = async locator => {
      await locator.click()
      await locator.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range) })
    }
    await step('links: @ searches the library and inserts a link to the chosen page at the caret', async () => {
      await caretAtEnd(rich('结尾段'))
      await page.keyboard.insertText(' @')
      await page.getByRole('combobox', { name: '搜索操作' }).fill('第二页')
      await page.getByRole('option', { name: /第二页/ }).first().waitFor({ timeout: 8000 })
      await shot('08-mention-search')
      await page.keyboard.press('Enter')
      await saved(text => /结尾段 \[第二页\]\(ready:\/\/[^)]*page\/[^)]+\)/.test(text), '@ link')
    })
    await step('links: /链接页面 opens the same search and inserts a page link', async () => {
      await caretAtEnd(rich('第一段正文'))
      await page.keyboard.press('Enter')
      await page.keyboard.insertText('/链接页面')
      await page.locator('.ready-slash-menu [data-slash-item="reference"][aria-selected="true"]').waitFor({ timeout: 5000 })
      await shot('09-slash-link')
      await page.keyboard.press('Enter')
      await page.getByRole('combobox', { name: '搜索操作' }).fill('链接目标')
      await page.getByRole('option', { name: /^链接目标/ }).first().waitFor({ timeout: 8000 })
      await page.keyboard.press('Enter')
      await saved(text => /第一段正文\n\n\[\[链接目标\]\]\n/.test(text), '/ link')
    })
    await step('links: a page row dragged from the sidebar shows a drop line and lands between the index entries', async () => {
      const source = page.locator('[data-shell-navigator="document"] section[aria-label="页面"] .ink-sb-row', { hasText: '拖入的页面' }).first()
      const target = editor.locator('[role="listitem"]', { hasText: '第二页' }).first()
      await target.scrollIntoViewIfNeeded(); await sleep(300)
      const from = await source.boundingBox(), to = await target.boundingBox()
      await page.mouse.move(from.x + 40, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + 60, from.y + from.height / 2 + 4, { steps: 3 })
      await page.mouse.move(to.x + 80, to.y + 3, { steps: 8 })
      await page.mouse.move(to.x + 82, to.y + 4, { steps: 2 })
      const line = await waitFor(() => editor.locator('[data-ref-drop]').count(), 3000)
      await shot('10-drag-drop-line')
      await page.mouse.up()
      if (!line) throw new Error('no drop line while dragging over the page')
      await saved(text => /- \[\[链接目标\]\]\n- \[拖入的页面\]\(ready:\/\/[^)]*page\/[^)]+\)\n- \[\[第二页\]\]/.test(text), 'dropping between the entries')
      await shot('11-drag-dropped')
    })
    await step('links: an index entry moves by dragging its marker', async () => {
      const marker = editor.locator('[role="listitem"]', { hasText: '第二页' }).locator('.ready-block-marker').first()
      const target = editor.locator('[role="listitem"]', { hasText: '链接目标' }).first()
      await target.scrollIntoViewIfNeeded(); await sleep(300)
      const from = await marker.boundingBox(), to = await target.boundingBox()
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2 + 6, from.y - 6, { steps: 3 })
      await page.mouse.move(to.x + 60, to.y + 3, { steps: 8 })
      await page.mouse.move(to.x + 62, to.y + 4, { steps: 2 })
      await page.mouse.up()
      await saved(text => /- \[\[第二页\]\]\n- \[\[链接目标\]\]\n- \[拖入的页面\]/.test(text), 'moving 第二页 above 链接目标')
    })

    // ── 6. editing in place ──────────────────────────────────────────────────────────────────────────────────
    await step('in place: a two-line quote edits by clicking it', async () => {
      const quote = editor.locator('[data-rich-start]', { hasText: '引用第一行' }).first()
      await caretAtEnd(quote)
      await page.keyboard.insertText('！')
      await saved(text => text.includes('> 引用第一行\n> 引用第二行！'), 'typing in the quote')
    })
    await step('in place: a callout title and body edit by clicking them', async () => {
      const callout = editor.locator('[data-block-type="callout"]').first()
      await caretAtEnd(callout.locator('[data-callout-title] [data-rich-start]'))
      await page.keyboard.insertText('改')
      await caretAtEnd(callout.locator('[data-rich-start]', { hasText: '提示正文一行' }).first())
      await page.keyboard.insertText('。')
      await saved(text => text.includes('> [!tip] 提示标题改\n> 提示正文一行。\n'), 'typing in the callout')
      await shot('12-callout-edit')
    })
    await step('in place: double-clicking a code block opens only that block’s source', async () => {
      const code = editor.locator('[data-block-type="code"]').first()
      await code.locator('pre, code').first().dblclick({ timeout: 3000 })
      const source = code.getByRole('textbox', { name: '块源码' })
      await source.waitFor({ timeout: 3000 })
      await source.fill((await source.inputValue()).replace('const a = 1', 'const a = 2'))
      await shot('13-code-source')
      await page.keyboard.press(`${mod}+Enter`)
      await saved(text => text.includes('```js\nconst a = 2\n```'), 'editing the code block')
    })
    await step('page: a task box in a block that stays rendered (a foldable callout) toggles both ways', async () => {
      const box = () => editor.locator('[data-block-type="callout"]', { hasText: '折叠待办' }).locator('input[type="checkbox"]').first()
      await box().click({ timeout: 3000 })
      await saved(text => text.includes('> - [x] 折叠待办'), 'ticking in the foldable callout')
      await box().click({ timeout: 3000 })
      await saved(text => text.includes('> - [ ] 折叠待办'), 'unticking in the foldable callout')
    })
    await shot('14-page-after')
    await step('in place: double-clicking the properties opens the frontmatter source, and the change is saved', async () => {
      await page.locator('[data-shell-navigator="document"] section[aria-label="页面"] .ink-sb-label-btn', { hasText: '属性夹具' }).first().click()
      const properties = panel.locator('.note-preview-properties:visible').first()
      await properties.waitFor({ timeout: 10000 })
      await properties.locator('[data-property-key="状态"]').dblclick()
      const source = panel.getByRole('textbox', { name: '块源码' })
      await source.waitFor({ timeout: 3000 })
      await source.fill((await source.inputValue()).replace('状态: 草稿', '状态: 定稿'))
      await shot('16-properties-source')
      await page.keyboard.press(`${mod}+Enter`)
      await page.keyboard.press(`${mod}+s`)
      const file = path.join(vault, '属性夹具.md')
      if (!await waitFor(() => fs.readFileSync(file, 'utf8').startsWith('---\ntags: [甲, 乙]\n状态: 定稿\n---\n'))) throw new Error(`the file reads ${fs.readFileSync(file, 'utf8')}`)
      await properties.locator('[data-property-key="状态"]', { hasText: '定稿' }).waitFor({ timeout: 5000 })
    })

    // ── 7. the import dialog ─────────────────────────────────────────────────────────────────────────────────
    await step('import: the dialog is 导入 Notion and offers no Inkwell choice', async () => {
      await page.getByRole('navigation', { name: '文档侧栏' }).getByRole('button', { name: '导入', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '导入 Notion', exact: true })
      await dialog.waitFor({ timeout: 5000 })
      await shot('15-import')
      if (/inkwell/i.test(await dialog.textContent())) throw new Error('the dialog still mentions Inkwell')
    })
  } finally { await harness.close(app) }

  const failed = results.filter(result => !result.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed. Shots: ${shots}\nFixture: ${base}`)
  if (failed.length) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
