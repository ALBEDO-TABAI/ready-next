import { getDatabase } from '../database'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { EXTERNAL_SERVICE_SETTINGS_KEY } from './external-service-store'
import {
  CREDENTIAL_HANDLE_PREFIX,
  getCredentialVault,
  isCredentialHandle,
  type CredentialVaultPort,
} from './credential-vault'

interface StoredChannelConfig {
  id: string
  config_json: string
}

function parseJson(raw: string, errorCode: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(errorCode)
  }
}

function asRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode)
  }
  return value as Record<string, unknown>
}

function containsCredentialHandle(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith(CREDENTIAL_HANDLE_PREFIX)
  if (Array.isArray(value)) return value.some(containsCredentialHandle)
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsCredentialHandle)
  }
  return false
}

export function collectStoredCredentialHandles(
  externalProfilesRaw: string | undefined,
  channels: readonly StoredChannelConfig[],
): Set<string> {
  const keep = new Set<string>()
  if (externalProfilesRaw !== undefined) {
    const profiles = parseJson(
      externalProfilesRaw,
      'credential_reference_external_invalid_json',
    )
    if (!Array.isArray(profiles)) {
      throw new Error('credential_reference_external_invalid_shape')
    }
    for (const value of profiles) {
      const profile = asRecord(value, 'credential_reference_external_profile_invalid')
      const id = typeof profile.id === 'string' ? profile.id.trim() : ''
      if (!id) throw new Error('credential_reference_external_profile_invalid')
      const secrets = profile.secrets === undefined
        ? {}
        : asRecord(profile.secrets, 'credential_reference_external_secrets_invalid')
      for (const [key, raw] of Object.entries(secrets)) {
        if (typeof raw !== 'string') {
          throw new Error('credential_reference_external_secret_invalid')
        }
        if (!raw.startsWith(CREDENTIAL_HANDLE_PREFIX)) continue
        if (!isCredentialHandle(raw, `external-service:${id}`, key)) {
          throw new Error('credential_reference_external_handle_invalid')
        }
        keep.add(raw)
      }
      for (const [key, raw] of Object.entries(profile)) {
        if (key !== 'secrets' && containsCredentialHandle(raw)) {
          throw new Error('credential_reference_external_handle_misplaced')
        }
      }
    }
  }

  for (const row of channels) {
    const config = asRecord(
      parseJson(row.config_json, 'credential_reference_channel_invalid_json'),
      'credential_reference_channel_invalid_shape',
    )
    const owner = `channel:${row.id}`
    for (const [key, raw] of Object.entries(config)) {
      if (typeof raw === 'string' && raw.startsWith(CREDENTIAL_HANDLE_PREFIX)) {
        if (!isCredentialHandle(raw, owner, key)) {
          throw new Error('credential_reference_channel_handle_invalid')
        }
        keep.add(raw)
      } else if (containsCredentialHandle(raw)) {
        throw new Error('credential_reference_channel_handle_misplaced')
      }
    }
  }
  return keep
}

export async function pruneUnreferencedCredentials(
  vault: CredentialVaultPort,
  externalProfilesRaw: string | undefined,
  channels: readonly StoredChannelConfig[],
): Promise<number> {
  const keep = collectStoredCredentialHandles(externalProfilesRaw, channels)
  return vault.prune(keep)
}

export async function pruneUnreferencedCredentialsAtStartup(): Promise<number> {
  const repository = new AppSettingsRepository()
  const channels = getDatabase().listAgentChannels()
  return pruneUnreferencedCredentials(
    getCredentialVault(),
    repository.getSetting(EXTERNAL_SERVICE_SETTINGS_KEY),
    channels,
  )
}
