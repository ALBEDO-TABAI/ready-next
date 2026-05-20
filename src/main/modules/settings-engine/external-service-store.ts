import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { decryptSecretConfig, encryptSecretConfig } from '../agent-control/secret-storage'
import { logAgentMetric } from '../agent-control/metrics'
import { getDatabase } from '../database'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import {
  DEFAULT_EXTERNAL_SERVICE_PROFILES,
  type ExternalServiceKind,
  type ExternalServiceProfile,
  type ExternalServiceTestResult,
  type ExternalServiceUpdateInput,
  type PublicExternalServiceProfile,
  type RuntimeExternalServiceConfig,
  normalizeExternalServiceProfiles,
  toPublicExternalServiceProfile,
  toRuntimeExternalServiceConfig,
} from '../../../shared/external-services'

export const EXTERNAL_SERVICE_SETTINGS_KEY = 'external_service_profiles_v1'

/**
 * U8.3 — legacy Tavily / Jina secret keys (written by the pre-U workspace
 * settings shape) live under these database keys. They are NEVER read by
 * runtime code paths anymore; `migrateLegacyKeysOnce()` is the only call
 * site allowed to touch them, and the CI gate
 * `scripts/check-settings-no-legacy-key-read.cjs` enforces that.
 *
 * Emergency restore: if the legacy keys have to be re-read to recover a
 * broken upgrade, set `READY_SETTINGS_RESTORE_LEGACY_KEYS=1` in the host
 * environment. This is a one-shot escape hatch and intentionally not exposed
 * through any UI — production builds must leave it unset.
 */
const LEGACY_TAVILY_KEY_SETTING = 'web_search_tavily_key'
const LEGACY_JINA_KEY_SETTING = 'web_fetch_jina_key'
const LEGACY_KEY_MIGRATION_DONE_SETTING = 'external_service_legacy_key_migration_done_v1'
const EMERGENCY_RESTORE_ENV = 'READY_SETTINGS_RESTORE_LEGACY_KEYS'

function emergencyRestoreActive(): boolean {
  return process.env[EMERGENCY_RESTORE_ENV] === '1'
}

function nowIso(): string {
  return new Date().toISOString()
}

function safeJsonParse(value: string | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function decryptProfile(profile: ExternalServiceProfile): ExternalServiceProfile {
  return {
    ...profile,
    secrets: decryptSecretConfig(profile.secrets || {}) as Record<string, string>,
  }
}

function encryptProfile(profile: ExternalServiceProfile): ExternalServiceProfile {
  return {
    ...profile,
    secrets: encryptSecretConfig(profile.secrets || {}) as Record<string, string>,
  }
}

function trimBaseUrl(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, '')
}

function optionString(options: Record<string, unknown>, key: string): string {
  const value = options[key]
  return typeof value === 'string' ? value.trim() : ''
}

function optionStringArray(options: Record<string, unknown>, key: string): string[] {
  const value = options[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function deriveApiKind(value: string): AgentSpawnContext['api_kind'] {
  if (value === 'anthropic-messages' || value === 'openai-responses' || value === 'openai-completions') return value
  return 'openai-completions'
}

function hasSecret(profile: ExternalServiceProfile, key: string): boolean {
  return Boolean(String(profile.secrets?.[key] || '').trim())
}

export interface GeneralResearchServiceRuntimeConfig {
  tavilyKey?: string
  tavilyBaseUrl?: string
  jinaKey?: string
  jinaBaseUrl?: string
  ddgEnabled: boolean
  ddgBaseUrl?: string
  preferTavilyExtract?: boolean
}

export class ExternalServiceStore {
  constructor(private readonly repository = new AppSettingsRepository()) {}

  private readProfiles(): ExternalServiceProfile[] {
    const raw = safeJsonParse(this.repository.getSetting(EXTERNAL_SERVICE_SETTINGS_KEY))
    return normalizeExternalServiceProfiles(raw).map(decryptProfile)
  }

  private writeProfiles(profiles: ExternalServiceProfile[]): void {
    this.repository.setSetting(
      EXTERNAL_SERVICE_SETTINGS_KEY,
      JSON.stringify(profiles.map(encryptProfile)),
    )
  }

  listPublicProfiles(): PublicExternalServiceProfile[] {
    return this.readProfiles().map(toPublicExternalServiceProfile)
  }

  getPublicProfile(id: string): PublicExternalServiceProfile | null {
    const profile = this.readProfiles().find((item) => item.id === id)
    return profile ? toPublicExternalServiceProfile(profile) : null
  }

  getRuntimeService(id: string): RuntimeExternalServiceConfig | null {
    const profile = this.readProfiles().find((item) => item.id === id)
    return profile ? toRuntimeExternalServiceConfig(profile) : null
  }

  getFirstRuntimeService(kind: ExternalServiceKind): RuntimeExternalServiceConfig | null {
    const profile = this.readProfiles().find((item) => item.kind === kind)
    return profile ? toRuntimeExternalServiceConfig(profile) : null
  }

  upsertProfile(input: ExternalServiceUpdateInput): PublicExternalServiceProfile {
    if (!input?.id) throw new Error('Missing service id')
    const profiles = this.readProfiles()
    const fallback = profiles.find((item) => item.id === input.id)
      || DEFAULT_EXTERNAL_SERVICE_PROFILES.find((item) => item.id === input.id)
    if (!fallback && !input.kind) throw new Error(`Unknown service: ${input.id}`)

    const next: ExternalServiceProfile = {
      ...(fallback || {
        id: input.id,
        kind: input.kind!,
        name: input.kind!,
        enabled: false,
        secrets: {},
        options: {},
      }),
      id: input.id,
      kind: input.kind || fallback!.kind,
      updatedAt: nowIso(),
    }

    if (typeof input.name === 'string') next.name = input.name.trim() || next.name
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    if ('baseUrl' in input) next.baseUrl = input.baseUrl
    if (input.options) next.options = { ...(next.options || {}), ...input.options }

    const secrets = { ...(next.secrets || {}) }
    for (const key of input.clearSecrets || []) {
      delete secrets[key]
    }
    for (const [key, value] of Object.entries(input.secrets || {})) {
      if (typeof value === 'string' && value.trim()) secrets[key] = value.trim()
    }
    next.secrets = secrets

    const merged = profiles.some((item) => item.id === input.id)
      ? profiles.map((item) => item.id === input.id ? next : item)
      : [...profiles, next]
    this.writeProfiles(normalizeExternalServiceProfiles(merged))
    return toPublicExternalServiceProfile(next)
  }

  resetProfile(id: string): PublicExternalServiceProfile {
    const fallback = DEFAULT_EXTERNAL_SERVICE_PROFILES.find((item) => item.id === id)
    if (!fallback) throw new Error(`Unknown default service: ${id}`)
    const profiles = this.readProfiles()
    const next = { ...fallback, updatedAt: nowIso() }
    const merged = profiles.some((item) => item.id === id)
      ? profiles.map((item) => item.id === id ? next : item)
      : [...profiles, next]
    this.writeProfiles(normalizeExternalServiceProfiles(merged))
    return toPublicExternalServiceProfile(next)
  }

  getGeneralResearchConfig(): GeneralResearchServiceRuntimeConfig {
    const tavily = this.getFirstRuntimeService('tavily')
    const jina = this.getFirstRuntimeService('jina')
    const ddg = this.getFirstRuntimeService('duckduckgo')

    // U8.3 — emergency-only legacy fallback. Default path uses new profile shape.
    // `READY_SETTINGS_RESTORE_LEGACY_KEYS=1` enables a one-shot recovery
    // for broken upgrades; default builds never set it.
    const emergencyLegacyTavilyKey = emergencyRestoreActive()
      ? this.repository.getSetting(LEGACY_TAVILY_KEY_SETTING) || undefined
      : undefined
    const emergencyLegacyJinaKey = emergencyRestoreActive()
      ? this.repository.getSetting(LEGACY_JINA_KEY_SETTING) || undefined
      : undefined

    return {
      tavilyKey: tavily?.enabled ? (tavily.secrets.apiKey || emergencyLegacyTavilyKey) : emergencyLegacyTavilyKey,
      tavilyBaseUrl: tavily?.enabled ? trimBaseUrl(tavily.baseUrl) : undefined,
      jinaKey: jina?.enabled ? (jina.secrets.apiKey || emergencyLegacyJinaKey) : emergencyLegacyJinaKey,
      jinaBaseUrl: jina?.enabled ? trimBaseUrl(jina.baseUrl) : undefined,
      ddgEnabled: ddg ? ddg.enabled : true,
      ddgBaseUrl: ddg?.enabled ? trimBaseUrl(ddg.baseUrl) : undefined,
    }
  }

  /**
   * U8.3 — One-shot migration of legacy Tavily/Jina secrets into the
   * external-service profile shape. Idempotent: tracks completion via
   * `LEGACY_KEY_MIGRATION_DONE_SETTING`. After migration the legacy DB rows
   * are cleared so the only path back to them is the emergency env flag.
   */
  migrateLegacyKeysOnce(): { migrated: number; alreadyDone: boolean } {
    const done = this.repository.getSetting(LEGACY_KEY_MIGRATION_DONE_SETTING)
    if (done === 'true') return { migrated: 0, alreadyDone: true }

    const legacyTavily = (this.repository.getSetting(LEGACY_TAVILY_KEY_SETTING) || '').trim()
    const legacyJina = (this.repository.getSetting(LEGACY_JINA_KEY_SETTING) || '').trim()

    let migrated = 0
    if (legacyTavily || legacyJina) {
      const profiles = this.readProfiles()
      const tavily = profiles.find((p) => p.kind === 'tavily')
      const jina = profiles.find((p) => p.kind === 'jina')
      if (legacyTavily && tavily && !tavily.secrets.apiKey) {
        tavily.secrets = { ...tavily.secrets, apiKey: legacyTavily }
        tavily.enabled = true
        tavily.updatedAt = nowIso()
        migrated += 1
      }
      if (legacyJina && jina && !jina.secrets.apiKey) {
        jina.secrets = { ...jina.secrets, apiKey: legacyJina }
        jina.enabled = true
        jina.updatedAt = nowIso()
        migrated += 1
      }
      if (migrated > 0) this.writeProfiles(normalizeExternalServiceProfiles(profiles))
    }

    this.repository.setSetting(LEGACY_TAVILY_KEY_SETTING, '')
    this.repository.setSetting(LEGACY_JINA_KEY_SETTING, '')
    this.repository.setSetting(LEGACY_KEY_MIGRATION_DONE_SETTING, 'true')
    logAgentMetric('settings.legacy_key_migration_completed', { migrated })

    return { migrated, alreadyDone: false }
  }

  buildVisionAgentContext(serviceId = 'vision-model-default'): AgentSpawnContext | null {
    const service = this.getRuntimeService(serviceId)
    if (!service || !service.enabled) return null
    const options = service.options as Record<string, unknown>
    const provider = optionString(options, 'provider') || 'openai-compatible'
    const modelId = optionString(options, 'model')
    const baseUrl = trimBaseUrl(service.baseUrl) || ''
    const apiKey = String(service.secrets.apiKey || '').trim()
    if (!modelId || !baseUrl || !apiKey) return null

    const inputModes = optionStringArray(options, 'inputModes')
    return {
      provider,
      model_id: modelId,
      base_url: baseUrl,
      api_key: apiKey,
      api_kind: deriveApiKind(optionString(options, 'apiKind')),
      fallback_chain: [],
      input_modes: inputModes.includes('image') ? ['text', 'image'] : ['text'],
    }
  }

  getSkillExternalEnv(skillId: string): Record<string, string> {
    const env: Record<string, string> = {}
    if (skillId === 'lets-go-rss') {
      const rsshub = this.getFirstRuntimeService('rsshub')
      if (rsshub?.enabled && rsshub.baseUrl) env.RSSHUB_BASE_URL = trimBaseUrl(rsshub.baseUrl) || rsshub.baseUrl
    }
    if (skillId === 'video-copy-analyzer' || skillId === 'video-expert-analyzer') {
      const bilibili = this.getFirstRuntimeService('bilibili')
      if (bilibili?.enabled) {
        if (bilibili.secrets.sessdata) env.BILIBILI_SESSDATA = bilibili.secrets.sessdata
        if (bilibili.secrets.biliJct) env.BILIBILI_BILI_JCT = bilibili.secrets.biliJct
        const cookieFile = optionString(bilibili.options, 'cookieFile')
        if (cookieFile) env.BILIBILI_COOKIE_FILE = cookieFile
      }
    }
    const github = this.getFirstRuntimeService('github')
    if (github?.enabled && github.secrets.token) env.GITHUB_TOKEN = github.secrets.token
    return env
  }

  async testProfile(id: string): Promise<ExternalServiceTestResult> {
    const profile = this.readProfiles().find((item) => item.id === id)
    if (!profile) throw new Error(`Unknown service: ${id}`)
    const start = Date.now()
    if (!profile.enabled) {
      return { ok: false, serviceId: id, message: '服务未启用' }
    }
    if (profile.kind === 'tavily' && !hasSecret(profile, 'apiKey')) {
      return { ok: false, serviceId: id, message: '缺少 Tavily API Key' }
    }
    if (profile.kind === 'vision-model' && (!profile.baseUrl || !hasSecret(profile, 'apiKey') || !optionString(profile.options || {}, 'model'))) {
      return { ok: false, serviceId: id, message: '缺少读图模型 baseUrl / model / apiKey' }
    }
    if (profile.kind === 'bilibili' && !hasSecret(profile, 'sessdata')) {
      return { ok: false, serviceId: id, message: '未配置 Bilibili SESSDATA' }
    }
    if (profile.kind === 'github' && !hasSecret(profile, 'token')) {
      return { ok: false, serviceId: id, message: '未配置 GitHub Token' }
    }
    if (profile.kind === 'rsshub' || profile.kind === 'duckduckgo' || profile.kind === 'jina') {
      const baseUrl = trimBaseUrl(profile.baseUrl)
      if (!baseUrl) return { ok: false, serviceId: id, message: '缺少服务地址' }
      const probeUrl = profile.kind === 'jina'
        ? `${baseUrl}/https://example.com`
        : profile.kind === 'duckduckgo'
          ? `${baseUrl}/html/?q=ready`
          : baseUrl
      const response = await fetch(probeUrl, { method: 'GET', signal: AbortSignal.timeout(8_000) })
      return {
        ok: response.ok,
        serviceId: id,
        message: response.ok ? '连接正常' : `HTTP ${response.status}`,
        latencyMs: Date.now() - start,
      }
    }
    return { ok: true, serviceId: id, message: '配置已就绪', latencyMs: Date.now() - start }
  }
}
