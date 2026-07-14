export type ExternalServiceKind =
  | 'tavily'
  | 'anysearch'
  | 'duckduckgo'
  | 'jina'
  | 'rsshub'
  | 'bilibili'
  | 'github'
  | 'amap'
  | 'vision-model'

export type ExternalServiceOptionValue = string | number | boolean | string[] | null

export interface ExternalServiceSecretStatus {
  configured: boolean
  masked?: string
}

export interface ExternalServiceProfile {
  id: string
  kind: ExternalServiceKind
  name: string
  enabled: boolean
  baseUrl?: string
  options?: Record<string, ExternalServiceOptionValue>
  secrets?: Record<string, string>
  updatedAt?: string
}

export interface PublicExternalServiceProfile {
  id: string
  kind: ExternalServiceKind
  name: string
  enabled: boolean
  baseUrl?: string
  options: Record<string, ExternalServiceOptionValue>
  secretStatus: Record<string, ExternalServiceSecretStatus>
  updatedAt?: string
}

export interface ExternalServiceUpdateInput {
  id: string
  kind?: ExternalServiceKind
  name?: string
  enabled?: boolean
  baseUrl?: string
  options?: Record<string, ExternalServiceOptionValue>
  secrets?: Record<string, string>
  clearSecrets?: string[]
}

export interface ExternalServiceTestResult {
  ok: boolean
  serviceId: string
  message: string
  latencyMs?: number
}

export interface RuntimeExternalServiceConfig {
  id: string
  kind: ExternalServiceKind
  enabled: boolean
  baseUrl?: string
  options: Record<string, ExternalServiceOptionValue>
  secrets: Record<string, string>
}

export const DEFAULT_EXTERNAL_SERVICE_PROFILES: ExternalServiceProfile[] = [
  {
    id: 'tavily-default',
    kind: 'tavily',
    name: 'Tavily Search',
    enabled: false,
    baseUrl: 'https://api.tavily.com',
    secrets: { apiKey: '' },
    options: {},
  },
  {
    id: 'anysearch-default',
    kind: 'anysearch',
    name: 'AnySearch',
    enabled: false,
    baseUrl: 'https://api.anysearch.com/mcp',
    secrets: { apiKey: '' },
    options: {},
  },
  {
    id: 'duckduckgo-default',
    kind: 'duckduckgo',
    name: 'DuckDuckGo HTML',
    enabled: true,
    baseUrl: 'https://html.duckduckgo.com',
    secrets: {},
    options: {},
  },
  {
    id: 'jina-default',
    kind: 'jina',
    name: 'Jina Reader',
    enabled: true,
    baseUrl: 'https://r.jina.ai',
    secrets: { apiKey: '' },
    options: {},
  },
  {
    id: 'rsshub-default',
    kind: 'rsshub',
    name: 'RSSHub',
    enabled: false,
    baseUrl: 'http://localhost:1200',
    secrets: {},
    options: {},
  },
  {
    id: 'bilibili-default',
    kind: 'bilibili',
    name: 'Bilibili 登录态',
    enabled: false,
    secrets: { sessdata: '', biliJct: '' },
    options: { cookieFile: '' },
  },
  {
    id: 'github-default',
    kind: 'github',
    name: 'GitHub',
    enabled: false,
    baseUrl: 'https://api.github.com',
    secrets: { token: '' },
    options: {},
  },
  {
    id: 'amap-default',
    kind: 'amap',
    name: '高德地图',
    enabled: false,
    baseUrl: 'https://restapi.amap.com',
    secrets: { apiKey: '' },
    options: {},
  },
  {
    id: 'vision-model-default',
    kind: 'vision-model',
    name: 'VEA 读图模型',
    enabled: false,
    baseUrl: '',
    secrets: { apiKey: '' },
    options: {
      provider: 'openai-compatible',
      model: '',
      apiKind: 'openai-completions',
      inputModes: ['text', 'image'],
    },
  },
]

export const EXTERNAL_SERVICE_KIND_LABELS: Record<ExternalServiceKind, string> = {
  tavily: 'Tavily',
  anysearch: 'AnySearch',
  duckduckgo: 'DuckDuckGo',
  jina: 'Jina',
  rsshub: 'RSSHub',
  bilibili: 'Bilibili',
  github: 'GitHub',
  amap: '高德地图',
  'vision-model': '读图模型',
}

export function defaultExternalServiceProfile(id: string): ExternalServiceProfile | null {
  return DEFAULT_EXTERNAL_SERVICE_PROFILES.find((profile) => profile.id === id) ?? null
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeOptionValue(value: unknown): ExternalServiceOptionValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return undefined
}

function normalizeOptions(value: unknown): Record<string, ExternalServiceOptionValue> {
  const input = asObject(value)
  const output: Record<string, ExternalServiceOptionValue> = {}
  for (const [key, raw] of Object.entries(input)) {
    const normalized = normalizeOptionValue(raw)
    if (normalized !== undefined) output[key] = normalized
  }
  return output
}

function normalizeSecrets(value: unknown): Record<string, string> {
  const input = asObject(value)
  const output: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input)) {
    output[key] = typeof raw === 'string' ? raw : ''
  }
  return output
}

export function normalizeExternalServiceProfile(raw: unknown, fallback?: ExternalServiceProfile): ExternalServiceProfile | null {
  const input = asObject(raw)
  const id = String(input.id || fallback?.id || '').trim()
  const kind = String(input.kind || fallback?.kind || '').trim() as ExternalServiceKind
  if (!id || !Object.prototype.hasOwnProperty.call(EXTERNAL_SERVICE_KIND_LABELS, kind)) return null
  const defaultName = fallback?.name || EXTERNAL_SERVICE_KIND_LABELS[kind]
  return {
    id,
    kind,
    name: String(input.name || defaultName).trim() || defaultName,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : Boolean(fallback?.enabled),
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : fallback?.baseUrl,
    options: { ...(fallback?.options || {}), ...normalizeOptions(input.options) },
    secrets: { ...(fallback?.secrets || {}), ...normalizeSecrets(input.secrets) },
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : fallback?.updatedAt,
  }
}

export function normalizeExternalServiceProfiles(raw: unknown): ExternalServiceProfile[] {
  const inputProfiles = Array.isArray(raw) ? raw : []
  const byId = new Map<string, unknown>()
  for (const rawProfile of inputProfiles) {
    const id = String(asObject(rawProfile).id || '').trim()
    if (id) byId.set(id, rawProfile)
  }

  const normalized = DEFAULT_EXTERNAL_SERVICE_PROFILES.map((fallback) => (
    normalizeExternalServiceProfile(byId.get(fallback.id), fallback) || { ...fallback }
  ))

  for (const rawProfile of inputProfiles) {
    const id = String(asObject(rawProfile).id || '').trim()
    if (!id || DEFAULT_EXTERNAL_SERVICE_PROFILES.some((profile) => profile.id === id)) continue
    const custom = normalizeExternalServiceProfile(rawProfile)
    if (custom) normalized.push(custom)
  }

  return normalized
}

export function maskExternalSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 4) return '••••'
  return `••••${value.slice(-4)}`
}

export function toPublicExternalServiceProfile(profile: ExternalServiceProfile): PublicExternalServiceProfile {
  const secretStatus: Record<string, ExternalServiceSecretStatus> = {}
  for (const [key, value] of Object.entries(profile.secrets || {})) {
    secretStatus[key] = {
      configured: Boolean(value),
      masked: value ? maskExternalSecret(value) : undefined,
    }
  }
  return {
    id: profile.id,
    kind: profile.kind,
    name: profile.name,
    enabled: profile.enabled,
    baseUrl: profile.baseUrl,
    options: { ...(profile.options || {}) },
    secretStatus,
    updatedAt: profile.updatedAt,
  }
}

export function toRuntimeExternalServiceConfig(profile: ExternalServiceProfile): RuntimeExternalServiceConfig {
  return {
    id: profile.id,
    kind: profile.kind,
    enabled: profile.enabled,
    baseUrl: profile.baseUrl,
    options: { ...(profile.options || {}) },
    secrets: { ...(profile.secrets || {}) },
  }
}
