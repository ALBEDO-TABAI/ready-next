// Build the current checkout first. Claude runs this outside the windowless sandbox.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { _electron } from 'playwright'
const require = createRequire(import.meta.url)
const profile = await mkdtemp(join(tmpdir(), 'ready-next-drafts-profile-'))
const vault = await mkdtemp(join(tmpdir(), 'ready-next-drafts-vault-'))
const parent = join(vault, '验收目录')
await mkdir(parent)
const env = { ...process.env, READY_USER_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
const text = '# 强制退出恢复\n\n中文、Emoji 🐾，以及未保存的正文。\n'
let app
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [process.cwd()], env, timeout: 45000 })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const page = app.windows().find(page => page.url().includes('/renderer/index.html'))
    if (page) return page
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Ready Next window did not appear')
}
async function enterDocument(page) {
  // The workbench listens for mode requests only after it mounts; repeat the request until Document is visible.
  const controls = page.getByTestId('draft-controls')
  const deadline = Date.now() + 30000
  while (!await controls.isVisible().catch(() => false)) {
    if (Date.now() > deadline) throw new Error('Document mode did not become visible')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', {
      detail: { mode: 'document', placement: 'open', presentation: 'immediate' },
    })))
    await page.waitForTimeout(500)
  }
}
async function sourceEditor(page) {
  const editor = page.locator('textarea.document-source-textarea:visible').first()
  if (!await editor.isVisible()) await page.locator('.draggable-mode-switch__label--edit:visible').first().click()
  await editor.waitFor()
  return editor
}
try {
  let page = await launch()
  await page.evaluate(async root => {
    await window.electronAPI.vault.set(root)
    localStorage.setItem('ready-workspace-root', root)
    localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
  }, vault)
  await page.reload()
  await enterDocument(page)
  await (await sourceEditor(page)).fill(text)
  await page.getByTestId('draft-status').filter({ hasText: '已持久确认' }).waitFor()
  const original = await page.evaluate(async content => {
    const result = await window.electronAPI.documentDrafts.list()
    if (!result.ok) throw new Error(result.message)
    return result.value.find(draft => draft.content === content)
  }, text)
  assert.ok(original, 'confirmed body must exist in Main')
  // Do not call app.close(): that would run graceful-exit persistence.
  const exited = once(app.process(), 'exit')
  app.process().kill('SIGKILL')
  await exited
  app = undefined
  page = await launch()
  await enterDocument(page)
  assert.equal(await (await sourceEditor(page)).inputValue(), text)
  console.log('PASS input → durable confirmation → SIGKILL → restart → exact body')

  // Remove only the isolated profile's tab metadata, proving orphan recovery from Main.
  await page.evaluate(() => localStorage.removeItem('ready-doc-tabs-v2'))
  await page.reload()
  await enterDocument(page)
  await page.getByRole('button', { name: /^未保存的草稿/ }).click()
  await page.getByTestId(`draft-recovery-${original.draftId}`).getByRole('button', { name: original.title || '未命名草稿', exact: true }).click()
  assert.equal(await (await sourceEditor(page)).inputValue(), text)
  await page.getByRole('button', { name: '保存到…', exact: true }).click()
  await page.getByLabel('草稿标题').fill('重启后的定稿')
  // Supply only the native picker response; the production dialog and finalize IPC run normally.
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, parent)
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await page.getByRole('dialog', { name: '保存到', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await readFile(join(parent, '重启后的定稿.md'), 'utf8'), text)
  const finalized = await page.evaluate(async id => window.electronAPI.documentDrafts.read(id), original.draftId)
  assert.ok(finalized.ok && finalized.value?.state === 'finalized')
  console.log('PASS recovery entry → Save to folder → finalized receipt → exact file readback')
  console.log(`Isolated evidence retained: ${profile}\nVault: ${vault}`)
} finally {
  if (app) await app.close()
}
