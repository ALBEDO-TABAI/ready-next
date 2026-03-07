import { app, safeStorage } from 'electron'

const SECRET_KEYS = new Set([
  'token',
  'botToken',
  'appSecret',
  'webhook',
  'secret',
])

const ENC_PREFIX = '__enc__'
const PLAIN_PREFIX = '__plain__'

function fallbackSecretKey(): Buffer {
  const seed = `${app.getPath('userData')}::ready-agent-channel-config`
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
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(raw)
      return `${ENC_PREFIX}${encrypted.toString('base64')}`
    }
  } catch {
    // fallback below
  }
  const xored = xorCipher(Buffer.from(raw, 'utf8'), fallbackSecretKey())
  return `${PLAIN_PREFIX}${xored.toString('base64')}`
}

function decryptValue(raw: string): string {
  if (!raw) return raw
  try {
    if (raw.startsWith(ENC_PREFIX)) {
      const b64 = raw.slice(ENC_PREFIX.length)
      const decrypted = safeStorage.decryptString(Buffer.from(b64, 'base64'))
      return decrypted
    }
    if (raw.startsWith(PLAIN_PREFIX)) {
      const b64 = raw.slice(PLAIN_PREFIX.length)
      const decoded = xorCipher(Buffer.from(b64, 'base64'), fallbackSecretKey())
      return decoded.toString('utf8')
    }
    return raw
  } catch {
    return raw
  }
}

function mapSecretFields(
  value: Record<string, unknown>,
  mapper: (raw: string) => string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && SECRET_KEYS.has(key)) {
      next[key] = mapper(val)
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

