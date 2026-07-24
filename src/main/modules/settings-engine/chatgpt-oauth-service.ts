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

export class ChatGptOAuthService {
  private server: ChatGptOAuthServer | null = null
  private startPromise: Promise<ChatGptOAuthStatus> | null = null
  private models: string[] = []
  private proxyApiKey: string | null = null
  private lastError: string | null = null

  constructor(private readonly deps: ChatGptOAuthServiceDeps) {}

  getStatus(): ChatGptOAuthStatus {
    const connected = this.deps.credentialExists()
    if (this.server) {
      return {
        state: 'ready',
        connected,
        running: true,
        baseUrl: CHATGPT_OAUTH_BASE_URL,
        models: [...this.models],
      }
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
    savedModels: string[] = [],
  ): Promise<ChatGptOAuthStatus> {
    this.lastError = null
    try {
      await this.deps.login()
      await this.stopServer()
      const proxyApiKey = normalizeProxyApiKey(existingProxyApiKey) || randomBytes(32).toString('base64url')
      return await this.ensureReady(savedModels, proxyApiKey)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async ensureReady(savedModels: string[] = [], proxyApiKey?: string): Promise<ChatGptOAuthStatus> {
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

  async disconnect(): Promise<ChatGptOAuthStatus> {
    await this.stopServer()
    await this.deps.removeCredential()
    this.models = []
    this.proxyApiKey = null
    this.lastError = null
    return this.getStatus()
  }

  getProxyApiKey(): string {
    if (!this.proxyApiKey) {
      throw new Error('ChatGPT OAuth 本机访问口令尚未建立。')
    }
    return this.proxyApiKey
  }

  async stop(): Promise<void> {
    await this.stopServer()
  }

  private async stopServer(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined)
    }
    const server = this.server
    this.server = null
    if (server) await server.close()
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
        models,
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
        const resolvedModels = models || await loadOAuthModels(proxyApiKey)
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
