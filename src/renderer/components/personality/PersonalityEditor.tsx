import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Bot, CheckCircle2, Fingerprint, Plus, Save, Sparkles, Trash2, X } from 'lucide-react'
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
  SETTINGS_TEXTAREA_STYLE,
  SETTINGS_TITLE_STYLE,
  settingsListItemStyle,
  settingsNoticeStyle,
} from '../settings/settings-theme'
import { useAgent } from '../../stores/useAgent'

interface AgentPersonality {
  id: string
  agentName: string
  displayName?: string
  personalityText: string
  tone?: string
  metaJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

const toneOptions = [
  { value: '', label: '默认语气', description: '沿用系统默认的表达习惯' },
  { value: 'professional', label: '专业', description: '清晰、克制、强调结构和结论' },
  { value: 'friendly', label: '亲和', description: '更温和、更像协作伙伴' },
  { value: 'technical', label: '技术型', description: '优先精度、细节和工程判断' },
  { value: 'casual', label: '轻松', description: '更自然，更口语化' },
  { value: 'formal', label: '正式', description: '适合对外文案或规范场景' },
]

function toneLabel(value?: string): string {
  return toneOptions.find((item) => item.value === (value || ''))?.label || '默认语气'
}

function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase()
}

function isValidAgentName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value)
}

function resultError(result: { error?: string }, fallback: string): string {
  return result.error || fallback
}

function defaultPersonalityText(agentName: string, displayName: string): string {
  const title = displayName || agentName
  return [
    `# ${title}`,
    '',
    '你是 Ready 工作台中的一个可切换 Agent。',
    '请用清晰、稳定、符合当前人格定位的方式协助用户完成创作和分析任务。',
  ].join('\n')
}

function nextDraftAgentName(personalities: AgentPersonality[]): string {
  const base = 'designer'
  if (!personalities.some((item) => item.agentName === base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (!personalities.some((item) => item.agentName === candidate)) return candidate
  }
  return `designer-${Date.now()}`
}

export default function PersonalityEditor() {
  const [personalities, setPersonalities] = useState<AgentPersonality[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [draftAgentName, setDraftAgentName] = useState('')
  const [personalityText, setPersonalityText] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [tone, setTone] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    void loadPersonalities()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only loader; see Y1.3 sub-plan §3.1
  }, [])

  useEffect(() => {
    if (isCreating) return
    if (!selectedAgent) return
    void loadPersonality(selectedAgent)
  }, [isCreating, selectedAgent])

  const selectedPersonality = useMemo(
    () => isCreating ? null : personalities.find((item) => item.agentName === selectedAgent) || null,
    [isCreating, personalities, selectedAgent],
  )

  const loadPersonalities = async (preferredAgentName?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.agentPersonality.list()
      if (!result.success) {
        throw new Error(resultError(result, '后端没有返回成功状态'))
      }
      const next = result.data || []
      setPersonalities(next)
      const nextSelectedAgent = preferredAgentName && next.some((item) => item.agentName === preferredAgentName)
        ? preferredAgentName
        : selectedAgent && next.some((item) => item.agentName === selectedAgent)
          ? selectedAgent
          : next[0]?.agentName || null
      if (nextSelectedAgent !== selectedAgent) {
        setSelectedAgent(nextSelectedAgent)
      }
    } catch (err) {
      setError(`加载人格配置失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const loadPersonality = async (agentName: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.agentPersonality.get(agentName)
      if (!result.success) {
        throw new Error(resultError(result, '后端没有返回成功状态'))
      }
      const personality = result.data
      if (personality) {
        setPersonalityText(personality.personalityText)
        setDisplayName(personality.displayName || '')
        setTone(personality.tone || '')
      } else {
        setPersonalityText('')
        setDisplayName('')
        setTone('')
      }
    } catch (err) {
      setError(`读取人格配置失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  const refreshAgentSwitcher = async () => {
    await useAgent.getState().reloadAgents()
  }

  const handleSelectPersonality = (agentName: string) => {
    setIsCreating(false)
    setDraftAgentName('')
    setSelectedAgent(agentName)
    setSuccessMessage(null)
    setError(null)
  }

  const handleStartCreate = () => {
    const agentName = nextDraftAgentName(personalities)
    setIsCreating(true)
    setDraftAgentName(agentName)
    setSelectedAgent(null)
    setDisplayName(agentName)
    setTone('')
    setPersonalityText(defaultPersonalityText(agentName, agentName))
    setSuccessMessage(null)
    setError(null)
  }

  const handleCancelCreate = () => {
    setIsCreating(false)
    setDraftAgentName('')
    setPersonalityText('')
    setDisplayName('')
    setTone('')
    setSelectedAgent(personalities[0]?.agentName || null)
    setSuccessMessage(null)
    setError(null)
  }

  const handleSave = async () => {
    const agentName = isCreating ? normalizeAgentName(draftAgentName) : selectedAgent
    if (!agentName) return
    if (isCreating && !isValidAgentName(agentName)) {
      setError('Agent 标识只能使用小写字母、数字和连字符，并且必须以字母或数字开头。')
      return
    }
    if (isCreating && personalities.some((item) => item.agentName === agentName)) {
      setError(`Agent 标识 ${agentName} 已存在。`)
      return
    }
    if (!personalityText.trim()) {
      setError('请先填写人格定义，再保存。')
      return
    }

    setSaving(true)
    setError(null)
    setSuccessMessage(null)

    try {
      const existingResult: { success: boolean; data?: AgentPersonality | null; error?: string } = isCreating
        ? { success: true, data: null as AgentPersonality | null }
        : await window.electronAPI.agentPersonality.get(agentName)
      if (!existingResult.success) {
        throw new Error(resultError(existingResult, '读取当前人格失败'))
      }
      const existing = existingResult.data

      let result: { success: boolean; error?: string }
      if (existing) {
        result = await window.electronAPI.agentPersonality.update(agentName, {
          personalityText,
          displayName: displayName || undefined,
          tone: tone || undefined,
        })
      } else {
        result = await window.electronAPI.agentPersonality.create({
          agentName,
          personalityText,
          displayName: displayName || agentName,
          tone: tone || undefined,
          metaJson: { emoji: '🤖' },
        })
      }
      if (!result.success) {
        throw new Error(resultError(result, '后端保存失败'))
      }

      setSuccessMessage('人格配置已保存。')
      setIsCreating(false)
      setDraftAgentName('')
      setSelectedAgent(agentName)
      await loadPersonalities(agentName)
      await refreshAgentSwitcher()
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (err) {
      setError(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (isCreating) {
      handleCancelCreate()
      return
    }
    if (!selectedAgent) return
    if (!confirm(`确定删除 ${selectedAgent} 的人格配置吗？`)) {
      return
    }

    setSaving(true)
    setError(null)

    try {
      const result = await window.electronAPI.agentPersonality.delete(selectedAgent)
      if (!result.success) {
        throw new Error(resultError(result, '后端删除失败'))
      }
      setSuccessMessage('人格配置已删除。')
      setPersonalityText('')
      setDisplayName('')
      setTone('')
      setSelectedAgent(null)
      await loadPersonalities()
      await refreshAgentSwitcher()
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (err) {
      setError(`删除失败：${err instanceof Error ? err.message : String(err)}`)
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
              <Sparkles className="w-3.5 h-3.5" />
              SOUL.md
            </span>
            <span
              style={{
                ...SETTINGS_BADGE_STYLE,
                background: 'color-mix(in srgb, var(--surface-card-bg) 80%, var(--bg-canvas) 20%)',
                color: 'var(--text-muted)',
              }}
            >
              {personalities.length} 个已配置 Agent
            </span>
          </div>
          <div>
            <div style={SETTINGS_TITLE_STYLE}>把人格配置成可复用的表达基调</div>
            <div style={{ ...SETTINGS_SECTION_LEAD_STYLE, marginTop: 6, maxWidth: 620 }}>
              人格定义会影响 Agent 的语气、判断偏好与协作方式。这里更适合写长期稳定的行为准则，而不是单次任务的即时说明。
            </div>
          </div>
        </div>
        <button
          onClick={handleStartCreate}
          disabled={loading || saving}
          className="inline-flex items-center gap-2 hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
          style={SETTINGS_PRIMARY_BUTTON_STYLE}
        >
          <Plus className="w-4 h-4" />
          新建人格
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
                Agent 列表
              </div>
              <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 4 }}>
                选择一个 Agent 继续编辑人格配置。
              </div>
            </div>
            <Bot className="w-4 h-4" style={{ color: 'var(--text-light)' }} />
          </div>

          <div className="flex flex-col gap-2">
            {personalities.map((personality) => {
              const isActive = selectedAgent === personality.agentName
              return (
                <button
                  key={personality.id}
                  onClick={() => handleSelectPersonality(personality.agentName)}
                  className="text-left transition-[transform,background-color,border-color] duration-200 hover:-translate-y-[1px]"
                  style={{ ...settingsListItemStyle(isActive), padding: '12px 10px' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div
                        className="text-[13px] font-semibold truncate"
                        style={{ color: isActive ? 'var(--color-blue)' : 'var(--text-title)' }}
                      >
                        {personality.displayName || personality.agentName}
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {personality.agentName}
                      </div>
                    </div>
                    <span
                      style={{
                        ...SETTINGS_BADGE_STYLE,
                        background: isActive ? 'var(--color-blue)' : 'color-mix(in srgb, var(--surface-card-bg) 82%, var(--bg-canvas) 18%)',
                        color: isActive ? '#fff' : 'var(--text-muted)',
                      }}
                    >
                      {toneLabel(personality.tone)}
                    </span>
                  </div>
                  <div className="text-[11px] mt-3" style={{ color: 'var(--text-light)' }}>
                    更新于 {new Date(personality.updatedAt * 1000).toLocaleDateString()}
                  </div>
                </button>
              )
            })}

            {!loading && personalities.length === 0 && (
              <div
                className="flex items-center justify-center text-center"
                style={{
                  ...SETTINGS_SUBTLE_CARD_STYLE,
                  minHeight: 148,
                  padding: '20px 16px',
                  color: 'var(--text-muted)',
                }}
              >
                还没有任何人格配置。<br />点击右上角创建你的第一个 Agent 人格。
              </div>
            )}
          </div>
        </div>

        {selectedAgent || isCreating ? (
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
                  <Fingerprint className="w-4 h-4" style={{ color: 'var(--color-blue)' }} />
                  <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
                    基础信息
                  </div>
                </div>
                <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6 }}>
                  先定义这个 Agent 的识别名、展示名和整体语气，再决定人格正文如何展开。
                </div>
              </div>

              <div>
                <div style={SETTINGS_FIELD_LABEL_STYLE}>Agent 标识</div>
                <input
                  aria-label="Agent 标识"
                  value={isCreating ? draftAgentName : selectedAgent || ''}
                  disabled={!isCreating}
                  onChange={(event) => setDraftAgentName(normalizeAgentName(event.target.value))}
                  style={isCreating ? SETTINGS_INPUT_STYLE : SETTINGS_READONLY_STYLE}
                />
              </div>

              <div>
                <div style={SETTINGS_FIELD_LABEL_STYLE}>推荐语气</div>
                <select
                  aria-label="推荐语气"
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                  style={SETTINGS_INPUT_STYLE}
                >
                  {toneOptions.map((item) => (
                    <option key={item.value || 'default'} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6 }}>
                  {toneOptions.find((item) => item.value === tone)?.description || toneOptions[0].description}
                </div>
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <div style={SETTINGS_FIELD_LABEL_STYLE}>展示名称</div>
                <input
                  aria-label="展示名称"
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="例如：设计审稿师 / Browser Planner"
                  style={SETTINGS_INPUT_STYLE}
                />
              </div>
            </div>

            <div
              className="flex flex-col gap-4"
              style={{
                ...SETTINGS_PLAIN_SECTION_STYLE,
                padding: '4px 0 0',
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
                    人格定义
                  </div>
                  <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6, maxWidth: 620 }}>
                    写清楚表达风格、判断优先级、协作边界与常见偏好。内容越稳定、越抽象，这份人格就越容易在不同任务中保持一致。
                  </div>
                </div>
                <span
                  style={{
                    ...SETTINGS_BADGE_STYLE,
                    background: 'color-mix(in srgb, var(--surface-card-bg) 82%, var(--bg-canvas) 18%)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {personalityText.length} 字符
                </span>
              </div>

              <textarea
                aria-label="人格定义"
                value={personalityText}
                onChange={(event) => setPersonalityText(event.target.value)}
                placeholder="例如：你是一个极其挑剔但有品味的设计审稿师，先判断整体层级是否成立，再检查留白、比例、字重、信息密度是否统一……"
                style={SETTINGS_TEXTAREA_STYLE}
              />

              {selectedPersonality && (
                <div
                  className="flex items-center justify-between gap-3"
                  style={{
                    ...SETTINGS_SUBTLE_CARD_STYLE,
                    padding: '12px 14px',
                  }}
                >
                  <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    当前人格已存在，最近更新于 {new Date(selectedPersonality.updatedAt * 1000).toLocaleString()}
                  </div>
                  <span
                    style={{
                      ...SETTINGS_BADGE_STYLE,
                      background: 'var(--color-green-light)',
                      color: 'var(--color-green)',
                    }}
                  >
                    已保存配置
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={handleSave}
                disabled={saving || loading || !personalityText.trim()}
                className="inline-flex items-center gap-2 hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                style={SETTINGS_PRIMARY_BUTTON_STYLE}
              >
                <Save className="w-4 h-4" />
                {saving ? '保存中...' : '保存人格'}
              </button>
              <button
                onClick={handleDelete}
                disabled={saving || loading}
                className="inline-flex items-center gap-2 hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                style={isCreating ? SETTINGS_SECONDARY_BUTTON_STYLE : SETTINGS_DANGER_BUTTON_STYLE}
              >
                {isCreating ? <X className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                {isCreating ? '取消新建' : '删除'}
              </button>
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
                borderRadius: 12,
                background: 'var(--color-blue-light)',
                color: 'var(--color-blue)',
              }}
            >
              <Bot className="w-5 h-5" />
            </div>
            <div className="text-[15px] font-semibold mt-4" style={{ color: 'var(--text-title)' }}>
              选择一个 Agent 开始编辑
            </div>
            <div style={{ ...SETTINGS_SECTION_LEAD_STYLE, marginTop: 8, maxWidth: 420 }}>
              左侧可以切换已有人格，或者新建一个 Agent。保存之后，这份人格会持续影响它在聊天和执行任务时的语气与行为。
            </div>
            <button
              onClick={handleStartCreate}
              disabled={loading || saving}
              style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, marginTop: 18 }}
              className="hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
            >
              新建人格
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
