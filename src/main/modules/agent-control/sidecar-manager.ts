import { app } from 'electron'
import { createServer } from 'net'
import { ChildProcess, execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { SidecarStatus } from './contracts/types'
import { atomicWriteJson } from './atomic-write'
import {
  buildReadyPythonCandidates,
  isSupportedReadyPythonSslVersion,
  isSupportedReadyPythonVersion,
  parsePythonVersionText,
} from '../skills-runtime/python-runtime-version'
import {
  buildPackagedSkillRuntimeEnv,
  getPackagedSkillPythonPath,
  resolvePackagedSkillRuntimeRoot,
} from '../skills-runtime/packaged-runtime'

const execFileAsync = promisify(execFile)

const SIDECAR_HEALTH_TIMEOUT_MS = 25_000
const SIDECAR_POLL_INTERVAL_MS = 10_000
const SIDECAR_PIP_ENV = {
  PYO3_USE_ABI3_FORWARD_COMPATIBILITY: '1',
  PIP_PREFER_BINARY: '1',
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hashText(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i)
    hash |= 0
  }
  return String(hash)
}

export class SidecarManager {
  private process: ChildProcess | null = null
  private status: SidecarStatus
  private host: string
  private preferredPort: number | null
  private readonly runtimeRoot: string
  private readonly venvRoot: string
  private readonly runtimeStatePath: string
  private readonly sidecarSourceRoot: string
  private readonly sidecarPkgRoot: string
  private readonly packagedRuntimeRoot: string | null
  private token: string | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(options?: { host?: string; preferredPort?: number | null }) {
    this.host = options?.host || '127.0.0.1'
    this.preferredPort = options?.preferredPort ?? null
    this.runtimeRoot = join(app.getPath('userData'), 'agent-sidecar-runtime')
    this.venvRoot = join(this.runtimeRoot, 'python')
    this.runtimeStatePath = join(this.runtimeRoot, '.install-state.json')

    this.sidecarSourceRoot = app.isPackaged
      ? join(process.resourcesPath, 'sidecar')
      : join(app.getAppPath(), 'src', 'python')
    this.sidecarPkgRoot = join(this.sidecarSourceRoot, 'ready_sidecar')
    this.packagedRuntimeRoot = resolvePackagedSkillRuntimeRoot(process.resourcesPath)

    this.status = {
      state: 'stopped',
      host: this.host,
      port: null,
      pid: null,
      startedAt: null,
      lastHeartbeatAt: null,
      error: null,
    }
  }

  getStatus(): SidecarStatus {
    return { ...this.status }
  }

  isRunning(): boolean {
    return this.status.state === 'running' && !!this.process && this.process.exitCode === null
  }

  setBindConfig(host?: string, preferredPort?: number | null): void {
    if (host && host.trim()) {
      this.host = host.trim()
      this.status.host = this.host
    }
    if (preferredPort === null || preferredPort === undefined) {
      this.preferredPort = null
    } else {
      const numeric = Math.floor(preferredPort)
      this.preferredPort = Number.isFinite(numeric) && numeric > 0 ? numeric : null
    }
  }

  async start(): Promise<SidecarStatus> {
    if (this.isRunning()) return this.getStatus()
    this.status.state = 'starting'
    this.status.error = null

    try {
      this.ensureRuntimeDirs()
      const port = await this.pickFreePort()
      const python = await this.ensurePythonRuntime()
      this.token = randomBytes(24).toString('hex')

      const scriptPath = join(this.sidecarPkgRoot, 'main.py')
      const pythonPath = this.sidecarSourceRoot
      this.process = spawn(
        python,
        [scriptPath],
        {
          cwd: this.sidecarSourceRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...this.getPythonRuntimeEnv(),
            PYTHONPATH: pythonPath,
            READY_SIDECAR_AUTH_TOKEN: this.token,
            READY_SIDECAR_HOST: this.host,
            READY_SIDECAR_PORT: String(port),
            READY_SIDECAR_RUNTIME_ROOT: this.runtimeRoot,
          },
        },
      )

      this.process.stdout?.on('data', () => {
        // Sidecar output is intentionally not forwarded to renderer.
      })
      this.process.stderr?.on('data', () => {
        // Keep silent by default; status will be surfaced via health checks.
      })
      this.process.on('exit', (code) => {
        this.process = null
        this.status.state = 'stopped'
        this.status.pid = null
        if (code && code !== 0) {
          this.status.error = `Sidecar exited with code ${code}`
        }
      })

      this.status.port = port
      this.status.pid = this.process.pid || null
      this.status.startedAt = new Date().toISOString()

      await this.waitForHealth()
      this.status.state = 'running'
      this.status.error = null
      this.startHeartbeatLoop()
      return this.getStatus()
    } catch (error) {
      this.status.state = 'error'
      this.status.error = error instanceof Error ? error.message : String(error)
      return this.getStatus()
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (!this.process) {
      this.status.state = 'stopped'
      this.status.pid = null
      return
    }
    const proc = this.process
    this.process = null
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
        resolve()
      }, 2_000)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      try {
        proc.kill('SIGTERM')
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })
    this.status.state = 'stopped'
    this.status.pid = null
  }

  async heartbeat(): Promise<Record<string, unknown>> {
    return this.request('/heartbeat')
  }

  async listChannels(): Promise<Record<string, unknown>> {
    return this.request('/channels')
  }

  async upsertChannel(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/channels/upsert', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async startChannel(id: string): Promise<Record<string, unknown>> {
    return this.request('/channels/start', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  }

  async stopChannel(id: string): Promise<Record<string, unknown>> {
    return this.request('/channels/stop', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  }

  async deleteChannel(id: string): Promise<Record<string, unknown>> {
    return this.request('/channels/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  }

  async getChannelState(): Promise<Record<string, unknown>> {
    return this.request('/channels/state')
  }

  async sendChannel(payload: {
    id: string
    thread?: string
    text: string
  }): Promise<Record<string, unknown>> {
    return this.request('/channels/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async testChannel(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/channels/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async startWechatLogin(channelId: string, force?: boolean): Promise<Record<string, unknown>> {
    return this.request('/channels/wechat-openclaw/login/start', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, force: Boolean(force) }),
    })
  }

  async getWechatLoginStatus(channelId: string, sessionKey: string): Promise<Record<string, unknown>> {
    return this.request('/channels/wechat-openclaw/login/status', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, session_key: sessionKey }),
    })
  }

  async submitWechatLoginVerifyCode(channelId: string, sessionKey: string, code: string): Promise<Record<string, unknown>> {
    return this.request('/channels/wechat-openclaw/login/verify', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, session_key: sessionKey, code }),
    })
  }

  async listSchedules(): Promise<Record<string, unknown>> {
    return this.request('/cron')
  }

  async upsertSchedule(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/cron/upsert', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  async pauseSchedule(id: string): Promise<Record<string, unknown>> {
    return this.request('/cron/pause', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  }

  async resumeSchedule(id: string): Promise<Record<string, unknown>> {
    return this.request('/cron/resume', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  }

  async deleteSchedule(id: string): Promise<Record<string, unknown>> {
    return this.request('/cron/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  }

  async runScheduleNow(id: string): Promise<Record<string, unknown>> {
    return this.request('/cron/run-now', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  }

  async pullEvents(limit = 20): Promise<Array<Record<string, unknown>>> {
    const data = await this.request(`/events/pull?limit=${Math.max(1, Math.min(200, limit))}`)
    const events = Array.isArray((data as { events?: unknown[] }).events)
      ? ((data as { events?: unknown[] }).events as Array<Record<string, unknown>>)
      : []
    return events
  }

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat()
        .then(() => {
          this.status.lastHeartbeatAt = new Date().toISOString()
          if (this.status.state !== 'running') this.status.state = 'running'
        })
        .catch((error) => {
          this.status.error = error instanceof Error ? error.message : String(error)
          if (this.status.state === 'running') this.status.state = 'error'
        })
    }, SIDECAR_POLL_INTERVAL_MS)
  }

  private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    if (!this.status.port || !this.token) {
      throw new Error('Sidecar is not running')
    }
    const resp = await fetch(`http://${this.host}:${this.status.port}${path}`, {
      method: init?.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-ready-token': this.token,
        ...(init?.headers || {}),
      },
      body: init?.body,
      signal: AbortSignal.timeout(10_000),
    })
    const text = await resp.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? JSON.parse(text) as Record<string, unknown> : {}
    } catch {
      json = { raw: text }
    }
    if (!resp.ok) {
      throw new Error(`Sidecar HTTP ${resp.status}: ${(json.error as string) || text || resp.statusText}`)
    }
    return json
  }

  private async waitForHealth(): Promise<void> {
    const started = Date.now()
    let lastError = 'Sidecar health check timed out'
    while (Date.now() - started < SIDECAR_HEALTH_TIMEOUT_MS) {
      try {
        await this.request('/health')
        this.status.lastHeartbeatAt = new Date().toISOString()
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await wait(400)
      }
    }
    throw new Error(lastError)
  }

  private ensureRuntimeDirs(): void {
    if (!existsSync(this.runtimeRoot)) mkdirSync(this.runtimeRoot, { recursive: true })
    if (!existsSync(this.sidecarPkgRoot)) {
      throw new Error(`Sidecar source not found: ${this.sidecarPkgRoot}`)
    }
  }

  private async ensurePythonRuntime(): Promise<string> {
    const packagedPythonPath = await this.resolvePackagedPythonPath()
    if (packagedPythonPath) return packagedPythonPath

    const venvPython = this.getVenvPythonPath()
    const requirementsPath = join(this.sidecarPkgRoot, 'requirements.txt')
    const digest = existsSync(requirementsPath)
      ? hashText(readFileSync(requirementsPath, 'utf-8'))
      : 'none'

    let stateDigest = ''
    if (existsSync(this.runtimeStatePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.runtimeStatePath, 'utf-8')) as { digest?: string }
        stateDigest = parsed.digest || ''
      } catch {
        stateDigest = ''
      }
    }

    if (existsSync(venvPython)) {
      const venvVersion = await this.getPythonVersion(venvPython)
      const venvSslVersionText = await this.getPythonSslVersionText(venvPython)
      if (!isSupportedReadyPythonVersion(venvVersion) || !isSupportedReadyPythonSslVersion(venvSslVersionText)) {
        rmSync(this.venvRoot, { recursive: true, force: true })
      }
    }

    if (!existsSync(venvPython)) {
      const basePython = await this.resolveBasePython()
      await execFileAsync(basePython, ['-m', 'venv', this.venvRoot], {
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel'], {
        timeout: 240_000,
        maxBuffer: 12 * 1024 * 1024,
        env: { ...process.env, ...SIDECAR_PIP_ENV },
      })
    }

    if (existsSync(requirementsPath) && stateDigest !== digest) {
      await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath], {
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...SIDECAR_PIP_ENV },
      })
      atomicWriteJson(this.runtimeStatePath, { digest, updatedAt: new Date().toISOString() })
    }

    return venvPython
  }

  private getVenvPythonPath(): string {
    if (process.platform === 'win32') return join(this.venvRoot, 'Scripts', 'python.exe')
    return join(this.venvRoot, 'bin', 'python')
  }

  private async resolveBasePython(): Promise<string> {
    const sharedSkillPython = process.platform === 'win32'
      ? join(app.getPath('userData'), 'skill-runtime', 'python', 'Scripts', 'python.exe')
      : join(app.getPath('userData'), 'skill-runtime', 'python', 'bin', 'python')
    const candidates = buildReadyPythonCandidates(process.env.READY_SIDECAR_PYTHON, process.env)
    if (!candidates.includes(sharedSkillPython)) {
      candidates.splice(Math.min(2, candidates.length), 0, sharedSkillPython)
    }

    for (const candidate of candidates) {
      try {
        const { stdout, stderr } = await execFileAsync(candidate, ['--version'], { timeout: 5_000 })
        const versionText = `${stdout} ${stderr}`.trim()
        if (!isSupportedReadyPythonVersion(parsePythonVersionText(versionText))) continue
        const sslVersionText = await this.getPythonSslVersionText(candidate)
        if (!isSupportedReadyPythonSslVersion(sslVersionText)) continue
        return candidate
      } catch {
        // try next
      }
    }
    throw new Error('No usable Python 3.9-3.12 interpreter found for sidecar runtime')
  }

  private async resolvePackagedPythonPath(): Promise<string | null> {
    if (!this.packagedRuntimeRoot) return null
    const pythonPath = getPackagedSkillPythonPath(this.packagedRuntimeRoot)
    if (!existsSync(pythonPath)) {
      throw new Error(`Packaged Python runtime is missing: ${pythonPath}`)
    }
    const runtimeEnv = this.getPythonRuntimeEnv()
    const version = await this.getPythonVersion(pythonPath, runtimeEnv)
    if (!isSupportedReadyPythonVersion(version)) {
      throw new Error(`Packaged Python runtime has unsupported sidecar version: ${await this.getPythonVersionText(pythonPath, runtimeEnv) || 'unknown'}`)
    }
    const sslVersionText = await this.getPythonSslVersionText(pythonPath, runtimeEnv)
    if (!isSupportedReadyPythonSslVersion(sslVersionText)) {
      throw new Error(`Packaged Python runtime has unsupported sidecar OpenSSL: ${sslVersionText || 'unknown'}`)
    }
    return pythonPath
  }

  private getPythonRuntimeEnv(): NodeJS.ProcessEnv {
    if (!this.packagedRuntimeRoot) {
      return {
        ...process.env,
        ...SIDECAR_PIP_ENV,
      }
    }
    return {
      ...buildPackagedSkillRuntimeEnv(this.packagedRuntimeRoot),
      ...SIDECAR_PIP_ENV,
    }
  }

  private async getPythonVersion(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<{ major: number; minor: number } | null> {
    const versionText = await this.getPythonVersionText(pythonBin, env)
    return parsePythonVersionText(versionText || '')
  }

  private async getPythonVersionText(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, ['--version'], { timeout: 5_000, env })
      return `${stdout} ${stderr}`.trim()
    } catch {
      return null
    }
  }

  private async getPythonSslVersionText(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(
        pythonBin,
        ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'],
        { timeout: 5_000, env },
      )
      return `${stdout} ${stderr}`.trim()
    } catch {
      return null
    }
  }

  private async pickFreePort(): Promise<number> {
    if (this.preferredPort && this.preferredPort > 0) {
      const ok = await this.isPortFree(this.preferredPort)
      if (ok) return this.preferredPort
    }
    return await this.pickAnyFreePort()
  }

  private async pickAnyFreePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.once('error', reject)
      srv.listen(0, this.host, () => {
        const info = srv.address()
        if (!info || typeof info === 'string') {
          srv.close(() => reject(new Error('Failed to pick sidecar port')))
          return
        }
        const port = info.port
        srv.close(() => resolve(port))
      })
    })
  }

  private async isPortFree(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, this.host, () => {
        srv.close(() => resolve(true))
      })
    })
  }

  // ============================================================
  // Feishu Plugin Operations
  // ============================================================

  async feishuDocRead(channelId: string, docToken: string, docType: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/doc/read', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, doc_token: docToken, doc_type: docType }),
    })
  }

  async feishuDocCreate(channelId: string, title: string, docType: string, content: unknown, folderToken?: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/doc/create', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, title, doc_type: docType, content, folder_token: folderToken }),
    })
  }

  async feishuDocUpdate(channelId: string, docToken: string, docType: string, updates: unknown): Promise<Record<string, unknown>> {
    return this.request('/feishu/doc/update', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, doc_token: docToken, doc_type: docType, updates }),
    })
  }

  async feishuDocList(channelId: string, folderToken?: string, docType?: string, limit?: number): Promise<Record<string, unknown>> {
    return this.request('/feishu/doc/list', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, folder_token: folderToken, doc_type: docType, limit }),
    })
  }

  async feishuMessageSend(channelId: string, chatId: string, content: unknown, msgType: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/message/send', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, chat_id: chatId, content, msg_type: msgType }),
    })
  }

  async feishuMessageGetContext(channelId: string, chatId: string, limit?: number, startTime?: string, endTime?: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/message/context', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, chat_id: chatId, limit, start_time: startTime, end_time: endTime }),
    })
  }

  async feishuMessageReply(channelId: string, messageId: string, content: unknown, msgType: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/message/reply', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, message_id: messageId, content, msg_type: msgType }),
    })
  }

  async feishuCalendarListEvents(channelId: string, calendarId: string, startTime: string, endTime: string, limit?: number): Promise<Record<string, unknown>> {
    return this.request('/feishu/calendar/events', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, calendar_id: calendarId, start_time: startTime, end_time: endTime, limit }),
    })
  }

  async feishuCalendarCreateEvent(channelId: string, event: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/feishu/calendar/event/create', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, event }),
    })
  }

  async feishuCalendarUpdateEvent(channelId: string, eventId: string, calendarId: string | undefined, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('/feishu/calendar/event/update', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, event_id: eventId, calendar_id: calendarId, updates }),
    })
  }

  async feishuCalendarDeleteEvent(channelId: string, eventId: string, calendarId?: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/calendar/event/delete', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, event_id: eventId, calendar_id: calendarId }),
    })
  }

  async feishuChatList(channelId: string, limit?: number): Promise<Record<string, unknown>> {
    return this.request('/feishu/chat/list', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, limit }),
    })
  }

  async feishuChatGetMembers(channelId: string, chatId: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/chat/members', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, chat_id: chatId }),
    })
  }

  async feishuChatGetInfo(channelId: string, chatId: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/chat/info', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, chat_id: chatId }),
    })
  }

  async feishuFileUpload(channelId: string, filePath: string, fileType: string, parentToken?: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/file/upload', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, file_path: filePath, file_type: fileType, parent_token: parentToken }),
    })
  }

  async feishuFileDownload(channelId: string, fileToken: string, savePath: string): Promise<Record<string, unknown>> {
    return this.request('/feishu/file/download', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, file_token: fileToken, save_path: savePath }),
    })
  }
}
