import { existsSync } from 'node:fs'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
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
} from '../../../shared/chatgpt-oauth'

interface ChatGptOAuthServer {
  models: string[]
  close(): Promise<void>
}

export interface ChatGptOAuthServiceDeps {
  credentialExists(): boolean
  login(): Promise<void>
  startServer(models: string[] | undefined, proxyApiKey: string): Promise<ChatGptOAuthServer>
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

  async connect(
    existingProxyApiKey?: string,
    hooks: ChatGptOAuthConnectHooks = {},
  ): Promise<ChatGptOAuthStatus> {
    return this.runLifecycle(async () => {
      this.lastError = null
      let authorizationStarted = false
      try {
        const prepared = await hooks.beforeRestart?.()
        const preparedProxyApiKey = prepared?.existingProxyApiKey ?? existingProxyApiKey
        authorizationStarted = true
        await this.stopServerUnlocked()
        await this.deps.login()
        const proxyApiKey = normalizeProxyApiKey(preparedProxyApiKey) || randomBytes(32).toString('base64url')
        const status = await this.ensureReadyUnlocked([], proxyApiKey)
        await hooks.afterReady?.(status)
        return status
      } catch (error) {
        if (authorizationStarted) {
          await this.stopServerUnlocked().catch(() => undefined)
          await this.deps.removeCredential().catch(() => undefined)
          this.models = []
          this.proxyApiKey = null
          this.lastError = error instanceof Error ? error.message : String(error)
        }
        throw error
      }
    })
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
    login: async () => {
      await secureAuthStorage(authFilePath)
      await runOpenAIOAuthLogin({
        authFilePath,
        openBrowser: true,
        onMessage: () => undefined,
      })
      await chmod(authFilePath, 0o600)
    },
    startServer: async (models, proxyApiKey) => {
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
          () => loadOAuthModels(proxyApiKey),
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

async function loadOAuthModels(proxyApiKey: string): Promise<string[]> {
  const response = await fetch(`${CHATGPT_OAUTH_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${proxyApiKey}` },
    signal: AbortSignal.timeout(30_000),
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
