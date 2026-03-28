import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Globe2, Plus, Save, Trash2, UserRound, UserSquare2 } from 'lucide-react'
import {
  SETTINGS_BADGE_STYLE,
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_FIELD_HINT_STYLE,
  SETTINGS_FIELD_LABEL_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_MUTED_CARD_STYLE,
  SETTINGS_PLAIN_SECTION_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_READONLY_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SECTION_LEAD_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
  SETTINGS_TITLE_STYLE,
  settingsListItemStyle,
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

export default function UserProfileEditor() {
  const [profiles, setProfiles] = useState<UserProfile[]>([])
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [preferredLanguage, setPreferredLanguage] = useState('zh')
  const [communicationStyle, setCommunicationStyle] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    void loadProfiles()
  }, [])

  useEffect(() => {
    if (!selectedUser) return
    void loadProfile(selectedUser)
  }, [selectedUser])

  const selectedProfile = useMemo(
    () => profiles.find((item) => item.id === selectedUser) || null,
    [profiles, selectedUser],
  )

  const loadProfiles = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.userProfile.list()
      const next = result.data || []
      setProfiles(next)
      if (next.length > 0 && !selectedUser) {
        setSelectedUser(next[0].id)
      }
    } catch (err) {
      setError(`加载用户档案失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const loadProfile = async (userId: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.userProfile.get(userId)
      const profile = result.data
      if (profile) {
        setName(profile.name || '')
        setAvatarUrl(profile.avatarUrl || '')
        setPreferredLanguage(profile.preferredLanguage)
        setCommunicationStyle(profile.communicationStyle || '')
      }
    } catch (err) {
      setError(`读取用户档案失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!selectedUser) return

    setSaving(true)
    setError(null)
    setSuccessMessage(null)

    try {
      await window.electronAPI.userProfile.update(selectedUser, {
        name: name || undefined,
        avatarUrl: avatarUrl || undefined,
        preferredLanguage,
        communicationStyle: communicationStyle || undefined,
      })

      setSuccessMessage('用户档案已保存。')
      await loadProfiles()
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (err) {
      setError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedUser) return
    if (selectedUser === 'default-user') {
      setError('默认用户档案不可删除。')
      return
    }
    if (!confirm(`确定删除 ${name || selectedUser} 这个用户档案吗？`)) {
      return
    }

    setSaving(true)
    setError(null)

    try {
      await window.electronAPI.userProfile.delete(selectedUser)
      setSuccessMessage('用户档案已删除。')
      setName('')
      setAvatarUrl('')
      setPreferredLanguage('zh')
      setCommunicationStyle('')
      setSelectedUser(null)
      await loadProfiles()
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (err) {
      setError(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleCreateNew = () => {
    const userId = prompt('输入新的用户标识：', 'creator-mode')
    if (!userId) return

    setSelectedUser(userId)
    setName('')
    setAvatarUrl('')
    setPreferredLanguage('zh')
    setCommunicationStyle('')
    setSuccessMessage(null)
    setError(null)
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
              {profiles.length} 个档案
            </span>
          </div>
          <div>
            <div style={SETTINGS_TITLE_STYLE}>让不同用户上下文拥有自己的沟通偏好</div>
            <div style={{ ...SETTINGS_SECTION_LEAD_STYLE, marginTop: 6, maxWidth: 620 }}>
              用户档案适合保存语言、沟通方式、称呼习惯等长期偏好。Agent 在切换用户上下文时，可以据此调整回复方式与协作细节。
            </div>
          </div>
        </div>
        <button
          onClick={handleCreateNew}
          disabled={loading}
          className="inline-flex items-center gap-2 hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
          style={SETTINGS_PRIMARY_BUTTON_STYLE}
        >
          <Plus className="w-4 h-4" />
          新建用户
        </button>
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
        className="grid gap-5 items-start"
        style={{ gridTemplateColumns: '280px minmax(0, 1fr)' }}
      >
        <div
          className="flex flex-col gap-3"
          style={{
            ...SETTINGS_CARD_STYLE,
            padding: '18px 16px',
          }}
        >
          <div className="flex items-center justify-between gap-3 px-1">
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
                用户列表
              </div>
              <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 4 }}>
                选择一个用户上下文继续编辑偏好。
              </div>
            </div>
            <UserRound className="w-4 h-4" style={{ color: 'var(--text-light)' }} />
          </div>

          <div className="flex flex-col gap-2">
            {profiles.map((profile) => {
              const isActive = selectedUser === profile.id
              return (
                <button
                  key={profile.id}
                  onClick={() => setSelectedUser(profile.id)}
                  className="text-left transition-all hover:-translate-y-[1px]"
                  style={settingsListItemStyle(isActive)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div
                        className="text-[13px] font-semibold truncate"
                        style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-title)' }}
                      >
                        {profile.name || profile.id}
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {profile.id}
                      </div>
                    </div>
                    <span
                      style={{
                        ...SETTINGS_BADGE_STYLE,
                        background: isActive ? 'var(--color-blue)' : 'color-mix(in srgb, var(--surface-card-bg) 82%, var(--bg-canvas) 18%)',
                        color: isActive ? '#fff' : 'var(--text-muted)',
                      }}
                    >
                      {styleLabel(profile.communicationStyle)}
                    </span>
                  </div>
                  <div className="text-[11px] mt-3" style={{ color: 'var(--text-light)' }}>
                    更新于 {new Date(profile.updatedAt * 1000).toLocaleDateString()}
                  </div>
                </button>
              )
            })}

            {!loading && profiles.length === 0 && (
              <div
                className="flex items-center justify-center text-center"
                style={{
                  ...SETTINGS_SUBTLE_CARD_STYLE,
                  minHeight: 148,
                  padding: '20px 16px',
                  color: 'var(--text-muted)',
                }}
              >
                还没有任何用户档案。<br />点击右上角创建一个新的用户上下文。
              </div>
            )}
          </div>
        </div>

        {selectedUser ? (
          <div className="flex flex-col gap-5 min-w-0">
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
                    档案基础设置
                  </div>
                </div>
                <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6 }}>
                  为当前用户上下文定义显示名称、首选语言与整体沟通风格，方便 Agent 在不同语境下切换表达方式。
                </div>
              </div>

              <div>
                <div style={SETTINGS_FIELD_LABEL_STYLE}>用户标识</div>
                <input value={selectedUser} disabled style={SETTINGS_READONLY_STYLE} />
              </div>

              <div>
                <div style={SETTINGS_FIELD_LABEL_STYLE}>首选语言</div>
                <select
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

              <div>
                <div style={SETTINGS_FIELD_LABEL_STYLE}>显示名称</div>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：Maijiahui / 内容创作模式"
                  style={SETTINGS_INPUT_STYLE}
                />
              </div>

              <div>
                <div style={SETTINGS_FIELD_LABEL_STYLE}>沟通风格</div>
                <select
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
                <div style={SETTINGS_FIELD_LABEL_STYLE}>头像地址</div>
                <input
                  type="text"
                  value={avatarUrl}
                  onChange={(event) => setAvatarUrl(event.target.value)}
                  placeholder="https://example.com/avatar.jpg"
                  style={SETTINGS_INPUT_STYLE}
                />
                <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6 }}>
                  可选，用于在多用户场景中更快区分上下文。
                </div>
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
                  最近更新于 {selectedProfile ? new Date(selectedProfile.updatedAt * 1000).toLocaleString() : '刚刚'}
                </span>
              </div>
              <span className="text-[12px]" style={{ color: 'var(--text-light)' }}>
                创建于 {selectedProfile ? new Date(selectedProfile.createdAt * 1000).toLocaleDateString() : '刚刚'}
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
                {saving ? '保存中...' : '保存档案'}
              </button>
              {selectedUser !== 'default-user' && (
                <button
                  onClick={handleDelete}
                  disabled={saving || loading}
                  className="inline-flex items-center gap-2 hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                  style={SETTINGS_DANGER_BUTTON_STYLE}
                >
                  <Trash2 className="w-4 h-4" />
                  删除
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            className="flex flex-col items-center justify-center text-center"
            style={{
              ...SETTINGS_PLAIN_SECTION_STYLE,
              minHeight: 420,
              padding: '48px 24px',
            }}
          >
            <div
              className="flex items-center justify-center"
              style={{
                width: 52,
                height: 52,
                borderRadius: 18,
                background: 'var(--color-blue-light)',
                color: 'var(--color-blue)',
              }}
            >
              <UserRound className="w-5 h-5" />
            </div>
            <div className="text-[16px] font-semibold mt-4" style={{ color: 'var(--text-title)' }}>
              选择一个用户开始编辑
            </div>
            <div style={{ ...SETTINGS_SECTION_LEAD_STYLE, marginTop: 8, maxWidth: 420 }}>
              左侧可以切换已存在的用户档案。每个档案都能保存自己偏好的语言和沟通风格，方便 Agent 在不同协作对象之间切换。
            </div>
            <button
              onClick={handleCreateNew}
              style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, marginTop: 18 }}
              className="hover:brightness-95 active:scale-[0.98]"
            >
              新建用户
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
