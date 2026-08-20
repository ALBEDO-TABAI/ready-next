import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import type { ExternalServiceOptionValue, ExternalServiceUpdateInput, PublicExternalServiceProfile } from '../../../shared/external-services'
import { SETTINGS_FLAT_INPUT_STYLE } from '../../components/settings/settings-theme'

const EXTERNAL_SERVICE_SECRET_LABELS: Record<string, string> = {
  apiKey: 'API Key',
  token: 'Token',
  sessdata: 'SESSDATA',
  biliJct: 'bili_jct',
}

const EXTERNAL_SERVICE_DESCRIPTIONS: Partial<Record<PublicExternalServiceProfile['kind'], string>> = {
  anysearch: '供通用、垂直领域搜索与正文提取使用',
  tavily: '供网页研究使用',
  duckduckgo: '供备用搜索使用',
  jina: '供网页正文读取使用',
  rsshub: '供 RSS 订阅抓取使用',
  bilibili: '供视频分析技能使用',
  github: '供代码仓库操作使用',
  amap: '供路线规划 Agent 使用',
  'vision-model': '供视觉分析独立使用',
  'image-generation': '供 Agent 生成与编辑图片使用',
}

const EXTERNAL_SERVICE_GUIDES: Partial<Record<PublicExternalServiceProfile['kind'], {
  summary: string
  note: string
  links: Array<{ label: string; href: string }>
}>> = {
  anysearch: {
    summary: '适合通用搜索、网页正文提取，以及金融、学术、法律、健康等垂直领域。',
    note: 'Key 可选：无 Key 也可试用，配置后可获得更稳定的额度。',
    links: [
      { label: '获取 Key', href: 'https://anysearch.com/console/api-keys' },
      { label: '查看文档', href: 'https://www.anysearch.com/docs' },
    ],
  },
  tavily: {
    summary: '适合多轮网络调研与结果摘要，需要 API Key 后才能启用。',
    note: '在 Tavily 控制台注册并复制 API Key。',
    links: [
      { label: '获取 Key', href: 'https://app.tavily.com/home' },
      { label: '查看文档', href: 'https://docs.tavily.com/' },
    ],
  },
  jina: {
    summary: '适合把公开网页转成便于 Agent 阅读的干净正文。',
    note: 'Key 可选：不配置也可使用公共 Reader，配置后限额更明确。',
    links: [
      { label: '获取 Key', href: 'https://jina.ai/api-dashboard/' },
      { label: '查看文档', href: 'https://jina.ai/reader/' },
    ],
  },
  duckduckgo: {
    summary: '无需 Key 的基础搜索通道，适合在其他搜索服务不可用时继续查找公开资料。',
    note: '无需注册；保留默认服务地址即可。',
    links: [
      { label: '了解搜索结果', href: 'https://duckduckgo.com/duckduckgo-help-pages/results/' },
    ],
  },
}

type ExternalServiceFeedback = {
  kind: 'info' | 'success' | 'error'
  serviceId?: string
  text: string
}

function serviceSecretKeys(profile: PublicExternalServiceProfile): string[] {
  const keys = Object.keys(profile.secretStatus || {})
  if (keys.length > 0) return keys
  if (profile.kind === 'tavily' || profile.kind === 'anysearch' || profile.kind === 'jina' || profile.kind === 'vision-model' || profile.kind === 'image-generation') return ['apiKey']
  if (profile.kind === 'github') return ['token']
  if (profile.kind === 'bilibili') return ['sessdata', 'biliJct']
  return []
}

function serviceNeedsBaseUrl(profile: PublicExternalServiceProfile): boolean {
  return profile.kind !== 'bilibili'
}

function normalizeServiceOptionValue(value: unknown): ExternalServiceOptionValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return ''
}

function externalServiceDescription(profile: PublicExternalServiceProfile): string {
  return EXTERNAL_SERVICE_DESCRIPTIONS[profile.kind] || profile.kind
}

function buildExternalServicePayload(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  clearSecrets?: string[],
): ExternalServiceUpdateInput {
  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(secretDraft || {})) {
    if (value.trim()) secrets[key] = value.trim()
  }
  const payload: ExternalServiceUpdateInput = {
    id: profile.id,
    kind: profile.kind,
    name: profile.name,
    enabled: profile.enabled,
    baseUrl: profile.baseUrl,
    options: profile.options,
    secrets,
  }
  if (clearSecrets?.length) payload.clearSecrets = clearSecrets
  return payload
}

function externalServiceStatusStyle(enabled: boolean): CSSProperties {
  return {
    borderColor: enabled ? 'color-mix(in srgb, var(--color-green) 44%, transparent)' : 'color-mix(in srgb, var(--surface-border) 76%, transparent)',
    color: enabled ? 'var(--color-green)' : 'var(--text-muted)',
    background: 'transparent',
  }
}

function externalServiceStatusButtonStyle(enabled: boolean): CSSProperties {
  return {
    ...externalServiceStatusStyle(enabled),
    minWidth: 58,
    height: 24,
    padding: '0 8px',
  }
}

function externalServiceButtonStyle(variant: 'plain' | 'secondary' | 'primary', disabled: boolean): CSSProperties {
  if (variant === 'primary') {
    return {
      minWidth: 76,
      height: 38,
      padding: '0 15px',
      borderRadius: 12,
      border: '1px solid color-mix(in srgb, var(--color-blue) 72%, transparent)',
      background: 'color-mix(in srgb, var(--color-blue) 82%, var(--surface-card-bg) 18%)',
      color: '#fff',
      opacity: disabled ? 0.62 : 1,
      boxShadow: 'none',
    }
  }
  return {
    minWidth: variant === 'plain' ? 58 : 76,
    height: 38,
    padding: '0 13px',
    borderRadius: 12,
    border: variant === 'plain' ? '1px solid transparent' : '1px solid color-mix(in srgb, var(--surface-border) 70%, transparent)',
    // 不写 background，留给 hover 类（inline 透明背景会盖掉 :hover）。
    color: variant === 'plain' ? 'var(--text-muted)' : 'var(--text-body)',
    opacity: disabled ? 0.62 : 1,
    boxShadow: 'none',
  }
}

function externalServiceFeedbackStyle(kind: ExternalServiceFeedback['kind']): CSSProperties {
  return {
    color: kind === 'error' ? 'var(--color-red)' : kind === 'success' ? 'var(--color-green)' : 'var(--text-muted)',
    background: 'transparent',
  }
}

function externalServiceInputStyle(): CSSProperties {
  return {
    ...SETTINGS_FLAT_INPUT_STYLE,
    minHeight: 42,
    padding: '9px 11px',
    boxShadow: 'none',
  }
}

function externalServiceDraftSummary(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  clearSecrets: string[] = [],
): string {
  if (clearSecrets.length > 0) return `将清除 ${clearSecrets.length} 项密钥 · 保存后生效`
  const hasDraftSecret = Object.values(secretDraft || {}).some((value) => value.trim())
  if (hasDraftSecret) return '有未保存密钥 · 测试会使用当前输入 · 保存后生效'
  const secretKeys = serviceSecretKeys(profile)
  if (secretKeys.length === 0) return profile.enabled ? '服务已启用' : '服务未启用'
  if (secretKeys.some((key) => profile.secretStatus[key]?.state === 'vault_unavailable')) {
    return '本地凭据库暂不可用'
  }
  if (secretKeys.some((key) => profile.secretStatus[key]?.state === 'recovery_required')) {
    return '升级后无法读取原密钥，请重新填写'
  }
  const configured = secretKeys.filter((key) => profile.secretStatus[key]?.configured).length
  if (configured === secretKeys.length) return `已保存 ${configured} 项密钥`
  if (configured > 0) return `已保存 ${configured}/${secretKeys.length} 项密钥`
  return '密钥未配置'
}

function hasExternalServiceSecret(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  key: string,
  clearSecrets: string[] = [],
): boolean {
  if (clearSecrets.includes(key)) return Boolean(String(secretDraft?.[key] || '').trim())
  return Boolean(String(secretDraft?.[key] || '').trim()) || profile.secretStatus[key]?.configured === true
}

function requiredExternalServiceSecretKeys(profile: PublicExternalServiceProfile): string[] {
  if (profile.kind === 'tavily' || profile.kind === 'amap' || profile.kind === 'vision-model' || profile.kind === 'image-generation') return ['apiKey']
  if (profile.kind === 'github') return ['token']
  if (profile.kind === 'bilibili') return ['sessdata']
  return []
}

function externalServiceMissingRequirements(
  profile: PublicExternalServiceProfile,
  secretDraft: Record<string, string> | undefined,
  clearSecrets: string[] = [],
): string[] {
  const missing: string[] = []
  const baseUrl = String(profile.baseUrl || '').trim()
  if (serviceNeedsBaseUrl(profile) && !baseUrl) missing.push('服务地址')
  for (const key of requiredExternalServiceSecretKeys(profile)) {
    if (!hasExternalServiceSecret(profile, secretDraft, key, clearSecrets)) {
      missing.push(EXTERNAL_SERVICE_SECRET_LABELS[key] || key)
    }
  }
  if (profile.kind === 'vision-model') {
    if (!String(profile.options.model || '').trim()) missing.push('Model')
  }
  if (profile.kind === 'image-generation') {
    if (!String(profile.options.model || '').trim()) missing.push('模型名')
    const protocol = String(profile.options.protocol || '').trim()
    if (protocol !== 'openai-images' && protocol !== 'gemini-generate-content') missing.push('生图类型')
  }
  return missing
}

// Y1.1 §11.1: exported so the relabel behavior test can mount this panel in
// jsdom without instantiating the full Settings shell (mirrors Y0.8
// StorageSettingsPanel export precedent).
export function ExternalServicesSettingsPanel() {
  const [profiles, setProfiles] = useState<PublicExternalServiceProfile[]>([])
  const [secretDrafts, setSecretDrafts] = useState<Record<string, Record<string, string>>>({})
  const [secretClearRequests, setSecretClearRequests] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<ExternalServiceFeedback | null>(null)

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings?.listExternalServices) {
      setLoading(false)
      setFeedback({ kind: 'error', text: '外部服务 IPC 不可用' })
      return
    }
    setLoading(true)
    try {
      const res = await window.electronAPI.settings.listExternalServices()
      if (res.success && res.data) {
        setProfiles(res.data as PublicExternalServiceProfile[])
        setFeedback(null)
      } else {
        setFeedback({ kind: 'error', text: res.error || '读取外部服务配置失败' })
      }
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (profiles.length === 0) return
    setSelectedId((current) => {
      if (current && profiles.some((profile) => profile.id === current)) return current
      return profiles.find((profile) => profile.kind === 'amap')?.id || profiles[0]?.id || null
    })
  }, [profiles])

  const patchProfile = useCallback((id: string, patch: Partial<PublicExternalServiceProfile>) => {
    setProfiles((prev) => prev.map((profile) => profile.id === id ? { ...profile, ...patch } : profile))
    setFeedback({ kind: 'info', serviceId: id, text: '有未保存更改。测试会使用当前表单值，保存后才会生效。' })
  }, [])

  const patchOptions = useCallback((id: string, patch: Record<string, ExternalServiceOptionValue>) => {
    setProfiles((prev) => prev.map((profile) => (
      profile.id === id
        ? { ...profile, options: { ...(profile.options || {}), ...patch } }
        : profile
    )))
    setFeedback({ kind: 'info', serviceId: id, text: '有未保存更改。测试会使用当前表单值，保存后才会生效。' })
  }, [])

  const updateSecretDraft = useCallback((id: string, key: string, value: string) => {
    setSecretDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        [key]: value,
      },
    }))
    if (value.trim()) {
      setSecretClearRequests((prev) => ({
        ...prev,
        [id]: (prev[id] || []).filter((item) => item !== key),
      }))
    }
    setFeedback({ kind: 'info', serviceId: id, text: '有未保存更改。测试会使用当前表单值，保存后才会生效。' })
  }, [])

  const markSecretForClear = useCallback((id: string, key: string) => {
    setSecretDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        [key]: '',
      },
    }))
    setSecretClearRequests((prev) => ({
      ...prev,
      [id]: Array.from(new Set([...(prev[id] || []), key])),
    }))
    setFeedback({ kind: 'info', serviceId: id, text: '密钥已标记清除。测试会按清除后的表单值执行，保存后才会生效。' })
  }, [])

  const unmarkSecretForClear = useCallback((id: string, key: string) => {
    setSecretClearRequests((prev) => ({
      ...prev,
      [id]: (prev[id] || []).filter((item) => item !== key),
    }))
    setFeedback({ kind: 'info', serviceId: id, text: '密钥将继续保留。' })
  }, [])

  const toggleProfileEnabled = useCallback((profile: PublicExternalServiceProfile) => {
    setSelectedId(profile.id)
    if (!profile.enabled) {
      const missing = externalServiceMissingRequirements(profile, secretDrafts[profile.id], secretClearRequests[profile.id] || [])
      if (missing.length > 0) {
        const text = `请先完成配置：${missing.join('、')}。`
        setFeedback({
          kind: 'error',
          serviceId: profile.id,
          text,
        })
        window.alert(text)
        return
      }
    }
    patchProfile(profile.id, { enabled: !profile.enabled })
  }, [patchProfile, secretClearRequests, secretDrafts])

  const saveProfile = useCallback(async (profile: PublicExternalServiceProfile) => {
    if (!window.electronAPI?.settings?.updateExternalService) return
    setBusyId(profile.id)
    setFeedback({ kind: 'info', serviceId: profile.id, text: '正在保存配置...' })
    try {
      const res = await window.electronAPI.settings.updateExternalService(buildExternalServicePayload(profile, secretDrafts[profile.id], secretClearRequests[profile.id] || []))
      if (res.success && res.data) {
        setProfiles((prev) => prev.map((item) => item.id === profile.id ? res.data as PublicExternalServiceProfile : item))
        setSecretDrafts((prev) => ({ ...prev, [profile.id]: {} }))
        setSecretClearRequests((prev) => ({ ...prev, [profile.id]: [] }))
        setFeedback({ kind: 'success', serviceId: profile.id, text: `已保存：${profile.name}` })
      } else {
        setFeedback({ kind: 'error', serviceId: profile.id, text: res.error || `保存失败：${profile.name}` })
      }
    } catch (error) {
      setFeedback({ kind: 'error', serviceId: profile.id, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }, [secretClearRequests, secretDrafts])

  const resetProfile = useCallback(async (profile: PublicExternalServiceProfile) => {
    if (!window.electronAPI?.settings?.resetExternalService) return
    setBusyId(profile.id)
    setFeedback({ kind: 'info', serviceId: profile.id, text: '正在重置配置...' })
    try {
      const res = await window.electronAPI.settings.resetExternalService({ id: profile.id })
      if (res.success && res.data) {
        setProfiles((prev) => prev.map((item) => item.id === profile.id ? res.data as PublicExternalServiceProfile : item))
        setSecretDrafts((prev) => ({ ...prev, [profile.id]: {} }))
        setSecretClearRequests((prev) => ({ ...prev, [profile.id]: [] }))
        setFeedback({ kind: 'success', serviceId: profile.id, text: `已重置：${profile.name}` })
      } else {
        setFeedback({ kind: 'error', serviceId: profile.id, text: res.error || `重置失败：${profile.name}` })
      }
    } catch (error) {
      setFeedback({ kind: 'error', serviceId: profile.id, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }, [])

  const testProfile = useCallback(async (profile: PublicExternalServiceProfile) => {
    if (!window.electronAPI?.settings?.testExternalServiceDraft) return
    setTestingId(profile.id)
    setFeedback({
      kind: 'info',
      serviceId: profile.id,
      text: profile.kind === 'image-generation' ? '正在试生成一张测试图，完成后会立即丢弃...' : '正在测试当前表单配置...',
    })
    try {
      const res = await window.electronAPI.settings.testExternalServiceDraft(buildExternalServicePayload(profile, secretDrafts[profile.id], secretClearRequests[profile.id] || []))
      const detail = res.data?.latencyMs ? `（${res.data.latencyMs}ms）` : ''
      setFeedback({
        kind: res.success ? 'success' : 'error',
        serviceId: profile.id,
        text: res.success ? `${profile.name}：${res.data?.message || '连接正常'}${detail}` : `${profile.name}：${res.error || '测试失败'}`,
      })
    } catch (error) {
      setFeedback({ kind: 'error', serviceId: profile.id, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setTestingId(null)
    }
  }, [secretClearRequests, secretDrafts])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        加载外部服务配置...
      </div>
    )
  }

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) || profiles[0] || null
  const selectedSecretKeys = selectedProfile ? serviceSecretKeys(selectedProfile) : []
  const selectedFeedback = feedback && (!feedback.serviceId || feedback.serviceId === selectedProfile?.id) ? feedback : null
  const selectedDraft = selectedProfile ? secretDrafts[selectedProfile.id] : undefined
  const selectedClearSecrets = selectedProfile ? secretClearRequests[selectedProfile.id] || [] : []
  const isSelectedBusy = Boolean(selectedProfile && busyId === selectedProfile.id)
  const isSelectedTesting = Boolean(selectedProfile && testingId === selectedProfile.id)
  const selectedSummary = selectedProfile ? externalServiceDraftSummary(selectedProfile, selectedDraft, selectedClearSecrets) : ''
  const selectedGuide = selectedProfile ? EXTERNAL_SERVICE_GUIDES[selectedProfile.kind] : undefined
  // Y1.1 §11.1 honest-label path: vision-model "test" only field-validates in
  // main-process (`external-service-store.ts:342-344,390` — no HTTP probe).
  // Renderer relabels the button so the user sees what the system actually does.
  // Other kinds (amap / jina / rsshub / duckduckgo) DO probe and stay labeled `测试`.
  const isSelectedVisionModel = selectedProfile?.kind === 'vision-model'
  const isSelectedImageGeneration = selectedProfile?.kind === 'image-generation'
  const visionMissingRequirements = isSelectedVisionModel && selectedProfile
    ? externalServiceMissingRequirements(selectedProfile, selectedDraft, selectedClearSecrets)
    : []
  const isVisionTestDisabled = isSelectedVisionModel && visionMissingRequirements.length > 0
  const imageMissingRequirements = isSelectedImageGeneration && selectedProfile
    ? externalServiceMissingRequirements(selectedProfile, selectedDraft, selectedClearSecrets)
    : []
  const imageTestBlockers = isSelectedImageGeneration
    ? [
        selectedProfile?.enabled ? null : '请先启用服务',
        imageMissingRequirements.length > 0 ? `缺少：${imageMissingRequirements.join('、')}` : null,
      ].filter((item): item is string => Boolean(item))
    : []
  const isImageTestDisabled = imageTestBlockers.length > 0
  const navigationSections = [
    { label: '外部服务', profiles: profiles.filter((profile) => profile.kind !== 'image-generation') },
    { label: 'AI 生成服务', profiles: profiles.filter((profile) => profile.kind === 'image-generation') },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-5 xl:grid-cols-[260px_minmax(0,760px)]">
        <nav className="flex flex-col gap-1" aria-label="外部服务列表">
          {navigationSections.map((section, sectionIndex) => section.profiles.length > 0 ? (
            <div key={section.label} className={sectionIndex > 0 ? 'mt-4' : ''}>
              <div
                className="px-2 pb-1.5 text-[10px] font-semibold tracking-[0.12em]"
                style={{ color: sectionIndex > 0 ? 'var(--color-ready-orange)' : 'var(--text-light)' }}
              >
                {section.label}
              </div>
              <div className="flex flex-col gap-1">
              {section.profiles.map((profile) => {
            const active = profile.id === selectedProfile?.id
            const hovered = profile.id === hoveredId
            return (
              <div
                key={profile.id}
                onMouseEnter={() => setHoveredId(profile.id)}
                onMouseLeave={() => setHoveredId((current) => current === profile.id ? null : current)}
                className="w-full transition-[background-color,color] duration-150"
                style={{
                  padding: '10px 11px',
                  borderRadius: 12,
                  border: '1px solid transparent',
                  background: active
                    ? 'color-mix(in srgb, var(--color-blue) 8%, transparent)'
                    : hovered
                      ? 'color-mix(in srgb, var(--surface-card-bg) 48%, transparent)'
                      : 'transparent',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setSelectedId(profile.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
                      {profile.name}
                    </div>
                    <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
                      {externalServiceDescription(profile)}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleProfileEnabled(profile)}
                    className="inline-flex shrink-0 items-center justify-center rounded-[8px] border text-[11px] font-medium leading-none transition-[border-color,color,background-color] duration-150"
                    style={externalServiceStatusButtonStyle(profile.enabled)}
                  >
                    {profile.enabled ? '已启用' : '未启用'}
                  </button>
                </div>
              </div>
            )
              })}
              </div>
            </div>
          ) : null)}
        </nav>

        {selectedProfile && (
          <section
            className="self-start rounded-2xl border"
            style={{
              borderColor: 'color-mix(in srgb, var(--surface-border) 58%, transparent)',
              background: 'color-mix(in srgb, var(--surface-card-bg) 88%, var(--bg-content) 12%)',
              boxShadow: 'none',
              padding: '18px 20px 16px',
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--text-title)' }}>
                  {selectedProfile.name}
                </div>
                <div className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                  {externalServiceDescription(selectedProfile)}
                </div>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2 text-[11px] leading-5" style={{ color: 'var(--text-light)' }}>
              <span>{selectedSummary}</span>
              {selectedProfile.updatedAt ? <span>· 更新于 {new Date(selectedProfile.updatedAt).toLocaleString()}</span> : null}
            </div>

            {selectedGuide && (
              <div
                data-external-service-guide={selectedProfile.kind}
                className="mt-4 rounded-xl border px-3.5 py-3 text-[11px] leading-5"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-blue) 22%, var(--surface-border))',
                  background: 'color-mix(in srgb, var(--color-blue) 5%, transparent)',
                  color: 'var(--text-muted)',
                }}
              >
                <p>{selectedGuide.summary}</p>
                <p className="mt-1" style={{ color: 'var(--text-light)' }}>{selectedGuide.note}</p>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  {selectedGuide.links.map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                      style={{ color: 'var(--color-blue)' }}
                    >
                      {link.label} ↗
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex max-w-[640px] flex-col gap-3.5">
              {serviceNeedsBaseUrl(selectedProfile) && (
                <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  服务地址
                  <input
                    value={selectedProfile.baseUrl || ''}
                    onChange={(event) => patchProfile(selectedProfile.id, { baseUrl: event.target.value })}
                    style={externalServiceInputStyle()}
                    placeholder={selectedProfile.kind === 'vision-model' || selectedProfile.kind === 'image-generation' ? 'https://api.example.com' : 'https://...'}
                  />
                </label>
              )}

              {selectedProfile.kind === 'image-generation' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    生图类型
                    <select
                      value={String(selectedProfile.options.protocol || '')}
                      onChange={(event) => patchOptions(selectedProfile.id, { protocol: event.target.value })}
                      style={externalServiceInputStyle()}
                    >
                      <option value="openai-images">GPT Image</option>
                      <option value="gemini-generate-content">Gemini Image</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    模型名
                    <input
                      value={String(selectedProfile.options.model || '')}
                      onChange={(event) => patchOptions(selectedProfile.id, { model: event.target.value })}
                      style={externalServiceInputStyle()}
                      placeholder={selectedProfile.options.protocol === 'gemini-generate-content' ? 'gemini-3.1-flash-image' : 'gpt-image-2'}
                    />
                  </label>
                  {selectedProfile.options.protocol === 'openai-images' ? (
                    <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                      默认尺寸
                      <input
                        value={String(selectedProfile.options.size || '')}
                        onChange={(event) => patchOptions(selectedProfile.id, { size: event.target.value })}
                        style={externalServiceInputStyle()}
                        placeholder="1024x1024"
                      />
                    </label>
                  ) : (
                    <>
                      <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                        默认比例
                        <select
                          value={String(selectedProfile.options.aspectRatio || '1:1')}
                          onChange={(event) => patchOptions(selectedProfile.id, { aspectRatio: event.target.value })}
                          style={externalServiceInputStyle()}
                        >
                          <option value="1:1">1:1</option>
                          <option value="16:9">16:9</option>
                          <option value="9:16">9:16</option>
                          <option value="4:3">4:3</option>
                          <option value="3:4">3:4</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                        默认清晰度
                        <select
                          value={String(selectedProfile.options.imageSize || '1K')}
                          onChange={(event) => patchOptions(selectedProfile.id, { imageSize: event.target.value })}
                          style={externalServiceInputStyle()}
                        >
                          <option value="1K">1K</option>
                          <option value="2K">2K</option>
                          <option value="4K">4K</option>
                        </select>
                      </label>
                    </>
                  )}
                </div>
              )}

              {selectedProfile.kind === 'vision-model' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    Provider
                    <input
                      value={String(selectedProfile.options.provider || '')}
                      onChange={(event) => patchOptions(selectedProfile.id, { provider: event.target.value })}
                      style={externalServiceInputStyle()}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    Model
                    <input
                      value={String(selectedProfile.options.model || '')}
                      onChange={(event) => patchOptions(selectedProfile.id, { model: event.target.value })}
                      style={externalServiceInputStyle()}
                      placeholder="gpt-4o / qwen-vl..."
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    API 格式
                    <select
                      value={String(selectedProfile.options.apiKind || 'openai-completions')}
                      onChange={(event) => patchOptions(selectedProfile.id, { apiKind: event.target.value })}
                      style={externalServiceInputStyle()}
                    >
                      <option value="openai-completions">OpenAI Chat</option>
                      <option value="openai-responses">OpenAI Responses</option>
                      <option value="anthropic-messages">Anthropic Messages</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 self-end pb-2 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    <input
                      type="checkbox"
                      checked={Array.isArray(selectedProfile.options.inputModes) && selectedProfile.options.inputModes.includes('image')}
                      onChange={(event) => patchOptions(selectedProfile.id, { inputModes: event.target.checked ? ['text', 'image'] : ['text'] })}
                    />
                    支持图片输入
                  </label>
                </div>
              )}

              {selectedProfile.kind === 'bilibili' && (
                <label className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                  Cookie 文件路径（可选）
                  <input
                    value={String(normalizeServiceOptionValue(selectedProfile.options.cookieFile))}
                    onChange={(event) => patchOptions(selectedProfile.id, { cookieFile: event.target.value })}
                    style={externalServiceInputStyle()}
                    placeholder="/path/to/cookies.txt"
                  />
                </label>
              )}

              {selectedSecretKeys.map((key) => {
                const status = selectedProfile.secretStatus[key]
                const markedForClear = selectedClearSecrets.includes(key)
                return (
                  <label key={key} className="flex flex-col gap-1.5 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                    {EXTERNAL_SERVICE_SECRET_LABELS[key] || key}
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={secretDrafts[selectedProfile.id]?.[key] || ''}
                        onChange={(event) => updateSecretDraft(selectedProfile.id, key, event.target.value)}
                        style={{ ...externalServiceInputStyle(), flex: 1 }}
                        placeholder={markedForClear
                          ? '保存后清除；输入新值可替换'
                          : status?.state === 'recovery_required'
                            ? '升级后无法读取，请重新填写'
                            : status?.state === 'vault_unavailable'
                              ? '本地凭据库暂不可用'
                              : status?.configured
                                ? `已配置 ${status.masked || ''}，留空则保留`
                                : '未配置'}
                      />
                      {status?.configured ? (
                        <button
                          type="button"
                          data-external-secret-clear={`${selectedProfile.id}:${key}`}
                          onClick={() => markedForClear ? unmarkSecretForClear(selectedProfile.id, key) : markSecretForClear(selectedProfile.id, key)}
                          className="inline-flex items-center justify-center rounded-xl text-[12px] font-medium transition-[border-color,color,background-color,opacity] duration-150 enabled:hover:bg-[var(--bg-hover)]"
                          style={externalServiceButtonStyle('plain', isSelectedBusy || isSelectedTesting)}
                          disabled={isSelectedBusy || isSelectedTesting}
                        >
                          {markedForClear ? '保留' : '清除'}
                        </button>
                      ) : null}
                    </div>
                  </label>
                )
              })}

              <div className="min-h-5 text-[11px] leading-5" style={selectedFeedback ? externalServiceFeedbackStyle(selectedFeedback.kind) : { color: 'var(--text-light)' }}>
                {selectedFeedback ? (
                  <span className="inline-flex items-center gap-1.5">
                    {selectedFeedback.kind === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" /> : selectedFeedback.kind === 'error' ? <XCircle className="h-3.5 w-3.5" /> : null}
                    {selectedFeedback.text}
                  </span>
                ) : (
                  '测试不会保存配置；保存后 Agent 才会使用。'
                )}
              </div>

              {isSelectedVisionModel && (
                <div
                  data-vea-test-help
                  className="text-[11px] leading-5"
                  style={{ color: 'var(--text-light)' }}
                >
                  仅校验字段，不发起真实请求 / Validates fields only; no live request issued.
                  {visionMissingRequirements.length > 0 ? `（缺少：${visionMissingRequirements.join('、')}）` : ''}
                </div>
              )}

              {isSelectedImageGeneration && (
                <div data-image-generation-test-help className="text-[11px] leading-5" style={{ color: 'var(--text-light)' }}>
                  “试生成”会真实调用当前服务并产生一次费用；测试图不会保存。
                  同时启用两个服务时，聊天默认使用列表中第一个；也可以在需求里明确指定 GPT Image 或 Gemini Image。
                  {imageTestBlockers.length > 0 ? `（${imageTestBlockers.join('；')}）` : ''}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-0.5">
                <button
                  type="button"
                  onClick={() => { void resetProfile(selectedProfile) }}
                  disabled={isSelectedBusy || isSelectedTesting}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl text-[12px] font-medium transition-[border-color,color,background-color,opacity,filter] duration-150 enabled:hover:bg-[var(--bg-hover)]"
                  style={externalServiceButtonStyle('plain', isSelectedBusy || isSelectedTesting)}
                >
                  {isSelectedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {isSelectedBusy ? '重置中' : '重置'}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-vea-test-button={isSelectedVisionModel ? 'fields-only' : 'probe'}
                    onClick={() => { void testProfile(selectedProfile) }}
                    disabled={isSelectedTesting || isSelectedBusy || isVisionTestDisabled || isImageTestDisabled}
                    title={isSelectedVisionModel
                      ? '仅校验字段，不发起真实请求 / Validates fields only; no live request issued.'
                      : undefined}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl text-[12px] font-medium transition-[border-color,color,background-color,opacity,filter] duration-150 enabled:hover:bg-[var(--bg-hover)]"
                    style={externalServiceButtonStyle('secondary', isSelectedTesting || isSelectedBusy || isVisionTestDisabled || isImageTestDisabled)}
                  >
                    {isSelectedTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {isSelectedVisionModel
                      ? (isSelectedTesting ? '校验中' : '仅校验字段')
                      : isSelectedImageGeneration
                        ? (isSelectedTesting ? '生成中' : '试生成')
                        : (isSelectedTesting ? '测试中' : '测试')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void saveProfile(selectedProfile) }}
                    disabled={isSelectedBusy || isSelectedTesting}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl text-[12px] font-medium transition-[border-color,color,background-color,opacity,filter] duration-150 enabled:hover:brightness-95"
                    style={externalServiceButtonStyle('primary', isSelectedBusy || isSelectedTesting)}
                  >
                    {isSelectedBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {isSelectedBusy ? '保存中' : '保存'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
