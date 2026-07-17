import { fork, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import {
  install,
  getInstalledBrowsers,
  canDownload,
  detectBrowserPlatform,
  Browser,
} from '@puppeteer/browsers'
import {
  buildWorkerForkOptions,
  killWorkerProcessTree,
  type KillFn,
} from './rsshub-process-cleanup'
import { RSSHubIdleLifecycle } from './rsshub-idle-lifecycle'

/**
 * Production kill seam for the worker. Wraps `process.kill` so the helper
 * sees a uniform `(pid, signal) => boolean` shape and ESRCH is reflected as
 * a thrown error (which the helper treats as "already gone").
 */
const processKillFn: KillFn = (pid, signal) => {
  process.kill(pid, signal)
  return true
}

type RSSHubState = 'stopped' | 'starting' | 'running' | 'error'

interface ReadyMessage {
  type: 'ready'
  port: number
}

interface ErrorMessage {
  type: 'error'
  message: string
  code?: string
}

type WorkerMessage = ReadyMessage | ErrorMessage

type ChromiumSource = 'env' | 'cache' | 'system' | 'downloaded' | 'none'

export interface RSSHubChromiumStatus {
  ready: boolean
  executablePath: string | null
  source: ChromiumSource
  cacheDir: string
  buildId: string
  downloadSupported: boolean | null
  lastCheckedAt: string | null
  lastError: string | null
}

export interface RSSHubRuntimeStatus {
  state: RSSHubState
  running: boolean
  port: number
  baseUrl: string | null
  restartCount: number
  lastError: string | null
  lastStartupError: string | null
  lastRuntimeError: string | null
  lastRuntimeErrorAt: string | null
  startedAt: string | null
  exitedAt: string | null
  chromium: RSSHubChromiumStatus
}

const DEFAULT_PORT = 1200
const MAX_RESTARTS = 3
const MAX_PORT_SCAN = 50
const RESTART_DELAY_MS = 5000
const RSSHUB_IDLE_STOP_MS = 15 * 60_000
const START_TIMEOUT_MS = 30000
const STOP_TIMEOUT_MS = 5000
const DEFAULT_PUPPETEER_CHROME_BUILD = '136.0.7103.49'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAddrInUseError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  return message.includes('EADDRINUSE') || message.includes('address already in use')
}

export class RSSHubManager {
  private child: ChildProcess | null = null
  private port = 0
  private state: RSSHubState = 'stopped'
  private restartCount = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private startPromise: Promise<number> | null = null
  private readonly idleLifecycle = new RSSHubIdleLifecycle({
    idleMs: RSSHUB_IDLE_STOP_MS,
    onIdle: () => {
      void this.stop().catch((error) => {
        console.warn(`[rsshub] idle stop failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
  })
  private stopping = false
  private externalWorker = false
  private lastError: string | null = null
  private lastStartupError: string | null = null
  private lastRuntimeError: string | null = null
  private lastRuntimeErrorAt: string | null = null
  private startedAt: string | null = null
  private exitedAt: string | null = null
  private puppeteerPrepared = false
  private puppeteerExecutablePath: string | null = null
  private puppeteerCacheDir = join(app.getPath('userData'), 'puppeteer-cache')
  private chromiumStatus: RSSHubChromiumStatus = {
    ready: false,
    executablePath: null,
    source: 'none',
    cacheDir: this.puppeteerCacheDir,
    buildId: DEFAULT_PUPPETEER_CHROME_BUILD,
    downloadSupported: null,
    lastCheckedAt: null,
    lastError: null,
  }

  async start(preferredPort = DEFAULT_PORT): Promise<number> {
    if (this.isRunning()) {
      return this.port
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.startWithPortFallback(preferredPort).finally(() => {
      this.startPromise = null
    })
    const port = await this.startPromise
    this.idleLifecycle.setRunning(true)
    return port
  }

  private async startWithPortFallback(preferredPort: number): Promise<number> {
    this.state = 'starting'
    this.stopping = false
    this.lastError = null
    this.lastStartupError = null

    let lastStartError: Error | null = null
    for (let i = 0; i <= MAX_PORT_SCAN; i++) {
      const candidatePort = preferredPort + i
      try {
        const reused = await this.tryReuseExistingWorker(candidatePort)
        if (reused) {
          this.port = reused
          this.externalWorker = true
          this.state = 'running'
          this.restartCount = 0
          this.startedAt = new Date().toISOString()
          this.exitedAt = null
          this.lastError = null
          this.lastStartupError = null
          await this.cleanupStaleWorkers(reused)
          console.log(`[rsshub] reusing existing worker on port ${reused}`)
          return reused
        }

        const port = await this.spawnWorker(candidatePort)
        this.port = port
        this.externalWorker = false
        this.state = 'running'
        this.restartCount = 0
        this.startedAt = new Date().toISOString()
        this.exitedAt = null
        this.lastError = null
        this.lastStartupError = null
        await this.cleanupStaleWorkers(port)
        console.log(`[rsshub] ready on port ${port}`)
        return port
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        lastStartError = err
        this.lastError = err.message
        this.lastStartupError = err.message
        if (isAddrInUseError(err) && i < MAX_PORT_SCAN) {
          console.warn(`[rsshub] port ${candidatePort} unavailable, trying ${candidatePort + 1}`)
          continue
        }
        break
      }
    }

    this.state = 'error'
    throw lastStartError ?? new Error('RSSHub failed to start')
  }

  private async preparePuppeteerRuntime(): Promise<void> {
    if (this.puppeteerPrepared && this.puppeteerExecutablePath) return
    this.puppeteerPrepared = true
    this.chromiumStatus.lastCheckedAt = new Date().toISOString()
    this.chromiumStatus.lastError = null

    try {
      await mkdir(this.puppeteerCacheDir, { recursive: true })

      const envChrome = this.findExplicitChromeExecutable()
      if (envChrome) {
        this.setChromiumExecutable(envChrome, 'env')
        console.log(`[rsshub] using configured chromium: ${envChrome}`)
        return
      }

      const installed = await getInstalledBrowsers({ cacheDir: this.puppeteerCacheDir })
      const existingChrome = installed.find((item) => item.browser === Browser.CHROME)
      if (existingChrome?.executablePath) {
        this.setChromiumExecutable(existingChrome.executablePath, 'cache')
        console.log(`[rsshub] using cached chromium: ${this.puppeteerExecutablePath}`)
        return
      }

      const systemChrome = this.findSystemChromeExecutable()
      if (systemChrome) {
        this.setChromiumExecutable(systemChrome, 'system')
        console.log(`[rsshub] using system chromium: ${this.puppeteerExecutablePath}`)
        return
      }

      const buildId = DEFAULT_PUPPETEER_CHROME_BUILD

      const platform = detectBrowserPlatform()
      if (!platform) {
        this.chromiumStatus.lastError = 'Cannot detect browser platform for chromium install'
        this.chromiumStatus.downloadSupported = false
        console.warn('[rsshub] cannot detect browser platform for chromium install')
        this.puppeteerPrepared = false
        return
      }

      const downloadable = await canDownload({
          browser: Browser.CHROME,
          buildId,
          platform,
          cacheDir: this.puppeteerCacheDir,
        })
        .catch(() => false)
      this.chromiumStatus.downloadSupported = downloadable
      if (!downloadable) {
        this.chromiumStatus.lastError = `Chromium build not downloadable: ${buildId} (${platform})`
        console.warn(`[rsshub] chromium build not downloadable: ${buildId} (${platform})`)
        this.puppeteerPrepared = false
        return
      }

      console.log(`[rsshub] installing chromium ${buildId} for ${platform}...`)
      const browser = await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir: this.puppeteerCacheDir,
        platform,
      })
      this.setChromiumExecutable(browser.executablePath || null, 'downloaded')
      if (this.puppeteerExecutablePath) {
        console.log(`[rsshub] chromium installed: ${this.puppeteerExecutablePath}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.chromiumStatus.lastError = message
      console.warn(`[rsshub] chromium auto-setup failed: ${message}`)
      this.puppeteerPrepared = false
    }

    if (!this.puppeteerExecutablePath) {
      this.chromiumStatus.ready = false
      this.chromiumStatus.source = 'none'
      this.chromiumStatus.executablePath = null
      this.puppeteerPrepared = false
    }
  }

  private setChromiumExecutable(path: string | null, source: ChromiumSource): void {
    this.puppeteerExecutablePath = path
    this.chromiumStatus.executablePath = path
    this.chromiumStatus.ready = Boolean(path)
    this.chromiumStatus.source = path ? source : 'none'
    if (path) {
      this.chromiumStatus.lastError = null
    }
  }

  private recordRuntimeError(message: string): void {
    this.lastRuntimeError = message
    this.lastRuntimeErrorAt = new Date().toISOString()
  }

  private findExplicitChromeExecutable(): string | null {
    const candidates = [
      process.env.CHROMIUM_EXECUTABLE_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_PATH,
      process.env.CHROME_BIN,
    ]
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        return candidate
      }
    }
    return null
  }

  private findSystemChromeExecutable(): string | null {
    const candidates = process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
          ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
    return null
  }

  private async getWorkerEnv(targetPort: number): Promise<NodeJS.ProcessEnv> {
    await this.preparePuppeteerRuntime()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RSSHUB_PORT: String(targetPort),
      PUPPETEER_CACHE_DIR: this.puppeteerCacheDir,
      NO_LOGFILES: 'true',
    }

    if (this.puppeteerExecutablePath) {
      env.CHROMIUM_EXECUTABLE_PATH = this.puppeteerExecutablePath
      env.PUPPETEER_EXECUTABLE_PATH = this.puppeteerExecutablePath
      env.CHROME_PATH = this.puppeteerExecutablePath
      env.CHROME_BIN = this.puppeteerExecutablePath
    }

    return env
  }

  private async getWorkerCwd(): Promise<string> {
    const runtimeDir = join(app.getPath('userData'), 'rsshub-runtime')
    await mkdir(runtimeDir, { recursive: true })
    return runtimeDir
  }

  private async spawnWorker(targetPort: number): Promise<number> {
    const workerEnv = await this.getWorkerEnv(targetPort)
    const workerCwd = await this.getWorkerCwd()
    return new Promise<number>((resolve, reject) => {
      const workerPath = this.getWorkerPath()
      // `detached: true` (Unix only) makes the worker its own process-group
      // leader so we can SIGTERM/SIGKILL Chromium grandchildren via -pid in
      // `cleanup`. IPC channel is preserved for the ready/error/shutdown
      // message protocol — see `rsshub-process-cleanup.ts` for rationale.
      const forkOptions = buildWorkerForkOptions({
        env: workerEnv,
        cwd: workerCwd,
        platform: process.platform,
      })
      const child = fork(workerPath, [], forkOptions)
      this.child = child
      this.externalWorker = false

      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }

      const timeout = setTimeout(() => {
        settle(() => {
          this.lastError = `RSSHub start timed out after ${START_TIMEOUT_MS}ms`
          this.lastStartupError = this.lastError
          this.state = 'error'
          // Use process-group kill so any Chromium grandchildren the worker
          // already booted during the long startup are reaped too. The
          // promise rejection happens immediately; the SIGKILL escalation
          // runs in the background and never blocks the caller.
          // fire-and-forget: process-tree kill is best-effort cleanup on startup timeout; the helper's own killFn already logs errors, and reject() below propagates the user-facing failure.
          void killWorkerProcessTree({
            pid: child.pid,
            hasProcessGroup: process.platform !== 'win32',
            killFn: processKillFn,
          }).catch(() => {
            // best-effort: if the helper itself blows up we'd already have
            // logged via the killFn errors path
          })
          reject(new Error(this.lastError))
        })
      }, START_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timeout)
      }

      child.on('message', (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          settle(() => {
            cleanup()
            resolve(msg.port)
          })
          return
        }
        if (settled || this.state === 'running') {
          this.recordRuntimeError(msg.message)
          return
        }
        settle(() => {
          cleanup()
          this.lastError = msg.message
          this.lastStartupError = msg.message
          this.state = 'error'
          reject(new Error(msg.message))
        })
      })

      child.stdout?.on('data', (data: Buffer) => {
        if (is.dev) {
          process.stdout.write(`[rsshub:out] ${data}`)
        }
      })

      child.stderr?.on('data', (data: Buffer) => {
        const message = data.toString().trim()
        if (message) {
          if (settled || this.state === 'running') {
            this.recordRuntimeError(message)
          } else {
            this.lastError = message
            this.lastStartupError = message
          }
          console.error(`[rsshub:err] ${message}`)
        }
      })

      child.on('error', (err) => {
        settle(() => {
          cleanup()
          this.lastError = err.message
          this.lastStartupError = err.message
          this.state = 'error'
          reject(err)
        })
      })

      child.on('exit', (code, signal) => {
        const wasRunning = this.state === 'running'
        cleanup()
        this.child = null
        this.exitedAt = new Date().toISOString()
        if (this.state !== 'starting') {
          this.state = 'stopped'
        }
        console.log(`[rsshub] exited (code=${code}, signal=${signal})`)

        if (!settled && this.state === 'starting') {
          settle(() => {
            const message = `RSSHub exited before ready (code=${code}, signal=${signal})`
            this.lastError = message
            this.lastStartupError = message
            this.state = 'error'
            reject(new Error(message))
          })
          return
        }

        if (this.stopping) {
          return
        }
        this.idleLifecycle.setRunning(false)
        if (wasRunning && code !== 0 && this.idleLifecycle.hasDemand() && this.restartCount < MAX_RESTARTS) {
          this.recordRuntimeError(`RSSHub exited unexpectedly (code=${code}, signal=${signal})`)
          this.restartCount++
          console.warn(
            `[rsshub] restarting (${this.restartCount}/${MAX_RESTARTS}) in ${RESTART_DELAY_MS}ms`,
          )
          this.restartTimer = setTimeout(() => {
            this.start(this.port || DEFAULT_PORT).catch((error) => {
              const message = error instanceof Error ? error.message : String(error)
              this.lastError = message
              console.error(`[rsshub] auto-restart failed: ${message}`)
            })
          }, RESTART_DELAY_MS)
        }
      })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.idleLifecycle.setRunning(false)
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    const activeStart = this.startPromise
    if (activeStart) {
      try {
        await activeStart
      } catch {
        // ignored; we're stopping anyway
      }
    }
    this.idleLifecycle.setRunning(false)

    if (this.state === 'stopped') {
      this.state = 'stopped'
      return
    }

    if (this.externalWorker) {
      await this.shutdownRemoteWorker().catch(() => {
        // best effort for adopted workers
      })
      this.externalWorker = false
      this.port = 0
      this.state = 'stopped'
      this.exitedAt = new Date().toISOString()
      return
    }

    if (!this.child) {
      this.state = 'stopped'
      return
    }

    await new Promise<void>((resolve) => {
      const child = this.child
      if (!child) {
        resolve()
        return
      }

      const forceKill = setTimeout(() => {
        // The graceful 'shutdown' message didn't reap the worker in time —
        // fall back to a process-group kill so Chromium grandchildren spawned
        // by RSSHub's internal browser automation are reaped too. We resolve as soon
        // as SIGTERM is dispatched; the SIGKILL escalation runs in the
        // background under killWorkerProcessTree.
        // fire-and-forget: SIGKILL escalation runs to completion in the background; the helper records its own errors and stop() returns successfully regardless.
        void killWorkerProcessTree({
          pid: child.pid,
          hasProcessGroup: process.platform !== 'win32',
          killFn: processKillFn,
        }).catch(() => {
          // best-effort: errors are recorded inside the helper via the
          // returned result; nothing to do at the stop() boundary.
        })
        resolve()
      }, STOP_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(forceKill)
        resolve()
      })

      child.send('shutdown')
    })

    this.child = null
    this.externalWorker = false
    this.port = 0
    this.state = 'stopped'
    this.exitedAt = new Date().toISOString()
  }

  async ensureHealthy(): Promise<boolean> {
    const releaseRequest = this.idleLifecycle.beginRequest()
    try {
      if (!this.isRunning()) {
        try {
          await this.start()
        } catch {
          return false
        }
      }

      const healthy = await this.healthCheck()
      if (healthy) {
        await this.cleanupStaleWorkers(this.port).catch(() => {
          // best effort
        })
        return true
      }

      try {
        await this.stop()
        await sleep(200)
        await this.start(this.port || DEFAULT_PORT)
        return this.healthCheck()
      } catch {
        return false
      }
    } finally {
      releaseRequest()
    }
  }

  async healthCheck(timeoutMs = 2500): Promise<boolean> {
    if (!this.isRunning()) return false

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      const healthRes = await fetch(`${this.getBaseUrl()}/healthz`, { signal: controller.signal })
      clearTimeout(timeout)
      if (healthRes.ok) return true
    } catch {
      // fall through to root check
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      const rootRes = await fetch(this.getBaseUrl(), { signal: controller.signal })
      const text = (await rootRes.text()).toLowerCase()
      clearTimeout(timeout)
      return rootRes.ok && text.includes('rsshub')
    } catch {
      return false
    }
  }

  isRunning(): boolean {
    return this.state === 'running' && this.port > 0 && (this.child !== null || this.externalWorker)
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async describeStatus(): Promise<RSSHubRuntimeStatus> {
    return this.getStatus()
  }

  beginRequest(): () => void {
    return this.idleLifecycle.beginRequest()
  }

  getStatus(): RSSHubRuntimeStatus {
    return {
      state: this.state,
      running: this.isRunning(),
      port: this.port,
      baseUrl: this.isRunning() ? this.getBaseUrl() : null,
      restartCount: this.restartCount,
      lastError: this.lastError,
      lastStartupError: this.lastStartupError,
      lastRuntimeError: this.lastRuntimeError,
      lastRuntimeErrorAt: this.lastRuntimeErrorAt,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      chromium: {
        ...this.chromiumStatus,
      },
    }
  }

  /**
   * Cleanup for app before-quit — force kills the worker AND its Chromium
   * grandchildren by sending SIGTERM/SIGKILL to the worker's process group.
   *
   * Was previously synchronous + `child.kill('SIGKILL')`, which only
   * signalled the immediate Node child and orphaned every Chromium subprocess
   * that RSSHub's internal browser automation had booted. Users observed 14+ leaked
   * Chrome processes after a single quit cycle. The `before-quit` cleanup
   * orchestrator (`runBeforeQuitCleanup`) already supports a `Promise<void>`
   * return, so the cost of awaiting the SIGTERM→SIGKILL escalation is bounded
   * by the orchestrator's outer 5s timeout.
   */
  async cleanup(): Promise<void> {
    this.stopping = true
    this.idleLifecycle.dispose()
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (child) {
      this.child = null
      try {
        await killWorkerProcessTree({
          pid: child.pid,
          hasProcessGroup: process.platform !== 'win32',
          killFn: processKillFn,
        })
      } catch {
        // The helper itself swallows ESRCH; any error here is unexpected and
        // already recorded in the helper's result. Best-effort during quit.
      }
    }
    this.externalWorker = false
    this.port = 0
    this.state = 'stopped'
    this.exitedAt = new Date().toISOString()
  }

  private async tryReuseExistingWorker(port: number): Promise<number | null> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1200)
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) return null
      const payload = await response.json().catch(() => null)
      if (payload?.ok === true && payload?.service === 'rsshub-embedded') {
        return port
      }
    } catch {
      // ignore; port is either closed or not our worker
    }
    return null
  }

  private async listEmbeddedWorkers(): Promise<number[]> {
    const ports: number[] = []
    for (let i = 0; i <= MAX_PORT_SCAN; i += 1) {
      const port = DEFAULT_PORT + i
      const reused = await this.tryReuseExistingWorker(port)
      if (reused) ports.push(reused)
    }
    return ports
  }

  private async cleanupStaleWorkers(keepPort: number): Promise<void> {
    const ports = await this.listEmbeddedWorkers()
    const stalePorts = ports.filter((port) => port !== keepPort)
    if (stalePorts.length === 0) return
    await Promise.all(
      stalePorts.map(async (port) => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), STOP_TIMEOUT_MS)
        try {
          await fetch(`http://127.0.0.1:${port}/shutdown`, {
            method: 'POST',
            signal: controller.signal,
          })
        } catch {
          // ignore stale shutdown failures
        } finally {
          clearTimeout(timeout)
        }
      }),
    )
  }

  private async shutdownRemoteWorker(): Promise<void> {
    if (!this.port) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), STOP_TIMEOUT_MS)
    try {
      await fetch(`${this.getBaseUrl()}/shutdown`, {
        method: 'POST',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private getWorkerPath(): string {
    if (is.dev) {
      return join(process.cwd(), 'src', 'main', 'modules', 'rss-engine', 'rsshub-worker.mjs')
    }
    const appPath = app.getAppPath()
    const candidates = [
      join(appPath, 'out', 'main', 'rsshub-worker.js'),
      join(appPath, 'out', 'main', 'rsshub-worker.mjs'),
      join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'rsshub-worker.js'),
      join(process.resourcesPath, 'rsshub-worker.mjs'),
      join(dirname(appPath), 'rsshub-worker.mjs'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }
    return candidates[0]
  }
}

export const rsshubManager = new RSSHubManager()
