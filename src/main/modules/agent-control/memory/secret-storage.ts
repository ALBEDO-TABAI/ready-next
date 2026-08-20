import {
  createCredentialHandle,
  getCredentialVault,
  isCredentialHandle,
} from '../../settings-engine/credential-vault'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'

const SECRET_KEYS = new Set([
  'token',
  'botToken',
  'appSecret',
  'verificationToken',
  'encryptKey',
  'apiKey',
  'api_key',
  'sessdata',
  'biliJct',
  'bili_jct',
  'cookie',
  'webhook',
  'secret',
])

const LEGACY_ENCRYPTED_PREFIX = '__enc__'
const LEGACY_PLAIN_PREFIX = '__plain__'

export type ChannelSecretState =
  | 'ready'
  | 'missing'
  | 'recovery_required'
  | 'vault_unavailable'

export interface ChannelSecretStatus {
  configured: boolean
  state: ChannelSecretState
}

function emitUnavailable(key: string, kind: string): void {
  logAgentMetric(TOOL_ERROR_METRICS.secretDecryptFailed, {
    key: key || 'unknown',
    errorKind: kind,
  })
}

export function decryptChannelConfig(
  config: Record<string, unknown>,
  owner: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  const vault = getCredentialVault()
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string' || !SECRET_KEYS.has(key) || !value) {
      next[key] = value
      continue
    }
    if (!isCredentialHandle(value, owner, key)) {
      emitUnavailable(key, 'legacy_secret_unavailable')
      next[key] = ''
      continue
    }
    const resolved = vault.read(value)
    if (resolved.state !== 'ready') {
      emitUnavailable(key, resolved.state)
      next[key] = ''
      continue
    }
    next[key] = resolved.value
  }
  return next
}

function readChannelSecretState(
  raw: string,
  owner: string,
  key: string,
): ChannelSecretState {
  if (!raw) return 'missing'
  if (!isCredentialHandle(raw, owner, key)) return 'recovery_required'
  const resolved = getCredentialVault().read(raw)
  return resolved.state === 'vault_unavailable'
    ? 'vault_unavailable'
    : resolved.state === 'ready'
      ? 'ready'
      : 'recovery_required'
}

export function toPublicChannelConfig(
  config: Record<string, unknown>,
  owner: string,
): {
  config: Record<string, unknown>
  secretStatus: Record<string, ChannelSecretStatus>
} {
  const publicConfig: Record<string, unknown> = {}
  const secretStatus: Record<string, ChannelSecretStatus> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string' || !SECRET_KEYS.has(key)) {
      publicConfig[key] = value
      continue
    }
    const state = readChannelSecretState(value, owner, key)
    secretStatus[key] = { configured: state === 'ready', state }
  }
  return { config: publicConfig, secretStatus }
}

export interface PreparedChannelConfigUpdate {
  config: Record<string, unknown>
  commit(): Promise<void>
  rollback(): Promise<void>
}

export async function prepareChannelConfigUpdate(
  config: Record<string, unknown>,
  owner: string,
  previousConfig: Record<string, unknown> = {},
): Promise<PreparedChannelConfigUpdate> {
  const next: Record<string, unknown> = {}
  const changes: Record<string, string | null> = {}
  const stagedHandles: string[] = []
  const replacedHandles = new Set<string>()
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string' || !SECRET_KEYS.has(key)) {
      next[key] = value
      continue
    }
    const previousRaw = typeof previousConfig[key] === 'string' ? previousConfig[key] : ''
    if (!value) {
      if (isCredentialHandle(previousRaw, owner, key)) changes[previousRaw] = null
      next[key] = ''
      continue
    }
    if (
      value.startsWith(LEGACY_ENCRYPTED_PREFIX)
      || value.startsWith(LEGACY_PLAIN_PREFIX)
      || value.startsWith('__ready_credential_v1__')
    ) {
      throw new Error('legacy_secret_requires_reentry')
    }
    const handle = createCredentialHandle(owner, key)
    changes[handle] = value
    stagedHandles.push(handle)
    next[key] = handle
    if (isCredentialHandle(previousRaw, owner, key)) replacedHandles.add(previousRaw)
  }
  for (const [key, value] of Object.entries(previousConfig)) {
    if (typeof value === 'string' && value && SECRET_KEYS.has(key) && !(key in config)) {
      next[key] = value
    }
  }
  if (Object.keys(changes).length > 0) await getCredentialVault().update(changes)
  return {
    config: next,
    async commit(): Promise<void> {
      if (replacedHandles.size === 0) return
      await getCredentialVault().update(
        Object.fromEntries(Array.from(replacedHandles, (handle) => [handle, null])),
      )
    },
    async rollback(): Promise<void> {
      if (stagedHandles.length === 0) return
      await getCredentialVault().update(
        Object.fromEntries(stagedHandles.map((handle) => [handle, null])),
      )
    },
  }
}

export async function clearChannelCredentials(
  config: Record<string, unknown>,
  owner: string,
): Promise<void> {
  const changes: Record<string, null> = {}
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value && SECRET_KEYS.has(key)) {
      if (isCredentialHandle(value, owner, key)) changes[value] = null
    }
  }
  if (Object.keys(changes).length > 0) await getCredentialVault().update(changes)
}
