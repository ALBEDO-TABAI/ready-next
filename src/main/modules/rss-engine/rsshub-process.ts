import { fork, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import {
  install,
  getInstalledBrowsers,
  canDownload,
  detectBrowserPlatform,
  Browser,
} from '@puppeteer/browsers'

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

export interface RSSHubRuntimeStatus {
  state: RSSHubState
  running: boolean
  port: number
  baseUrl: string | null
  restartCount: number
  lastError: string | null
  startedAt: string | null
  exitedAt: string | null
}

const DEFAULT_PORT = 1200
const MAX_RESTARTS = 3
const MAX_PORT_SCAN = 10
const RESTART_DELAY_MS = 5000
const START_TIMEOUT_MS = 15000
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

class RSSHubManager {
  private child: ChildProcess | null = null
  private port = 0
  private state: RSSHubState = 'stopped'
  private restartCount = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private startPromise: Promise<number> | null = null
  private stopping = false
  private lastError: string | null = null
  private startedAt: string | null = null
  private exitedAt: string | null = null
  private puppeteerPrepared = false
  private puppeteerExecutablePath: string | null = null
  private puppeteerCacheDir = join(app.getPath('userData'), 'puppeteer-cache')

  async start(preferredPort = DEFAULT_PORT): Promise<number> {
    if (this.state === 'running' && this.child) {
      return this.port
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.startWithPortFallback(preferredPort).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startWithPortFallback(preferredPort: number): Promise<number> {
    this.state = 'starting'
    this.stopping = false
    this.lastError = null

    let lastStartError: Error | null = null
    for (let i = 0; i <= MAX_PORT_SCAN; i++) {
      const candidatePort = preferredPort + i
      try {
        const port = await this.spawnWorker(candidatePort)
        this.port = port
        this.state = 'running'
        this.restartCount = 0
        this.startedAt = new Date().toISOString()
        this.exitedAt = null
        this.lastError = null
        console.log(`[rsshub] ready on port ${port}`)
        return port
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        lastStartError = err
        this.lastError = err.message
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
    if (this.puppeteerPrepared) return
    this.puppeteerPrepared = true

    try {
      await mkdir(this.puppeteerCacheDir, { recursive: true })
      const installed = await getInstalledBrowsers({ cacheDir: this.puppeteerCacheDir })
      const existingChrome = installed.find((item) => item.browser === Browser.CHROME)
      if (existingChrome?.executablePath) {
        this.puppeteerExecutablePath = existingChrome.executablePath
        console.log(`[rsshub] using cached chromium: ${this.puppeteerExecutablePath}`)
        return
      }

      const buildId = DEFAULT_PUPPETEER_CHROME_BUILD

      const platform = detectBrowserPlatform()
      if (!platform) {
        console.warn('[rsshub] cannot detect browser platform for chromium install')
        return
      }

      const downloadable = await canDownload({
          browser: Browser.CHROME,
          buildId,
          platform,
          cacheDir: this.puppeteerCacheDir,
        })
        .catch(() => false)
      if (!downloadable) {
        console.warn(`[rsshub] chromium build not downloadable: ${buildId} (${platform})`)
        return
      }

      console.log(`[rsshub] installing chromium ${buildId} for ${platform}...`)
      const browser = await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir: this.puppeteerCacheDir,
        platform,
      })
      this.puppeteerExecutablePath = browser.executablePath || null
      if (this.puppeteerExecutablePath) {
        console.log(`[rsshub] chromium installed: ${this.puppeteerExecutablePath}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[rsshub] chromium auto-setup failed: ${message}`)
    }
  }

  private async getWorkerEnv(targetPort: number): Promise<NodeJS.ProcessEnv> {
    await this.preparePuppeteerRuntime()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RSSHUB_PORT: String(targetPort),
      PUPPETEER_CACHE_DIR: this.puppeteerCacheDir,
    }

    if (this.puppeteerExecutablePath) {
      env.PUPPETEER_EXECUTABLE_PATH = this.puppeteerExecutablePath
      env.CHROME_PATH = this.puppeteerExecutablePath
      env.CHROME_BIN = this.puppeteerExecutablePath
    }

    return env
  }

  private async spawnWorker(targetPort: number): Promise<number> {
    const workerEnv = await this.getWorkerEnv(targetPort)
    return new Promise<number>((resolve, reject) => {
      const workerPath = this.getWorkerPath()
      const child = fork(workerPath, [], {
        env: workerEnv,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.child = child

      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }

      const timeout = setTimeout(() => {
        settle(() => {
          this.lastError = `RSSHub start timed out after ${START_TIMEOUT_MS}ms`
          this.state = 'error'
          child.kill('SIGKILL')
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
        settle(() => {
          cleanup()
          this.lastError = msg.message
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
          this.lastError = message
          console.error(`[rsshub:err] ${message}`)
        }
      })

      child.on('error', (err) => {
        settle(() => {
          cleanup()
          this.lastError = err.message
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
            this.state = 'error'
            reject(new Error(message))
          })
          return
        }

        if (this.stopping) {
          return
        }
        if (wasRunning && code !== 0 && this.restartCount < MAX_RESTARTS) {
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

    if (!this.child || this.state === 'stopped') {
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
        child.kill('SIGKILL')
        resolve()
      }, STOP_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(forceKill)
        resolve()
      })

      child.send('shutdown')
    })

    this.child = null
    this.state = 'stopped'
    this.exitedAt = new Date().toISOString()
  }

  async ensureHealthy(): Promise<boolean> {
    if (!this.isRunning()) {
      try {
        await this.start()
      } catch {
        return false
      }
    }

    const healthy = await this.healthCheck()
    if (healthy) {
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
    return this.state === 'running' && this.child !== null
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  getStatus(): RSSHubRuntimeStatus {
    return {
      state: this.state,
      running: this.isRunning(),
      port: this.port,
      baseUrl: this.isRunning() ? this.getBaseUrl() : null,
      restartCount: this.restartCount,
      lastError: this.lastError,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
    }
  }

  /** Synchronous cleanup for app before-quit — force kills immediately */
  cleanup(): void {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.child) {
      this.child.kill('SIGKILL')
      this.child = null
    }
    this.state = 'stopped'
    this.exitedAt = new Date().toISOString()
  }

  private getWorkerPath(): string {
    if (is.dev) {
      return join(process.cwd(), 'src', 'main', 'modules', 'rss-engine', 'rsshub-worker.mjs')
    }
    const appPath = app.getAppPath()
    // app.asar -> sibling extraResources files
    return join(dirname(appPath), 'rsshub-worker.mjs')
  }
}

export const rsshubManager = new RSSHubManager()
