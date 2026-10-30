// Build first (electron-vite build). Real-Electron smoke for the ready-next branch.
// Every launch uses a throwaway profile or a fake HOME; the daily Ready data is never opened.
const { _electron } = require('playwright')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` — ${detail}`}`)
  if (!pass) process.exitCode = 1
}

function step(label) {
  console.log(`… ${label}`)
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
  ])
}

function electronEnv(extra) {
  const env = { ...process.env, READY_START_HIDDEN: '1', ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(profile) {
  step('launch Electron')
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [process.cwd()],
    env: electronEnv({ READY_USER_DATA_DIR: profile }),
    timeout: 45000,
  })
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const page = app.windows().find(w => w.url().includes('/renderer/index.html'))
    if (page) { step(`renderer ready: ${page.url()}`); return { app, page } }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  await app.close()
  throw new Error('Ready Next renderer did not start')
}

// I2: exercise a real file-tree open, the Ready move command, the live watcher and restart.
async function checkObjectPresentationBeforeRestart(app, page, root) {
  const from = path.join(root, 'i2-a.md'), internal = path.join(root, 'i2-b.md'), external = path.join(root, 'i2-c.md')
  const source = '# I2 reading fixture\n\n' + Array.from({ length: 160 }, (_, i) => `Paragraph ${i + 1}: reading position follows this object.\n`).join('\n')
  fs.writeFileSync(from, source)
  const mtime = fs.statSync(from).mtimeMs
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/renderer/index.html')) window.setSize(1500, 1000)
  })
  // Seed the previous format in this throwaway profile to exercise the real migration handshake.
  await page.evaluate(({ root, from }) => {
    localStorage.setItem('ready-workspace-root', root)
    localStorage.setItem('ready-pinned-folders', JSON.stringify([root]))
    localStorage.removeItem('ready-object-presentation-migration-v1')
    localStorage.setItem('ready-file-appearances-v1', JSON.stringify({ [from]: { color: 'red', icon: '🐙' } }))
    localStorage.setItem('ready-document-reading-positions-v1', JSON.stringify([{ key: from, updatedAt: Date.now(), top: 400, ratio: 0.1, maxScroll: 4000, anchorTitle: null, anchorOrdinal: null, anchorProgress: null }]))
  }, { root, from })
  await page.reload()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
  // The vault is a pinned folder that starts collapsed; expand it the way a person would.
  const fileRow = page.getByText('i2-a.md', { exact: true }).first()
  if (!await fileRow.isVisible().catch(() => false)) await page.getByText(path.basename(root), { exact: true }).first().click({ timeout: 20000 })
  await fileRow.click({ timeout: 20000 })
  await page.waitForFunction(from => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.path === from && tab.objectId), from)
  const identity = await page.evaluate(from => window.electronAPI.objects.resolvePath(from), from)
  ok('C2 opening a real file leaves its bytes and mtime unchanged', fs.readFileSync(from, 'utf8') === source && fs.statSync(from).mtimeMs === mtime)
  await page.waitForFunction(() => !localStorage.getItem('ready-file-appearances-v1') && !localStorage.getItem('ready-document-reading-positions-v1'))
  const before = await page.evaluate(id => ({
    appearance: JSON.parse(localStorage.getItem('ready-object-appearances-v1') || '{}')[id],
    position: JSON.parse(localStorage.getItem('ready-object-reading-positions-v1') || '[]').find(row => row.key === id),
  }), identity.objectId)
  ok('C2 migration retains appearance and reading position under the object ID', before.appearance?.icon === '🐙' && before.position?.top > 0, JSON.stringify(before))
  const renamed = await page.evaluate(({ from, internal }) => window.electronAPI.document.rename(from, internal), { from, internal })
  ok('C2 Ready rename succeeds', renamed.success, JSON.stringify(renamed))
  await page.waitForFunction(({ id, to }) => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.objectId === id && tab.path === to), { id: identity.objectId, to: internal })
  fs.renameSync(internal, external)
  await page.waitForFunction(({ id, to }) => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.objectId === id && tab.path === to), { id: identity.objectId, to: external }, { timeout: 20000 })
  ok('C2 external mv updates the open tab through the real watcher', true)
  ok('C2 open and both moves never insert ready_id', fs.readFileSync(external, 'utf8') === source)
  return { objectId: identity.objectId, path: external }
}

async function checkObjectPresentationAfterRestart(page, identity) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document', placement: 'open', presentation: 'immediate' } })))
  await page.waitForFunction(({ objectId, path }) => JSON.parse(localStorage.getItem('ready-doc-tabs-v2') || '{}').state?.tabs.some(tab => tab.objectId === objectId && tab.path === path && tab.objectBinding?.status === 'resolved'), identity)
  const restored = await page.evaluate(({ objectId }) => ({
    tabs: JSON.parse(localStorage.getItem('ready-doc-tabs-v2')).state.tabs.filter(tab => tab.objectId === objectId),
    appearance: JSON.parse(localStorage.getItem('ready-object-appearances-v1') || '{}')[objectId],
    position: JSON.parse(localStorage.getItem('ready-object-reading-positions-v1') || '[]').find(row => row.key === objectId),
  }), identity)
  ok('C2 reopening retains one tab, appearance and reading position', restored.tabs.length === 1 && restored.appearance?.icon === '🐙' && restored.position?.top > 0, JSON.stringify(restored))
  await page.locator('.document-path-bar').getByText(identity.path, { exact: true }).waitFor({ timeout: 20000 })
  ok('C2 the visible document header shows the final path', true)
  await page.waitForFunction(path => Array.from(document.querySelectorAll('[data-ready-document-scroll-key]')).some(scope =>
    scope.getAttribute('data-ready-document-scroll-key') === path && [scope, ...scope.querySelectorAll('*')].some(element => element.scrollTop > 0)), identity.path, { timeout: 20000 })
  ok('C2 the reopened document visibly restores its reading position', true)
  // The document tab rail renders each tab with its title attribute; the custom icon is its visible glyph.
  const iconShown = await page.waitForFunction(name => [...document.querySelectorAll('[title]')]
    .some(el => el.getAttribute('title').startsWith(name) && el.textContent.includes('🐙')), path.basename(identity.path), { timeout: 15000 }).then(() => true, () => false)
  ok('C2 the reopened tab visibly retains its custom icon', iconShown)
}

async function checkIdentityAndFastCard() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-smoke-'))
  let app
  let page
  try {
    ;({ app, page } = await launch(profile))
    const identity = await withTimeout(app.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath('userData') })), 20000, 'read app identity')
    ok('C15 app identifies as Ready Next', identity.name === 'Ready Next', JSON.stringify(identity))
    ok('C15 userData is the isolated profile', fs.realpathSync(identity.userData) === fs.realpathSync(profile), JSON.stringify(identity))

    const vault = await withTimeout(page.evaluate(() => window.electronAPI.vault.get()), 20000, 'read vault state')
    ok('D17 a fresh dev profile has no vault and suggests a test vault inside the profile',
      vault.status === 'unconfigured' && fs.realpathSync(path.dirname(vault.defaultSuggestion)) === fs.realpathSync(profile), JSON.stringify(vault))
    const created = await withTimeout(page.evaluate(() => window.electronAPI.vault.createDefault()), 20000, 'create default vault')
    ok('D17 creating the default vault makes it ready inside the profile',
      created.status === 'ready' && fs.realpathSync(created.root).startsWith(fs.realpathSync(profile)), JSON.stringify(created))

    const item = {
      id: `smoke-${Date.now()}`, kind: 'text', createdAt: Date.now(), text: 'ready-next smoke',
      source: { pageUrl: 'https://example.test/', pageTitle: 'Example', domain: 'example.test', capturedAt: Date.now() },
    }
    const added = await withTimeout(page.evaluate(entry => window.electronAPI.browser.addFastCardItem(entry), item), 20000, 'add FastCard item')
    ok('C7 FastCard add returns a persisted receipt', added?.success === true && added.data?.id === item.id, JSON.stringify(added))
    const objectIdentity = await checkObjectPresentationBeforeRestart(app, page, created.root)
    step('close app')
    await withTimeout(app.close(), 150000, 'close app')

    ;({ app, page } = await launch(profile))
    await checkObjectPresentationAfterRestart(page, objectIdentity)
    const reopenedVault = await withTimeout(page.evaluate(() => window.electronAPI.vault.get()), 20000, 'read vault after restart')
    ok('D17 the vault setting survives a restart', reopenedVault.status === 'ready' && reopenedVault.root === created.root, JSON.stringify(reopenedVault))
    const listed = await withTimeout(page.evaluate(() => window.electronAPI.browser.listFastCardItems()), 20000, 'list FastCard items')
    const restored = listed?.success === true && listed.data.find(entry => entry.id === item.id)
    ok('C7 FastCard item survives a restart', restored && restored.text === item.text && restored.source?.pageUrl === item.source.pageUrl, JSON.stringify(listed))
    step('close app')
    await withTimeout(app.close(), 150000, 'close app')
    app = undefined
  } finally {
    // A failed check must not leave Electron running, or the script never exits.
    if (app) await withTimeout(app.close(), 30000, 'close app after failure').catch(() => app.process().kill('SIGKILL'))
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

// Electron resolves the home folder without $HOME, so the real daily folder cannot be faked.
// The guard accepts extra protected folders (it can never drop the daily one); protect a
// throwaway folder and point userData inside it.
function checkDailyDataRefusal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-protected-'))
  const daily = path.join(root, 'Ready')
  fs.mkdirSync(daily, { recursive: true })
  try {
    const run = spawnSync(require('electron'), [process.cwd()], {
      env: electronEnv({ READY_NEXT_EXTRA_PROTECTED_DIRS: daily, READY_USER_DATA_DIR: path.join(daily, 'nested') }),
      timeout: 30000,
      encoding: 'utf8',
    })
    ok('C15 an override inside the daily Ready folder exits with code 1', run.status === 1,
      `status=${run.status} signal=${run.signal} stderr=${String(run.stderr).slice(0, 400)}`)
    ok('C15 the refused boot creates nothing inside the daily folder', !fs.existsSync(path.join(daily, 'nested')))
    ok('C15 the refusal explains why', /cannot use daily Ready data/.test(String(run.stderr)), String(run.stderr).slice(0, 400))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

;(async () => {
  try {
    await checkIdentityAndFastCard()
    checkDailyDataRefusal()
  } catch (error) {
    ok('smoke run completed', false, error instanceof Error ? error.stack : String(error))
  }
  const failed = results.filter(r => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})()
