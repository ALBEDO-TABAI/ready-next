import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Globe2, Save, UserSquare2 } from 'lucide-react'
import {
  SETTINGS_BADGE_STYLE,
  SETTINGS_CARD_STYLE,
  SETTINGS_FIELD_HINT_STYLE,
  SETTINGS_FIELD_LABEL_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_MUTED_CARD_STYLE,
  SETTINGS_PLAIN_SECTION_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_SECTION_LEAD_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
  SETTINGS_TITLE_STYLE,
  settingsNoticeStyle,
} from '../settings/settings-theme'

interface UserProfile {
  id: string
  name?: string
  avatarUrl?: string
  preferredLanguage: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

type UserProfilePayload = {
  id?: string
  name?: string
  preferredLanguage?: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
}

type UserProfileAPIWithPreferences = {
  get: (userId: string) => Promise<{ success: boolean; data?: UserProfile | null; error?: string }>
  create: (profile: UserProfilePayload) => Promise<{ success: boolean; data?: UserProfile; error?: string }>
  update: (userId: string, updates: UserProfilePayload) => Promise<{ success: boolean; error?: string }>
}

const DEFAULT_USER_ID = 'default-user'

const languageOptions = [
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
]

const communicationStyles = [
  { value: '', label: '默认风格', description: '使用系统默认的沟通方式' },
  { value: 'concise', label: '简洁直接', description: '先结论，减少铺垫' },
  { value: 'detailed', label: '详细解释', description: '适合复杂任务和交接说明' },
  { value: 'friendly', label: '友好协作', description: '更温和、更鼓励式的表达' },
  { value: 'professional', label: '专业正式', description: '适合业务、汇报和规范场景' },
  { value: 'technical', label: '技术导向', description: '优先工程细节和实现边界' },
]

function styleLabel(value?: string): string {
  return communicationStyles.find((item) => item.value === (value || ''))?.label || '默认风格'
}

function getProfileAPI(): UserProfileAPIWithPreferences {
  return window.electronAPI.userProfile as unknown as UserProfileAPIWithPreferences
}

function getLongTermPreferences(profile: UserProfile | null): string {
  const value = profile?.preferencesJson?.longTermPreferences
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join('\n')
  }
  return value == null ? '' : String(value)
}

export default function UserProfileEditor() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [name, setName] = useState('')
  const [preferredLanguage, setPreferredLanguage] = useState('zh')
  const [communicationStyle, setCommunicationStyle] = useState('')
  const [longTermPreferences, setLongTermPreferences] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    void loadProfile()

  }, [])

  const loadProfile = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getProfileAPI().get(DEFAULT_USER_ID)
      if (!result.success) {
        throw new Error(result.error || '读取默认档案失败')
      }
      const nextProfile = result.data || null
      setProfile(nextProfile)
      setName(nextProfile?.name || '')
      setPreferredLanguage(nextProfile?.preferredLanguage || 'zh')
      setCommunicationStyle(nextProfile?.communicationStyle || '')
      setLongTermPreferences(getLongTermPreferences(nextProfile))
    } catch (err) {
      setError(`读取用户档案失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSuccessMessage(null)

    try {
      const latest = await getProfileAPI().get(DEFAULT_USER_ID)
      if (!latest.success) {
        throw new Error(latest.error || '保存前读取默认档案失败')
      }

      const preferencesJson = {
        ...(latest.data?.preferencesJson || {}),
      }
      const nextLongTermPreferences = longTermPreferences.trim()
      if (nextLongTermPreferences) {
        preferencesJson.longTermPreferences = nextLongTermPreferences
      } else {
        delete preferencesJson.longTermPreferences
      }

      const payload: UserProfilePayload = {
        name: name.trim(),
        preferredLanguage,
        communicationStyle,
        preferencesJson,
      }

      const result = latest.data
        ? await getProfileAPI().update(DEFAULT_USER_ID, payload)
        : await getProfileAPI().create({
          id: DEFAULT_USER_ID,
          ...payload,
        })

      if (!result.success) {
        throw new Error(result.error || '保存默认档案失败')
      }

      setSuccessMessage('我的偏好已保存。')
      await loadProfile()
    } catch (err) {
      setError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 h-full">
      <div
        className="flex items-start justify-between gap-4"
        style={{
          ...SETTINGS_MUTED_CARD_STYLE,
          padding: '20px 22px',
        }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span
              style={{
                ...SETTINGS_BADGE_STYLE,
                background: 'var(--color-blue-light)',
                color: 'var(--color-blue)',
              }}
            >
              <UserSquare2 className="w-3.5 h-3.5" />
              USER.md
            </span>
            <span
              style={{
                ...SETTINGS_BADGE_STYLE,
                background: 'color-mix(in srgb, var(--surface-card-bg) 80%, var(--bg-canvas) 20%)',
                color: 'var(--text-muted)',
              }}
            >
              本机默认档案
            </span>
          </div>
          <div>
            <div style={SETTINGS_TITLE_STYLE}>我的偏好</div>
            <div style={{ ...SETTINGS_SECTION_LEAD_STYLE, marginTop: 6, maxWidth: 620 }}>
              保存昵称、语言、回复风格和长期偏好，让 Ready 在本机默认档案下保持一致的协作方式。
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div style={settingsNoticeStyle('error')} className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span className="text-[12px]">{error}</span>
        </div>
      )}

      {successMessage && (
        <div style={settingsNoticeStyle('success')} className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          <span className="text-[12px]">{successMessage}</span>
        </div>
      )}

      <div
        className="flex flex-col gap-5 min-w-0"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '20px',
        }}
      >
        <div
          className="grid gap-4"
          style={{
            ...SETTINGS_PLAIN_SECTION_STYLE,
            padding: '0 0 4px',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          }}
        >
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="flex items-center gap-2">
              <Globe2 className="w-4 h-4" style={{ color: 'var(--color-blue)' }} />
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
                偏好设置
              </div>
            </div>
            <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6 }}>
              这份偏好固定保存到本机默认档案，不再提供多用户切换。
            </div>
          </div>

          <div>
            <div style={SETTINGS_FIELD_LABEL_STYLE}>昵称</div>
            <input
              aria-label="昵称"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：Maijiahui"
              style={SETTINGS_INPUT_STYLE}
            />
          </div>

          <div>
            <div style={SETTINGS_FIELD_LABEL_STYLE}>语言</div>
            <select
              aria-label="语言"
              value={preferredLanguage}
              onChange={(event) => setPreferredLanguage(event.target.value)}
              style={SETTINGS_INPUT_STYLE}
            >
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <div style={SETTINGS_FIELD_LABEL_STYLE}>回复风格</div>
            <select
              aria-label="回复风格"
              value={communicationStyle}
              onChange={(event) => setCommunicationStyle(event.target.value)}
              style={SETTINGS_INPUT_STYLE}
            >
              {communicationStyles.map((option) => (
                <option key={option.value || 'default'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6 }}>
              {communicationStyles.find((item) => item.value === communicationStyle)?.description || communicationStyles[0].description}
            </div>
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <div style={SETTINGS_FIELD_LABEL_STYLE}>长期偏好</div>
            <textarea
              aria-label="长期偏好"
              value={longTermPreferences}
              onChange={(event) => setLongTermPreferences(event.target.value)}
              placeholder="例如：先给结论；涉及实现时保留关键证据；中文回复。"
              style={{
                ...SETTINGS_INPUT_STYLE,
                minHeight: 132,
                lineHeight: 1.6,
                resize: 'vertical',
              }}
            />
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-4"
          style={{
            ...SETTINGS_SUBTLE_CARD_STYLE,
            padding: '14px 16px',
          }}
        >
          <div className="flex items-center gap-2">
            <span
              style={{
                ...SETTINGS_BADGE_STYLE,
                background: 'var(--color-blue-light)',
                color: 'var(--color-blue)',
              }}
            >
              {styleLabel(communicationStyle)}
            </span>
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {profile ? '已加载默认档案' : '保存后创建默认档案'}
            </span>
          </div>
          <span className="text-[12px]" style={{ color: 'var(--text-light)' }}>
            default-user
          </span>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="inline-flex items-center gap-2 hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
            style={SETTINGS_PRIMARY_BUTTON_STYLE}
          >
            <Save className="w-4 h-4" />
            {saving ? '保存中...' : '保存偏好'}
          </button>
        </div>
      </div>
    </div>
  )
}
