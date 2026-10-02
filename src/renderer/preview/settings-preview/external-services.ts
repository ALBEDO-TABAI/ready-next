// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
import {
  DEFAULT_EXTERNAL_SERVICE_PROFILES,
  type ExternalServiceUpdateInput,
  type PublicExternalServiceProfile,
} from '../../../shared/external-services'

const CONFIGURED_IDS = new Set(['anysearch-default', 'jina-default', 'amap-default', 'gpt-image-default'])
const ENABLED_IDS = new Set(['anysearch-default', 'duckduckgo-default', 'jina-default', 'amap-default', 'gpt-image-default'])

let profiles: PublicExternalServiceProfile[] = DEFAULT_EXTERNAL_SERVICE_PROFILES.map((profile) => ({
  id: profile.id,
  kind: profile.kind,
  name: profile.name,
  enabled: ENABLED_IDS.has(profile.id),
  baseUrl: profile.kind === 'image-generation' && profile.id === 'gpt-image-default' ? 'https://api.openai.com/v1' : profile.baseUrl,
  options: { ...(profile.options || {}) },
  secretStatus: Object.fromEntries(Object.keys(profile.secrets || {}).map((key) => [
    key,
    CONFIGURED_IDS.has(profile.id)
      ? { configured: true, state: 'ready' as const, masked: '••••8f2c' }
      : { configured: false, state: 'missing' as const },
  ])),
  updatedAt: CONFIGURED_IDS.has(profile.id) ? new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString() : undefined,
}))

function applyUpdate(input: ExternalServiceUpdateInput): PublicExternalServiceProfile | undefined {
  profiles = profiles.map((profile) => profile.id === input.id
    ? {
        ...profile,
        enabled: input.enabled ?? profile.enabled,
        baseUrl: input.baseUrl ?? profile.baseUrl,
        options: { ...profile.options, ...(input.options || {}) },
        updatedAt: new Date().toISOString(),
      }
    : profile)
  return profiles.find((profile) => profile.id === input.id)
}

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  settings: {
    listExternalServices: async () => ({ success: true, data: profiles }),
    updateExternalService: async (input: ExternalServiceUpdateInput) => ({ success: true, data: applyUpdate(input) }),
    resetExternalService: async (input: { id: string }) => ({ success: true, data: profiles.find((profile) => profile.id === input.id) }),
    testExternalServiceDraft: async (input: ExternalServiceUpdateInput) => ({
      success: true,
      data: { ok: true, serviceId: input.id, message: '连接正常', latencyMs: 182 },
    }),
  },
}
