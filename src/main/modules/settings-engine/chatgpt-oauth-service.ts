import { existsSync } from 'node:fs'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { dirname } from 'node:path'
import { serve } from '@hono/node-server'
import {
  createOpenAIOAuthFetchHandler,
  runOpenAIOAuthLogin,
} from 'openai-oauth'
import {
  CHATGPT_OAUTH_BASE_URL,
  type ChatGptOAuthStatus,
  type ChatGptOAuthPhase,
} from '../../../shared/chatgpt-oauth'

interface ChatGptOAuthServer {
  models: string[]
  close(): Promise<void>
}

export interface ChatGptOAuthServiceDeps {
  credentialExists(): boolean
  login(options: {
    signal: AbortSignal
    onProgress: (phase: ChatGptOAuthPhase) => void
    onAuthorizationUrl: (url: string) => void
  }): Promise<void>
  startServer(models: string[] | undefined, proxyApiKey: string, signal?: AbortSignal): Promise<ChatGptOAuthServer>
  removeCredential(): Promise<void>
}

type ChatGptOAuthConnectHooks = {
  beforeRestart?: () => void | {
    existingProxyApiKey?: string
  } | Promise<void | {
    existingProxyApiKey?: string
  }>
  afterReady?: (status: ChatGptOAuthStatus) => void | Promise<void>
}

type ChatGptOAuthDisconnectHooks = {
  beforeDisconnect?: () => void | Promise<void>
  restoreAfterFailure?: (input: { credentialExists: boolean }) => void | Promise<void>
}

export type ChatGptOAuthLifecycleScope = {
  ensureReady(
    savedModels?: string[],
    proxyApiKey?: string,
  ): Promise<ChatGptOAuthStatus>
}

export class ChatGptOAuthService {
  private connectPromise: Promise<ChatGptOAuthStatus> | null = null
  private operation: ChatGptOAuthStatus['operation']
  private loginController: AbortController | null = null
  private authorizationUrl: string | null = null
  private server: ChatGptOAuthServer | null = null
  private startPromise: Promise<ChatGptOAuthStatus> | null = null
  private models: string[] = []
  private proxyApiKey: string | null = null
  private lastError: string | null = null
  private lifecycleBusy = false
  private readonly lifecycleQueue: Array<() => void> = []

  constructor(private readonly deps: ChatGptOAuthServiceDeps) {}

  isLifecycleBusy(): boolean {
    return this.lifecycleBusy
  }

  runInLifecycleLane<T>(
    operation: (scope: ChatGptOAuthLifecycleScope) => T | Promise<T>,
  ): Promise<T> {
    return this.runLifecycle(() => Promise.resolve(operation({
      ensureReady: (savedModels = [], proxyApiKey) => (
        this.ensureReadyUnlocked(savedModels, proxyApiKey)
      ),
    })))
  }

  getStatus(): ChatGptOAuthStatus {
    const connected = this.deps.credentialExists()
    if (this.operation) {
      return { state: 'connecting', connected, running: false, baseUrl: CHATGPT_OAUTH_BASE_URL,
        models: [...this.models], operation: { ...this.operation } }
    }
    if (this.startPromise && !this.server) {
      return { state: 'connecting', connected, running: false, baseUrl: CHATGPT_OAUTH_BASE_URL, models: [...this.models] }
    }
    if (this.lastError) {
      return {
        state: 'error',
        connected,
        running: false,
        baseUrl: CHATGPT_OAUTH_BASE_URL,
        models: [...this.models],
        error: this.lastError,
      }
    }
    if (this.server) {
      return {
        state: 'ready',
        connected,
        running: true,
        baseUrl: CHATGPT_OAUTH_BASE_URL,
        models: [...this.models],
      }
    }
    return {
      state: connected ? 'signed_in' : 'signed_out',
      connected,
      running: false,
      baseUrl: CHATGPT_OAUTH_BASE_URL,
      models: [...this.models],
    }
  }

  connect(
    existingProxyApiKey?: string,
    hooks: ChatGptOAuthConnectHooks = {},
  ): Promise<ChatGptOAuthStatus> {
    if (this.connectPromise) return this.connectPromise
    const controller = new AbortController()
    this.loginController = controller
    this.operation = { id: randomUUID(), phase: 'preparing', startedAt: Date.now(), canReopen: false }
    const pending = this.runLifecycle(async () => {
      this.lastError = null
      let authorizationStarted = false
      let authorized = false
      try {
        controller.signal.throwIfAborted()
        const prepared = await hooks.beforeRestart?.()
        controller.signal.throwIfAborted()
        const preparedProxyApiKey = prepared?.existingProxyApiKey ?? existingProxyApiKey
        authorizationStarted = true
        await this.stopServerUnlocked()
        controller.signal.throwIfAborted()
        await this.deps.login({
          signal: controller.signal,
          onProgress: phase => { if (!controller.signal.aborted) this.setPhase(phase) },
          onAuthorizationUrl: url => {
            if (!controller.signal.aborted && isAuthorizationUrl(url)) {
              this.authorizationUrl = url
              if (this.operation) this.operation.canReopen = true
            }
          },
        })
        controller.signal.throwIfAborted()
        authorized = true
        this.authorizationUrl = null
        if (this.operation) this.operation.canReopen = false
        this.proxyApiKey = normalizeProxyApiKey(preparedProxyApiKey) || randomBytes(32).toString('base64url')
        this.setPhase('starting_service')
        const status = await this.ensureReadyUnlocked([], this.proxyApiKey, controller.signal)
        controller.signal.throwIfAborted()
        this.setPhase('saving_profile')
        await hooks.afterReady?.({ ...status, state: 'ready', running: true, operation: undefined })
        this.operation = undefined
        return this.getStatus()
      } catch (error) {
        if (authorizationStarted) {
          await this.stopServerUnlocked().catch(() => undefined)
          if (!authorized || controller.signal.aborted) {
            await this.deps.removeCredential().catch(() => undefined)
            this.proxyApiKey = null
          }
          this.models = []
          this.lastError = controller.signal.aborted
            ? '已取消登录，可以重新开始。'
            : error instanceof Error ? error.message : String(error)
        }
        throw controller.signal.aborted ? new Error('已取消登录，可以重新开始。') : error
      } finally {
        this.operation = undefined
        this.authorizationUrl = null
        this.loginController = null
      }
    })
    this.connectPromise = pending
    const clear = () => { if (this.connectPromise === pending) this.connectPromise = null }
    void pending.then(clear, clear)
    return pending
  }

  async cancelConnect(operationId: string): Promise<ChatGptOAuthStatus> {
    if (!this.operation || this.operation.id !== operationId) throw new Error('登录操作已更新，请刷新状态。')
    if (this.operation.phase === 'saving_profile') throw new Error('登录已完成，正在保存设置。')
    this.setPhase('cancelling')
    this.loginController?.abort(new Error('已取消登录'))
    await this.connectPromise?.catch(() => undefined)
    return this.getStatus()
  }

  async reopenAuthorization(operationId: string): Promise<void> {
    if (this.operation?.id !== operationId || !this.authorizationUrl || this.operation.phase !== 'waiting_browser') {
      throw new Error('授权页面已结束，请刷新状态。')
    }
    await openAuthorizationUrl(this.authorizationUrl)
  }

  private setPhase(phase: ChatGptOAuthPhase): void {
    if (this.operation) this.operation.phase = phase
  }

  async ensureReady(
    savedModels: string[] = [],
    proxyApiKey?: string,
    afterReady?: (status: ChatGptOAuthStatus) => void | Promise<void>,
  ): Promise<ChatGptOAuthStatus> {
    return this.runLifecycle(async () => {
      const status = await this.ensureReadyUnlocked(savedModels, proxyApiKey)
      await afterReady?.(status)
      return status
    })
  }

  private async ensureReadyUnlocked(
    savedModels: string[] = [],
    proxyApiKey?: string,
    signal?: AbortSignal,
  ): Promise<ChatGptOAuthStatus> {
    if (this.server) return this.getStatus()
    if (this.startPromise) return this.startPromise
    if (!this.deps.credentialExists()) {
      const error = new Error('请先完成 ChatGPT 登录。')
      this.lastError = error.message
      throw error
    }
    const normalizedProxyApiKey = normalizeProxyApiKey(proxyApiKey)
    if (!normalizedProxyApiKey) {
      const error = new Error('ChatGPT OAuth 本机访问口令无效，请重新连接。')
      this.lastError = error.message
      throw error
    }

    const models = [...new Set(savedModels.map((model) => String(model || '').trim()).filter(Boolean))]
    this.lastError = null
    this.startPromise = this.deps.startServer(
      models.length > 0 ? models : undefined,
      normalizedProxyApiKey,
      signal,
    )
      .then((server) => {
        this.server = server
        this.models = [...server.models]
        this.proxyApiKey = normalizedProxyApiKey
        return this.getStatus()
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.startPromise = null
      })
    return this.startPromise
  }

  async disconnect(hooks: ChatGptOAuthDisconnectHooks = {}): Promise<ChatGptOAuthStatus> {
    return this.runLifecycle(async () => {
      let disconnectPrepared = false
      try {
        await hooks.beforeDisconnect?.()
        disconnectPrepared = true
        await this.stopServerUnlocked()
        await this.deps.removeCredential()
        this.models = []
        this.proxyApiKey = null
        this.lastError = null
        return this.getStatus()
      } catch (error) {
        if (disconnectPrepared) {
          this.lastError = error instanceof Error ? error.message : String(error)
          const credentialExists = this.deps.credentialExists()
          if (!credentialExists) {
            this.models = []
            this.proxyApiKey = null
          }
          try {
            await hooks.restoreAfterFailure?.({
              credentialExists,
            })
          } catch (restoreError) {
            const message = restoreError instanceof Error ? restoreError.message : String(restoreError)
            await this.deps.removeCredential().catch(() => undefined)
            if (!this.deps.credentialExists()) {
              this.models = []
              this.proxyApiKey = null
            }
            this.lastError = `chatgpt_oauth_disconnect_recovery_failed: ${message}`
            throw new Error(this.lastError, { cause: error })
          }
        }
        throw error
      }
    })
  }

  getProxyApiKey(): string {
    if (!this.proxyApiKey) {
      throw new Error('ChatGPT OAuth 本机访问口令尚未建立。')
    }
    return this.proxyApiKey
  }

  readBoundProxyApiKey(): string | null {
    return this.proxyApiKey
  }

  async stop(): Promise<void> {
    if (this.operation?.phase !== 'saving_profile') this.loginController?.abort(new Error('已取消登录'))
    await this.runLifecycle(() => this.stopServerUnlocked())
  }

  private async stopServerUnlocked(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined)
    }
    const server = this.server
    if (server) {
      await server.close()
      if (this.server === server) this.server = null
    }
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        this.lifecycleBusy = true
        let outcome: Promise<T>
        try {
          outcome = operation()
        } catch (error) {
          outcome = Promise.reject(error)
        }
        const finish = () => {
          const next = this.lifecycleQueue.shift()
          if (next) next()
          else this.lifecycleBusy = false
        }
        void outcome.then(
          (value) => {
            finish()
            resolve(value)
          },
          (error) => {
            finish()
            reject(error)
          },
        )
      }
      if (this.lifecycleBusy) this.lifecycleQueue.push(execute)
      else execute()
    })
  }
}

export function createChatGptOAuthService(authFilePath: string): ChatGptOAuthService {
  return new ChatGptOAuthService({
    credentialExists: () => existsSync(authFilePath),
    login: async ({ signal, onProgress, onAuthorizationUrl }) => {
      await secureAuthStorage(authFilePath)
      const loginSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)])
      const browserController = new AbortController()
      let browserError: Error | null = null
      const combined = AbortSignal.any([loginSignal, browserController.signal])
      try {
        await runOpenAIOAuthLogin({
          authFilePath,
          openBrowser: false,
          signal: combined,
          fetch: async (input, init) => {
            onProgress('exchanging')
            return fetch(input, { ...init, signal: AbortSignal.any([combined, AbortSignal.timeout(30_000)]) })
          },
          onMessage: message => {
            const prefix = 'OpenAI OAuth login URL: '
            if (!message.startsWith(prefix)) return
            const url = message.slice(prefix.length)
            onAuthorizationUrl(url)
            onProgress('waiting_browser')
            void openAuthorizationUrl(url).catch(error => {
              browserError = new Error(`无法打开授权页面：${error instanceof Error ? error.message : String(error)}`)
              browserController.abort()
            })
          },
        })
      } catch (error) {
        if (browserError) throw browserError
        if (error instanceof Error && error.name === 'TimeoutError') throw new Error('确认登录的网络请求超时，请重新登录。')
        if (loginSignal.aborted && !signal.aborted) throw new Error('登录等待超时，请重新登录。')
        throw error
      }
      await chmod(authFilePath, 0o600)
    },
    startServer: async (models, proxyApiKey, signal) => {
      await secureAuthStorage(authFilePath)
      const oauthHandler = createOpenAIOAuthFetchHandler({
        authFilePath,
      })
      const expectedAuthorization = `Bearer ${proxyApiKey}`
      const server = await startAuthenticatedServer(async (request) => {
        if (request.headers.get('authorization') !== expectedAuthorization) {
          return Response.json({
            error: {
              message: 'Unauthorized',
              type: 'authentication_error',
            },
          }, { status: 401 })
        }
        return oauthHandler(request)
      })
      try {
        const resolvedModels = await resolveOAuthServerModels(
          models,
          () => loadOAuthModels(proxyApiKey, signal),
        )
        return {
          models: resolvedModels,
          close: () => closeServer(server),
        }
      } catch (error) {
        await closeServer(server)
        throw error
      }
    },
    removeCredential: async () => {
      await unlink(authFilePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    },
  })
}

export async function resolveOAuthServerModels(
  savedModels: string[] | undefined,
  loadModels: () => Promise<string[]>,
): Promise<string[]> {
  const cached = [...new Set(
    (savedModels || []).map((model) => String(model || '').trim()).filter(Boolean),
  )]
  if (cached.length > 0) return cached
  const loaded = [...new Set(
    (await loadModels()).map((model) => String(model || '').trim()).filter(Boolean),
  )]
  if (loaded.length === 0) throw new Error('ChatGPT 账号没有返回可用模型。')
  return loaded
}

function normalizeProxyApiKey(value: string | undefined): string {
  const normalized = String(value || '').trim()
  return normalized.length >= 32 ? normalized : ''
}

async function secureAuthStorage(authFilePath: string): Promise<void> {
  const authDir = dirname(authFilePath)
  await mkdir(authDir, { recursive: true, mode: 0o700 })
  await chmod(authDir, 0o700)
  if (existsSync(authFilePath)) {
    await chmod(authFilePath, 0o600)
  }
}

async function startAuthenticatedServer(
  fetchHandler: (request: Request) => Promise<Response>,
): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = serve({
      fetch: fetchHandler,
      hostname: '127.0.0.1',
      port: 10532,
    }) as Server
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.once('listening', () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}

async function loadOAuthModels(proxyApiKey: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${CHATGPT_OAUTH_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${proxyApiKey}` },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
  })
  const payload = await response.json() as {
    data?: Array<{ id?: string }>
    error?: { message?: string }
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `模型列表请求失败（${response.status}）`)
  }
  const models = [...new Set(
    (payload.data || []).map((entry) => String(entry.id || '').trim()).filter(Boolean)
  )]
  if (models.length === 0) throw new Error('ChatGPT 账号没有返回可用模型。')
  return models
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeIdleConnections()
    server.closeAllConnections()
  })
}

function isAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/authorize'
  } catch { return false }
}

async function openAuthorizationUrl(url: string): Promise<void> {
  if (!isAuthorizationUrl(url)) throw new Error('授权页面地址无效')
  const { shell } = await import('electron')
  await shell.openExternal(url)
}
