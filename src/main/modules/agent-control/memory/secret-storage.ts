import { createRequire } from 'module'

import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'

const electronModule = (() => {
  try { return createRequire(import.meta.url)('electron') as typeof import('electron') }
  catch {
    // silent-catch: tolerate non-electron host (test runtime); secrets fall back to xor obfuscation; no user-facing impact
    return {} as typeof import('electron')
  }
})()
const { app } = electronModule
let safeStorage = electronModule.safeStorage

const SECRET_KEYS = new Set([
  'token',
  'botToken',
  'appSecret',
  'apiKey',
  'api_key',
  'sessdata',
  'biliJct',
  'bili_jct',
  'cookie',
  'webhook',
  'secret',
])

const ENC_PREFIX = '__enc__'
const PLAIN_PREFIX = '__plain__'

function fallbackSecretKey(): Buffer {
  const seed = `${app?.getPath?.('userData') || process.cwd()}::ready-agent-channel-config`
  return Buffer.from(seed, 'utf8')
}

function xorCipher(input: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i] ^ key[i % key.length]
  }
  return out
}

function encryptValue(raw: string): string {
  if (!raw) return raw
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      const encrypted = safeStorage.encryptString(raw)
      return `${ENC_PREFIX}${encrypted.toString('base64')}`
    }
  } catch {
    // fallback below
  }
  const xored = xorCipher(Buffer.from(raw, 'utf8'), fallbackSecretKey())
  return `${PLAIN_PREFIX}${xored.toString('base64')}`
}

function errorKind(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : typeof error
}

function decryptValue(raw: string, key?: string): string {
  if (!raw) return raw
  try {
    if (raw.startsWith(ENC_PREFIX)) {
      const b64 = raw.slice(ENC_PREFIX.length)
      if (!safeStorage?.decryptString) {
        logAgentMetric(TOOL_ERROR_METRICS.secretDecryptFailed, {
          key: key || 'unknown',
          errorKind: 'decrypt_unavailable',
        })
        return raw
      }
      const decrypted = safeStorage.decryptString(Buffer.from(b64, 'base64'))
      return decrypted
    }
    if (raw.startsWith(PLAIN_PREFIX)) {
      const b64 = raw.slice(PLAIN_PREFIX.length)
      const decoded = xorCipher(Buffer.from(b64, 'base64'), fallbackSecretKey())
      return decoded.toString('utf8')
    }
    return raw
  } catch (error) {
    logAgentMetric(TOOL_ERROR_METRICS.secretDecryptFailed, {
      key: key || 'unknown',
      errorKind: errorKind(error),
    })
    return raw
  }
}

function mapSecretFields(
  value: Record<string, unknown>,
  mapper: (raw: string, key: string) => string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && SECRET_KEYS.has(key)) {
      next[key] = mapper(val, key)
    } else {
      next[key] = val
    }
  }
  return next
}

export function encryptChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  return mapSecretFields(config, encryptValue)
}

export function decryptChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  return mapSecretFields(config, decryptValue)
}

export const encryptSecretConfig = encryptChannelConfig
export const decryptSecretConfig = decryptChannelConfig

export function __setSafeStorageForTests(nextSafeStorage: typeof safeStorage | null): void {
  safeStorage = nextSafeStorage || electronModule.safeStorage
}
