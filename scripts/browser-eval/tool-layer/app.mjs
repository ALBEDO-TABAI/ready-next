// Electron Main entry for the browser tool-layer eval. Started by run.mjs, never directly.
// Every launch uses a throwaway profile. Nothing in this process may become visible, take focus
// or open anything outside the app: those calls are refused and counted as guard violations.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import 'tsx/esm'

// Deterministic public-name redirect fixture; DNS never leaves loopback.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP public.browser-eval.test 127.0.0.1')
app.commandLine.appendSwitch('no-proxy-server')

const guardViolations = []
function refuse(name) {
  return function refused(...args) {
    guardViolations.push({ call: name, detail: String(args[0] ?? '').slice(0, 200) })
    return name === 'shell.openExternal' ? Promise.resolve() : undefined
  }
}
for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'maximize', 'setFullScreen']) {
  BrowserWindow.prototype[method] = refuse(`BrowserWindow.${method}`)
}
app.focus = refuse('app.focus')
shell.openExternal = refuse('shell.openExternal')
shell.openPath = refuse('shell.openPath')
globalThis.__readyBrowserEvalGuardViolations = guardViolations

// A main-process error must never surface as Electron's error dialog: log it and exit instead.
const fatal = (error) => {
  process.stderr.write(`browser-eval-tools: ${error && error.stack ? error.stack : error}\n`)
  app.exit(2)
}
process.on('uncaughtException', fatal)
// Background rejections inside Ready (and late results of timed-out tool calls) are logged only.
process.on('unhandledRejection', (error) => {
  process.stderr.write(`browser-eval-tools: unhandled rejection: ${error && error.message ? error.message : error}\n`)
})

// run.mjs gives a throwaway root and points TMPDIR and HOME there.
const evalRoot = process.env.READY_BROWSER_EVAL_ROOT
if (!evalRoot || !process.env.HOME?.startsWith(evalRoot) || !process.env.TMPDIR?.startsWith(evalRoot)) {
  fatal(new Error('start the tool-layer eval through scripts/browser-eval/tool-layer/run.mjs'))
}
const profile = join(evalRoot, 'profile')
const downloads = join(profile, 'downloads')
mkdirSync(downloads, { recursive: true })
app.setPath('userData', profile)
app.setPath('downloads', downloads)
process.env.READY_DB_PATH = join(profile, 'ready.db')
process.env.READY_USER_DATA_DIR = profile
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')

const reportPath = process.env.READY_BROWSER_EVAL_REPORT
const only = (process.env.READY_BROWSER_EVAL_ONLY || '').split(',').map((item) => item.trim()).filter(Boolean)

app.whenReady().then(async () => {
  let exitCode = 1
  try {
    const { runToolLayerEval } = await import('./main.ts')
    const report = await runToolLayerEval({ profile, downloads, only, guardViolations })
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    exitCode = report.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
    exitCode = 2
  } finally {
    rmSync(profile, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
