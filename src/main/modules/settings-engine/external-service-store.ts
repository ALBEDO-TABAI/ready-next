import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { logAgentMetric } from '../agent-control/metrics'
import { getDatabase } from '../database'
import {
  createCredentialHandle,
  getCredentialVault,
  isCredentialHandle,
  type CredentialVaultPort,
} from './credential-vault'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import {
  generateImageBytes,
  resolveImageGenerationClientConfig,
} from '../image-generation/image-generation-client'
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

const CREDENTIAL_MIGRATION_SETTING = 'external_service_credential_migration_v1'

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

type ExternalSecretState = PublicExternalServiceProfile['secretStatus'][string]['state']

interface ResolvedExternalServiceProfile {
  profile: ExternalServiceProfile
  secretStates: Record<string, ExternalSecretState>
}

function externalCredentialOwner(profileId: string): string {
  return `external-service:${profileId}`
}

function isStoredLegacySecret(value: string): boolean {
  return value.startsWith('__enc__')
    || value.startsWith('__plain__')
    || value.startsWith('__ready_credential_v1__')
}

let externalServiceMutationTail: Promise<void> = Promise.resolve()

function serializeExternalServiceMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = externalServiceMutationTail.then(operation)
  externalServiceMutationTail = result.then(() => undefined, () => undefined)
  return result
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
  anysearchEnabled: boolean
  anysearchKey?: string
  anysearchBaseUrl?: string
  tavilyKey?: string
  tavilyBaseUrl?: string
  jinaKey?: string
  jinaBaseUrl?: string
  ddgEnabled: boolean
  ddgBaseUrl?: string
  preferredSearchService?: 'anysearch' | 'tavily' | 'duckduckgo'
  preferredFetchService?: 'anysearch' | 'jina' | 'tavily'
  preferTavilyExtract?: boolean
}

export interface AmapServiceRuntimeConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  secretState: ExternalSecretState
}

export function shouldReserveAmapRouteTool(config: AmapServiceRuntimeConfig | null): boolean {
  return config?.enabled === true && config.secretState !== 'missing'
}

export class ExternalServiceStore {
  constructor(
    private readonly repository = new AppSettingsRepository(),
    private readonly vault: CredentialVaultPort = getCredentialVault(),
  ) {}

  private readStoredProfiles(): ExternalServiceProfile[] {
    const raw = safeJsonParse(this.repository.getSetting(EXTERNAL_SERVICE_SETTINGS_KEY))
    return normalizeExternalServiceProfiles(raw)
  }

  private resolveStoredProfile(stored: ExternalServiceProfile): ResolvedExternalServiceProfile {
    const secrets: Record<string, string> = {}
    const secretStates: Record<string, ExternalSecretState> = {}
    const owner = externalCredentialOwner(stored.id)
    for (const [key, raw] of Object.entries(stored.secrets || {})) {
      if (!raw) {
        secrets[key] = ''
        secretStates[key] = 'missing'
        continue
      }
      if (!isCredentialHandle(raw, owner, key)) {
        secrets[key] = ''
        secretStates[key] = 'recovery_required'
        continue
      }
      const result = this.vault.read(raw)
      if (result.state === 'ready') {
        secrets[key] = result.value
        secretStates[key] = 'ready'
      } else {
        secrets[key] = ''
        secretStates[key] = result.state === 'vault_unavailable'
          ? 'vault_unavailable'
          : 'recovery_required'
      }
    }
    return {
      profile: { ...stored, secrets },
      secretStates,
    }
  }

  private readResolvedProfiles(): ResolvedExternalServiceProfile[] {
    return this.readStoredProfiles().map((profile) => this.resolveStoredProfile(profile))
  }

  private readProfiles(): ExternalServiceProfile[] {
    return this.readResolvedProfiles().map((item) => item.profile)
  }

  private async writeProfiles(profiles: ExternalServiceProfile[]): Promise<void> {
    const currentProfiles = this.readStoredProfiles()
    const changes: Record<string, string | null> = {}
    const stagedHandles: string[] = []
    const replacedHandles = new Set<string>()
    const storedProfiles = profiles.map((profile) => {
      const owner = externalCredentialOwner(profile.id)
      const current = currentProfiles.find((item) => item.id === profile.id)
      const secrets: Record<string, string> = {}
      for (const [key, raw] of Object.entries(profile.secrets || {})) {
        const previousRaw = String(current?.secrets?.[key] || '')
        if (!raw) {
          if (isCredentialHandle(previousRaw, owner, key)) changes[previousRaw] = null
          secrets[key] = ''
        } else if (isCredentialHandle(raw, owner, key) || isStoredLegacySecret(raw)) {
          secrets[key] = raw
        } else {
          const handle = createCredentialHandle(owner, key)
          changes[handle] = raw
          stagedHandles.push(handle)
          secrets[key] = handle
          if (isCredentialHandle(previousRaw, owner, key)) replacedHandles.add(previousRaw)
        }
      }
      return { ...profile, secrets }
    })
    if (Object.keys(changes).length > 0) await this.vault.update(changes)
    try {
      this.repository.setSetting(
        EXTERNAL_SERVICE_SETTINGS_KEY,
        JSON.stringify(storedProfiles),
      )
    } catch (error) {
      if (stagedHandles.length > 0) {
        await this.vault.update(Object.fromEntries(stagedHandles.map((handle) => [handle, null])))
          .catch(() => undefined)
      }
      throw error
    }
    if (replacedHandles.size > 0) {
      await this.vault.update(Object.fromEntries(Array.from(replacedHandles, (handle) => [handle, null])))
        .catch((error) => {
          logAgentMetric('settings.credential_retired_handle_cleanup_failed', {
            errorKind: error instanceof Error ? error.name : typeof error,
          })
        })
    }
  }

  listPublicProfiles(): PublicExternalServiceProfile[] {
    return this.readResolvedProfiles().map((item) => (
      toPublicExternalServiceProfile(item.profile, item.secretStates)
    ))
  }

  getPublicProfile(id: string): PublicExternalServiceProfile | null {
    const resolved = this.readResolvedProfiles().find((item) => item.profile.id === id)
    return resolved ? toPublicExternalServiceProfile(resolved.profile, resolved.secretStates) : null
  }

  getRuntimeService(id: string): RuntimeExternalServiceConfig | null {
    const profile = this.readProfiles().find((item) => item.id === id)
    return profile ? toRuntimeExternalServiceConfig(profile) : null
  }

  getFirstRuntimeService(kind: ExternalServiceKind): RuntimeExternalServiceConfig | null {
    const profile = this.readProfiles().find((item) => item.kind === kind)
    return profile ? toRuntimeExternalServiceConfig(profile) : null
  }

  getFirstEnabledImageGenerationService(): RuntimeExternalServiceConfig | null {
    const profile = this.readProfiles().find((item) => item.kind === 'image-generation' && item.enabled)
    return profile ? toRuntimeExternalServiceConfig(profile) : null
  }

  private resolveProfileDraft(
    input: ExternalServiceUpdateInput,
    touchUpdatedAt: boolean,
    preserveStoredSecrets: boolean,
  ): ExternalServiceProfile {
    if (!input?.id) throw new Error('Missing service id')
    const storedProfiles = this.readStoredProfiles()
    const storedFallback = storedProfiles.find((item) => item.id === input.id)
    const fallback = storedFallback
      ? this.resolveStoredProfile(storedFallback).profile
      : DEFAULT_EXTERNAL_SERVICE_PROFILES.find((item) => item.id === input.id)
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
    }
    if (touchUpdatedAt) next.updatedAt = nowIso()

    if (typeof input.name === 'string') next.name = input.name.trim() || next.name
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled
    if ('baseUrl' in input) next.baseUrl = input.baseUrl
    if (input.options) next.options = { ...(next.options || {}), ...input.options }

    const secrets = preserveStoredSecrets
      ? { ...(storedFallback?.secrets || next.secrets || {}) }
      : { ...(next.secrets || {}) }
    for (const key of input.clearSecrets || []) {
      delete secrets[key]
    }
    for (const [key, value] of Object.entries(input.secrets || {})) {
      if (typeof value === 'string' && value.trim()) secrets[key] = value.trim()
    }
    next.secrets = secrets

    return next
  }

  async upsertProfile(input: ExternalServiceUpdateInput): Promise<PublicExternalServiceProfile> {
    return serializeExternalServiceMutation(() => this.upsertProfileNow(input))
  }

  private async upsertProfileNow(input: ExternalServiceUpdateInput): Promise<PublicExternalServiceProfile> {
    const profiles = this.readStoredProfiles()
    const next = this.resolveProfileDraft(input, true, true)
    const merged = profiles.some((item) => item.id === input.id)
      ? profiles.map((item) => item.id === input.id ? next : item)
      : [...profiles, next]
    await this.writeProfiles(normalizeExternalServiceProfiles(merged))
    const saved = this.getPublicProfile(input.id)
    if (!saved) throw new Error(`External service save failed: ${input.id}`)
    return saved
  }

  async resetProfile(id: string): Promise<PublicExternalServiceProfile> {
    return serializeExternalServiceMutation(() => this.resetProfileNow(id))
  }

  private async resetProfileNow(id: string): Promise<PublicExternalServiceProfile> {
    const fallback = DEFAULT_EXTERNAL_SERVICE_PROFILES.find((item) => item.id === id)
    if (!fallback) throw new Error(`Unknown default service: ${id}`)
    const profiles = this.readStoredProfiles()
    const next = { ...fallback, updatedAt: nowIso() }
    const merged = profiles.some((item) => item.id === id)
      ? profiles.map((item) => item.id === id ? next : item)
      : [...profiles, next]
    await this.writeProfiles(normalizeExternalServiceProfiles(merged))
    const saved = this.getPublicProfile(id)
    if (!saved) throw new Error(`External service reset failed: ${id}`)
    return saved
  }

  getGeneralResearchConfig(): GeneralResearchServiceRuntimeConfig {
    const anysearch = this.getFirstRuntimeService('anysearch')
    const tavily = this.getFirstRuntimeService('tavily')
    const jina = this.getFirstRuntimeService('jina')
    const ddg = this.getFirstRuntimeService('duckduckgo')

    return {
      anysearchEnabled: anysearch?.enabled === true,
      anysearchKey: anysearch?.enabled ? anysearch.secrets.apiKey || undefined : undefined,
      anysearchBaseUrl: anysearch?.enabled ? trimBaseUrl(anysearch.baseUrl) : undefined,
      tavilyKey: tavily?.enabled ? tavily.secrets.apiKey || undefined : undefined,
      tavilyBaseUrl: tavily?.enabled ? trimBaseUrl(tavily.baseUrl) : undefined,
      jinaKey: jina?.enabled ? jina.secrets.apiKey || undefined : undefined,
      jinaBaseUrl: jina?.enabled ? trimBaseUrl(jina.baseUrl) : undefined,
      ddgEnabled: ddg ? ddg.enabled : true,
      ddgBaseUrl: ddg?.enabled ? trimBaseUrl(ddg.baseUrl) : undefined,
    }
  }

  getAmapConfig(): AmapServiceRuntimeConfig | null {
    const resolved = this.readResolvedProfiles().find((item) => item.profile.kind === 'amap')
    if (!resolved) return null
    const amap = resolved.profile
    return {
      enabled: amap.enabled,
      baseUrl: trimBaseUrl(amap.baseUrl) || 'https://restapi.amap.com',
      apiKey: String(amap.secrets?.apiKey || '').trim(),
      secretState: resolved.secretStates.apiKey || 'missing',
    }
  }

  async migrateStoredCredentialsOnce(): Promise<{
    migrated: number
    unresolved: number
    alreadyDone: boolean
  }> {
    if (this.repository.getSetting(CREDENTIAL_MIGRATION_SETTING)) {
      return { migrated: 0, unresolved: 0, alreadyDone: true }
    }
    return serializeExternalServiceMutation(async () => {
      if (this.repository.getSetting(CREDENTIAL_MIGRATION_SETTING)) {
        return { migrated: 0, unresolved: 0, alreadyDone: true }
      }
      const profiles = this.readStoredProfiles()
      let unresolved = 0
      for (const profile of profiles) {
        const owner = externalCredentialOwner(profile.id)
        for (const [key, raw] of Object.entries(profile.secrets || {})) {
          if (raw && !isCredentialHandle(raw, owner, key)) unresolved += 1
        }
      }
      this.repository.setSetting(CREDENTIAL_MIGRATION_SETTING, JSON.stringify({
        attemptedAt: nowIso(),
        migrated: 0,
        unresolved,
      }))
      logAgentMetric('settings.credential_migration_completed', { migrated: 0, unresolved })
      return { migrated: 0, unresolved, alreadyDone: false }
    })
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
    return env
  }

  async testProfile(id: string): Promise<ExternalServiceTestResult> {
    const resolved = this.readResolvedProfiles().find((item) => item.profile.id === id)
    if (!resolved) throw new Error(`Unknown service: ${id}`)
    const blockedState = Object.values(resolved.secretStates).find(
      (state) => state === 'recovery_required' || state === 'vault_unavailable',
    )
    if (blockedState) {
      return {
        ok: false,
        serviceId: id,
        message: blockedState === 'vault_unavailable'
          ? '本地凭据库暂不可用，请修复后重试'
          : '升级后无法读取原密钥，请重新填写并保存',
      }
    }
    return this.testResolvedProfile(resolved.profile)
  }

  async testProfileDraft(input: ExternalServiceUpdateInput): Promise<ExternalServiceTestResult> {
    const current = this.readResolvedProfiles().find((item) => item.profile.id === input.id)
    const blockedState = current && Object.entries(current.secretStates).find(([key, state]) => (
      (state === 'recovery_required' || state === 'vault_unavailable')
      && !String(input.secrets?.[key] || '').trim()
      && !(input.clearSecrets || []).includes(key)
    ))?.[1]
    if (blockedState) {
      return {
        ok: false,
        serviceId: input.id,
        message: blockedState === 'vault_unavailable'
          ? '本地凭据库暂不可用，请修复后重试'
          : '升级后无法读取原密钥，请重新填写并保存',
      }
    }
    return this.testResolvedProfile(this.resolveProfileDraft(input, false, false))
  }

  private async testResolvedProfile(profile: ExternalServiceProfile): Promise<ExternalServiceTestResult> {
    const start = Date.now()
    if (!profile.enabled) {
      return { ok: false, serviceId: profile.id, message: '服务未启用' }
    }
    if (profile.kind === 'tavily' && !hasSecret(profile, 'apiKey')) {
      return { ok: false, serviceId: profile.id, message: '缺少 Tavily API Key' }
    }
    if (profile.kind === 'image-generation') {
      try {
        const config = resolveImageGenerationClientConfig(toRuntimeExternalServiceConfig(profile))
        await generateImageBytes({
          config,
          prompt: '一枚简单的橙色圆点，纯白背景，无文字。',
        })
        return {
          ok: true,
          serviceId: profile.id,
          message: '试生成成功，测试图片已丢弃',
          latencyMs: Date.now() - start,
        }
      } catch (error) {
        return {
          ok: false,
          serviceId: profile.id,
          message: error instanceof Error ? error.message : String(error),
          latencyMs: Date.now() - start,
        }
      }
    }
    if (profile.kind === 'anysearch') {
      const endpoint = trimBaseUrl(profile.baseUrl)
      if (!endpoint) return { ok: false, serviceId: profile.id, message: '缺少服务地址' }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Anysearch-Client': 'ready-settings/1.0',
      }
      const apiKey = String(profile.secrets?.apiKey || '').trim()
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search',
            arguments: { query: 'Ready', max_results: 1 },
          },
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) {
        return { ok: false, serviceId: profile.id, message: `HTTP ${response.status}`, latencyMs: Date.now() - start }
      }
      const payload = await response.json() as {
        error?: { message?: string }
        result?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (payload.error) {
        return {
          ok: false,
          serviceId: profile.id,
          message: payload.error.message || 'AnySearch 返回错误',
          latencyMs: Date.now() - start,
        }
      }
      const hasText = payload.result?.content?.some((item) => item.type === 'text' && Boolean(item.text)) === true
      return {
        ok: hasText,
        serviceId: profile.id,
        message: hasText ? '连接正常' : 'AnySearch 未返回可读内容',
        latencyMs: Date.now() - start,
      }
    }
    if (profile.kind === 'vision-model' && (!profile.baseUrl || !hasSecret(profile, 'apiKey') || !optionString(profile.options || {}, 'model'))) {
      return { ok: false, serviceId: profile.id, message: '缺少读图模型 baseUrl / model / apiKey' }
    }
    if (profile.kind === 'bilibili' && !hasSecret(profile, 'sessdata')) {
      return { ok: false, serviceId: profile.id, message: '未配置 Bilibili SESSDATA' }
    }
    if (profile.kind === 'github' && !hasSecret(profile, 'token')) {
      return { ok: false, serviceId: profile.id, message: '未配置 GitHub Token' }
    }
    if (profile.kind === 'amap') {
      if (!hasSecret(profile, 'apiKey')) {
        return { ok: false, serviceId: profile.id, message: '缺少高德地图 API Key' }
      }
      const baseUrl = trimBaseUrl(profile.baseUrl) || 'https://restapi.amap.com'
      const probeUrl = new URL('/v3/geocode/geo', baseUrl)
      probeUrl.searchParams.set('address', '北京市东城区天安门')
      probeUrl.searchParams.set('city', '北京')
      probeUrl.searchParams.set('output', 'JSON')
      probeUrl.searchParams.set('key', String(profile.secrets?.apiKey || '').trim())
      const response = await fetch(probeUrl, { method: 'GET', signal: AbortSignal.timeout(8_000) })
      if (!response.ok) {
        return { ok: false, serviceId: profile.id, message: `HTTP ${response.status}`, latencyMs: Date.now() - start }
      }
      const payload = await response.json() as { status?: string; info?: string; infocode?: string }
      const ok = payload.status === '1'
      return {
        ok,
        serviceId: profile.id,
        message: ok ? '连接正常' : `高德返回 ${payload.infocode || 'unknown'}：${payload.info || '请求失败'}`,
        latencyMs: Date.now() - start,
      }
    }
    if (profile.kind === 'rsshub' || profile.kind === 'duckduckgo' || profile.kind === 'jina') {
      const baseUrl = trimBaseUrl(profile.baseUrl)
      if (!baseUrl) return { ok: false, serviceId: profile.id, message: '缺少服务地址' }
      const probeUrl = profile.kind === 'jina'
        ? `${baseUrl}/https://example.com`
        : profile.kind === 'duckduckgo'
          ? `${baseUrl}/html/?q=ready`
          : baseUrl
      const response = await fetch(probeUrl, { method: 'GET', signal: AbortSignal.timeout(8_000) })
      return {
        ok: response.ok,
        serviceId: profile.id,
        message: response.ok ? '连接正常' : `HTTP ${response.status}`,
        latencyMs: Date.now() - start,
      }
    }
    return { ok: true, serviceId: profile.id, message: '配置已就绪', latencyMs: Date.now() - start }
  }
}

let bootCredentialMigration: Promise<void> | null = null

export function migrateExternalServiceCredentialsAfterWindowReady(): Promise<void> {
  if (!bootCredentialMigration) {
    bootCredentialMigration = new ExternalServiceStore()
      .migrateStoredCredentialsOnce()
      .then(() => undefined)
      .catch((error) => {
        logAgentMetric('settings.credential_migration_failed', {
          errorKind: error instanceof Error ? error.name : typeof error,
        })
      })
  }
  return bootCredentialMigration
}
