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

async function checkIdentityAndFastCard() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-smoke-'))
  let app
  let page
  try {
    ;({ app, page } = await launch(profile))
    const identity = await withTimeout(app.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath('userData') })), 20000, 'read app identity')
    ok('C15 app identifies as Ready Next', identity.name === 'Ready Next', JSON.stringify(identity))
    ok('C15 userData is the isolated profile', fs.realpathSync(identity.userData) === fs.realpathSync(profile), JSON.stringify(identity))

    const item = {
      id: `smoke-${Date.now()}`, kind: 'text', createdAt: Date.now(), text: 'ready-next smoke',
      source: { pageUrl: 'https://example.test/', pageTitle: 'Example', domain: 'example.test', capturedAt: Date.now() },
    }
    const added = await withTimeout(page.evaluate(entry => window.electronAPI.browser.addFastCardItem(entry), item), 20000, 'add FastCard item')
    ok('C7 FastCard add returns a persisted receipt', added?.success === true && added.data?.id === item.id, JSON.stringify(added))
    step('close app')
    await withTimeout(app.close(), 150000, 'close app')

    ;({ app, page } = await launch(profile))
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
