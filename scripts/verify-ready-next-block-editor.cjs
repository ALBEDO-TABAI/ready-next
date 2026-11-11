// Build this checkout first (npm run build). Run outside the windowless sandbox.
// All files, drafts, and app state belong to fresh temporary directories.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require('playwright')

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-next-block-editor-profile-'))
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-next-block-editor-vault-'))
  const file = path.join(vault, '块编辑夹具.md')
  const prefix = '\uFEFF---\r\ntitle: "保留标题" # 原注释\r\n---\r\n\r\n'
  const middle = '\r\n\r\n<!-- 未编辑的中间片段 😀 -->\n\n'
  const widget = '```show-widget\r\n{"id":"block-proof","title":"验收卡","widget_code":"<section><p>Widget 原文</p></section>"}\r\n```'
  const suffix = '\r\n\r\n```js\r\nconst untouched = "é😀";\r\n```\n\n不改结尾'
  const original = prefix + '编辑甲乙' + middle + widget + suffix
  await fs.writeFile(file, original)
  const linkedFile = path.join(vault, '链接目标.md')
  await fs.writeFile(linkedFile, '# 链接目标\n\n## 章节一\n\n引用正文')
  const env = { ...process.env, READY_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.READY_START_HIDDEN
  const launch = async () => {
    const launched = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
    let window
    const deadline = Date.now() + 45000
    while (!window && Date.now() < deadline) {
      window = launched.windows().find(candidate => candidate.url().includes('/renderer/index.html'))
      if (!window) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(window, 'Ready Next renderer must open')
    return { launched, window }
  }
  let { launched: app, window: page } = await launch()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  try {
    await page.evaluate(async root => {
      await window.electronAPI.vault.set(root)
      localStorage.setItem('ready-workspace-root', root)
      localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    }, vault)
    // Start again on the same profile instead of reloading; a reload could stall under Playwright.
    await app.close()
    ;({ launched: app, window: page } = await launch())
    const enterDeadline = Date.now() + 30000
    while (!await page.locator('.ink-doc-app').isVisible()) {
      assert.ok(Date.now() < enterDeadline, 'Document mode must become visible')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', {
        detail: { mode: 'document', placement: 'open', presentation: 'immediate' },
      })))
      await page.waitForTimeout(150)
    }
    // The outer sidebar is the file manager.
    const row = page.getByText(path.basename(file), { exact: true }).first()
    if (!await row.isVisible()) await page.getByText(path.basename(vault), { exact: true }).first().click()
    await row.click()
    const panel = page.locator('[data-workbench-mode-panel="document"][data-mode-visual-state="current"]')
    await panel.waitFor({ state: 'visible' })
    const editor = panel.locator('[data-ready-block-editor]:visible').first()
    await editor.waitFor()
    await editor.evaluate(element => new Promise((resolve, reject) => {
      let previous
      const deadline = Date.now() + 15000
      const sample = () => {
        if (Date.now() >= deadline) { reject(new Error('Block editor geometry did not stabilize')); return }
        const bounds = element.getBoundingClientRect()
        const current = [bounds.x, bounds.y, bounds.width, bounds.height]
        if (bounds.width > 0 && bounds.height > 0 && previous?.every((value, index) => value === current[index])) resolve()
        else { previous = current; requestAnimationFrame(sample) }
      }
      requestAnimationFrame(sample)
    }))
    assert.deepEqual(await fs.readFile(file), Buffer.from(original), 'opening leaves disk bytes intact')
    const paragraph = editor.locator('[contenteditable="true"]').filter({ hasText: /^编辑甲乙$/ })
    await paragraph.click()
    await paragraph.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(false)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.insertText('中文')
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter')
    await editor.locator('[contenteditable="true"]').filter({ hasText: /^中文$/ }).waitFor()
    console.log('PASS open fixture → Chinese input → Enter splits the paragraph')
    await page.keyboard.press(`${mod}+z`)
    await editor.locator('[contenteditable="true"]').filter({ hasText: /^编辑甲乙中文$/ }).waitFor()
    console.log('PASS undo restores the unsplit paragraph')
    const card = editor.locator('[data-block-type="widget"]').first()
    await card.getByRole('button', { name: '编辑源码', exact: true }).click()
    const source = card.getByRole('textbox', { name: '块源码' })
    await source.fill((await source.inputValue()).replace('Widget 原文', 'Widget 新文'))
    await card.getByRole('button', { name: '完成', exact: true }).click()
    await source.waitFor({ state: 'detached' })
    await page.keyboard.press(`${mod}+s`)
    const expected = original.replace('编辑甲乙', '编辑甲乙中文').replace('Widget 原文', 'Widget 新文')
    const saveDeadline = Date.now() + 15000
    let saved = await fs.readFile(file)
    while (!saved.equals(Buffer.from(expected)) && Date.now() < saveDeadline) {
      await page.waitForTimeout(100); saved = await fs.readFile(file)
    }
    assert.deepEqual(saved, Buffer.from(expected), `saved file must exactly match all expected UTF-8 bytes; alerts: ${await page.getByRole('alert').allTextContents()}`)
    const text = saved.toString('utf8')
    assert.deepEqual(saved.subarray(0, Buffer.byteLength(prefix)), Buffer.from(prefix))
    assert.deepEqual(saved.subarray(saved.length - Buffer.byteLength(suffix)), Buffer.from(suffix))
    assert.deepEqual(Buffer.from(text.slice(text.indexOf(middle), text.indexOf(middle) + middle.length)), Buffer.from(middle))
    // T4b: exercise the actual rendered controls, keyboard focus and persisted bytes.
    const readback = async wanted => {
      await page.keyboard.press(`${mod}+s`)
      const deadline = Date.now() + 15000
      let actual = await fs.readFile(file)
      while (!actual.equals(Buffer.from(wanted)) && Date.now() < deadline) {
        await page.waitForTimeout(100); actual = await fs.readFile(file)
      }
      assert.deepEqual(actual, Buffer.from(wanted), `T4b byte readback; alerts: ${await page.getByRole('alert').allTextContents()}`)
    }
    const richText = text => editor.locator('[contenteditable="true"]').filter({ hasText: new RegExp(`^${text}$`) })
    const firstText = '编辑甲乙中文'
    const firstHandle = () => richText(firstText).locator('xpath=..').getByRole('button', { name: '块菜单', exact: true })
    await firstHandle().focus()
    await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape')
    await readback(expected)
    await firstHandle().focus()
    await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    const editedWidget = widget.replace('Widget 原文', 'Widget 新文')
    await richText(firstText).focus()
    await readback(expected.replace(firstText, '').replace(editedWidget, editedWidget + '\r\n\r\n' + firstText))
    await page.keyboard.press(`${mod}+z`); await readback(expected)
    console.log('PASS keyboard drag preview → Escape; drag → drop → one undo; exact disk bytes')

    // Pointer drag uses the real HTML drag/drop events, not an injected operation.
    const tailBlock = richText('不改结尾').locator('xpath=..')
    await firstHandle().dragTo(tailBlock, { targetPosition: { x: 15, y: (await tailBlock.boundingBox()).height - 2 } })
    await richText(firstText).focus()
    await readback(expected.replace(firstText, '') + '\r\n\r\n' + firstText)
    await page.keyboard.press(`${mod}+z`); await readback(expected)
    console.log('PASS pointer handle drag → drop → one undo')

    await firstHandle().focus(); await page.keyboard.press('Enter')
    await page.getByRole('combobox', { name: '搜索操作' }).fill('标题 2')
    await page.keyboard.press('Enter'); await readback(expected.replace(firstText, '## ' + firstText))
    await page.keyboard.press(`${mod}+z`); await readback(expected)
    console.log('PASS keyboard block menu conversion and focus restoration')

    await richText(firstText).focus()
    await richText(firstText).evaluate(element => {
      const selection = window.getSelection(), range = document.createRange()
      range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.press('Alt+F10')
    const toolbar = page.getByRole('toolbar', { name: '文字格式' })
    await toolbar.getByRole('button', { name: '粗体', exact: true }).focus(); await page.keyboard.press('Enter')
    await readback(expected.replace(firstText, '**' + firstText + '**'))
    await page.keyboard.press(`${mod}+z`); await readback(expected)
    console.log('PASS selected text → keyboard inline toolbar → bold → exact Markdown → undo')

    await richText(firstText).focus()
    await richText(firstText).evaluate(element => {
      const selection = window.getSelection(), range = document.createRange()
      range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range)
    })
    // The slash query is typed in the page itself (W3 §4.3): no search field.
    await page.keyboard.insertText('/widget')
    await page.locator('.ready-slash-menu [data-slash-item="widget"][aria-selected="true"]').waitFor(); await page.keyboard.press('Enter')
    await page.getByRole('dialog', { name: '编辑 widget', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await editor.locator('[contenteditable="true"]').filter({ hasText: /^\/$/ }).focus()
    await page.keyboard.press(`${mod}+z`); await readback(expected)
    console.log('PASS slash → existing Widget drawer → cancel without inserting a placeholder')

    const indexed = await page.evaluate(async ({ target, root }) => window.electronAPI.document.indexDocument({ path: target, root }), { target: linkedFile, root: vault })
    assert.ok(indexed.success, JSON.stringify(indexed))
    await richText(firstText).focus()
    await richText(firstText).evaluate(element => {
      const selection = window.getSelection(), range = document.createRange()
      range.selectNodeContents(element); range.collapse(false); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.insertText('[[')
    await page.getByRole('combobox', { name: '搜索操作' }).fill('链接目标#章节一')
    await page.getByRole('option', { name: /章节一/ }).waitFor()
    await page.keyboard.press('Enter')
    // Canonical target: relative to the edited page's folder, as the object link repair keeps it.
    const wiki = `[[${path.relative(path.dirname(file), linkedFile).replace(/\.md$/, '')}#章节一]]`
    await readback(expected.replace(firstText, firstText + wiki))
    await page.keyboard.press(`${mod}+z`); await page.keyboard.press(`${mod}+z`); await readback(expected)
    console.log('PASS [[ → real global index → heading choice → exact wiki source → undo')
    await page.screenshot({ path: path.join(profile, 'block-editor.png') })
    console.log('PASS Widget source → save → file readback; every unedited interval is byte-identical')
    console.log(`Evidence: ${profile}\nFixture: ${file}`)
  } finally { await app.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
