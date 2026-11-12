import { configureWebMcpExperiment, readWebMcpStartupSetting } from './modules/browser-engine/webmcp-experiment'
import { captureCalendarOpen } from './calendar-open-intents'
import { config } from 'dotenv'
import { delimiter, resolve } from 'path'

// Load .env from project root (before anything else)
config({ path: resolve(__dirname, '../../.env') })

import { app, dialog, protocol } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { toOAuthCompatibleUserAgent } from './modules/browser-engine/popup-policy'
import { createStartupSplashWindow, yieldToPresentation } from './startup-splash-window'
import { logBootStage, startBootStallProbe } from './boot-timing'
import { assertReadyNextDataIsolation } from './ready-next-data-isolation'
import { resolveReadyDatabasePath } from './modules/database-path'

/**
 * 主进程微入口（build 入口指向本文件，产物仍为 out/main/index.js）。
 * 职责只有两件：
 * 1) app ready 之前必须完成的进程级配置（协议注册、命令行开关、userData 路径等）；
 * 2) ready 后第一时间亮启动动画，然后才动态加载重模块 ./index。
 * 任何新增静态 import 都会把它的整棵依赖树求值成本压回 splash 之前，
 * 回归围栏：startup-splash-fast-path-contract.test.ts（入口 import 白名单）。
 */

app.setName('Ready Next')
app.on('open-file', (event, path) => { if(captureCalendarOpen({kind:'file',value:path}))event.preventDefault() })
app.on('open-url', (event, url) => { if(captureCalendarOpen({kind:'url',value:url}))event.preventDefault() })
for(const value of process.argv)captureCalendarOpen({kind:value.startsWith('ready-next:')?'url':'file',value})

const READY_USER_DATA_DIR = process.env.READY_USER_DATA_DIR?.trim()
const READY_START_HIDDEN = process.env.READY_START_HIDDEN === '1'
try {
  const userData = READY_USER_DATA_DIR || app.getPath('userData')
  const extraProtected = (process.env.READY_NEXT_EXTRA_PROTECTED_DIRS ?? '').split(delimiter).filter(Boolean)
  assertReadyNextDataIsolation(userData, resolveReadyDatabasePath(userData, process.env.READY_DB_PATH), app.getPath('home'), extraProtected)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[boot-entry] data isolation check failed:', message)
  try {
    // Hidden starts are automation: a modal box would block exit until someone dismisses it.
    if (!READY_START_HIDDEN) dialog.showErrorBox('Ready Next 启动失败', message)
  } finally {
    // process.exit halts synchronously; app.exit would let the rest of this
    // module (mkdir, lock, startup) keep running against the forbidden path.
    process.exit(1)
  }
}
if (READY_USER_DATA_DIR) {
  mkdirSync(READY_USER_DATA_DIR, { recursive: true })
  app.setPath('userData', READY_USER_DATA_DIR)
}

// Single-instance lock is scoped to the resolved userData dir (Electron keeps
// the SingletonLock file there), so it must run AFTER the userData override —
// an isolated acceptance profile keeps its own lock and never collides with the
// daily instance. Two instances on the SAME userData share one SQLite, and the
// second boot's startup reconciler would reap the first process's in-flight run
// as "leftover" (root cause of the core_closeout_terminal_retry_conflict / ghost
// run observed 2026-07-23). The runtime models process handoff as boot=prior-dead,
// which is only true when a single instance is enforced here.
const READY_ALLOW_MULTI_INSTANCE = process.env.READY_ALLOW_MULTI_INSTANCE === '1'
if (!READY_ALLOW_MULTI_INSTANCE && !app.requestSingleInstanceLock()) {
  app.exit(0)
}

configureWebMcpExperiment(readWebMcpStartupSetting(resolveReadyDatabasePath(app.getPath('userData'), process.env.READY_DB_PATH)), app.commandLine)

// Crash forensics (opt-in via READY_PROC_DIAG=1): synchronous stderr timeline
// of webContents creation / main-frame navigation starts / renderer deaths.
// Synchronous on purpose — when the main process dies mid-crash, async logs
// vanish with it; this is the tool that pinned the 2026-07-04 startup crash.
if (process.env.READY_PROC_DIAG === '1') {
  const diagT0 = Date.now()
  const diagWrite = (line: string) => {
    try {
      appendFileSync('/dev/fd/2', `[proc-diag +${((Date.now() - diagT0) / 1000).toFixed(2)}s] ${line}\n`)
    } catch {
      // stderr gone — nothing left to report to
    }
  }
  app.on('web-contents-created', (_event, wc) => {
    const id = wc.id
    diagWrite(`wc#${id} created type=${wc.getType()}`)
    wc.on('did-start-navigation', ((event: { isMainFrame?: boolean; url?: string }) => {
      if (event && event.isMainFrame === false) return
      diagWrite(`wc#${id} nav-start url=${String(event?.url ?? '').slice(0, 100)}`)
    }) as never)
    wc.on('render-process-gone', (_ev, details) => {
      diagWrite(`wc#${id} RENDER-GONE ${JSON.stringify(details)} lastURL=${wc.getURL().slice(0, 100)}`)
    })
    wc.on('destroyed', () => diagWrite(`wc#${id} destroyed`))
  })
}

// index.ts 的 ensureRegularDockApp 服务后续 dock 显隐流转；这里只做启动期同款保证。
if (process.platform === 'darwin') {
  app.setActivationPolicy(READY_START_HIDDEN ? 'prohibited' : 'regular')
}

// Register local-file as a privileged scheme BEFORE app.whenReady()
// This is required for video streaming (range requests), fetch API support, etc.
// Keep auth popups (OAuth / SSO) available inside BrowserView-based tabs.
app.commandLine.appendSwitch('disable-popup-blocking')
// FedCM can become a no-op inside BrowserView on some Electron builds.
// Force legacy OAuth popup flow for stable third-party login behavior.
app.commandLine.appendSwitch('disable-features', 'FedCm')
const remoteDebuggingPort = process.env.READY_REMOTE_DEBUGGING_PORT?.trim()
if (remoteDebuggingPort) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
}
app.userAgentFallback = toOAuthCompatibleUserAgent(app.userAgentFallback)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    }
  }
])

app.whenReady().then(async () => {
  logBootStage('app-ready')
  startBootStallProbe()
  // createStartupSplashWindow 内部会等到 splash 首帧真正呈现（ready-to-show +
  // 帧跑道回执）才 resolve。顺序不可倒置：窗口首帧 commit 期间若主线程被重模块
  // 求值阻塞，呈现管线会被卡死（真机复现过全程隐形/整段冻结）。
  if (!READY_START_HIDDEN) {
    await createStartupSplashWindow()
    logBootStage('splash-visible')
  }
  // 重模块分片预热：新窗口最初几秒的帧呈现耦合主进程活性（透明与否皆然），
  // 5.2MB 一次性求值的实心块会把启动动画整段冻住。按子系统切片 import、
  // 片间让出宏任务给合成器出帧；顺序与 index.ts 顶部 import 次序一致，
  // 最终 import('./index') 只剩残量求值。共享依赖不会重复求值。
  const warmupModules: Array<() => Promise<unknown>> = [
    () => import('./modules/claude-bridge/ipc-handler'),
    () => import('./modules/browser-engine/ipc-handler'),
    () => import('./modules/document-engine/ipc-handler'),
    () => import('./modules/search-engine/ipc-handler'),
    () => import('./modules/rss-engine/ipc-handler'),
    () => import('./modules/calendar-engine/reminder-scheduler'),
    () => import('./modules/database'),
    () => import('./modules/skills-runtime/ipc-handler'),
    () => import('electron-updater'),
  ]
  for (const loadWarmupModule of warmupModules) {
    await loadWarmupModule()
    await yieldToPresentation()
  }
  logBootStage('app-module-prewarmed')
  await import('./index')
  logBootStage('app-module-loaded')
}).catch((error) => {
  // 重模块求值失败必须响亮：留 console 痕迹并弹框退出，不能让 splash 永远转下去。
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error('[boot-entry] app module failed to load:', message)
  try {
    dialog.showErrorBox('Ready 启动失败', message)
  } catch {
    // showErrorBox can fail in headless checks; the console log above remains.
  }
  app.exit(1)
})
