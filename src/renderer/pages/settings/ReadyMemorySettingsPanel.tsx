import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  AlertCircle,
  Clock3,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'

import type {
  ReadyMemoryCategory,
  ReadyMemoryEntryView,
  ReadyMemoryView,
} from '../../../shared/ready-memory'
import { useAgent } from '../../stores/useAgent'
import {
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_FLAT_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
  settingsNoticeStyle,
} from '../../components/settings/settings-theme'

const CATEGORY_OPTIONS: Array<{ value: ReadyMemoryCategory; label: string }> = [
  { value: 'preference', label: '偏好' },
  { value: 'fact', label: '事实' },
  { value: 'project', label: '项目' },
  { value: 'workflow', label: '工作方式' },
  { value: 'other', label: '其他' },
]

const CATEGORY_LABELS = Object.fromEntries(
  CATEGORY_OPTIONS.map((item) => [item.value, item.label]),
) as Record<ReadyMemoryCategory, string>

const DIVIDER = '1px solid color-mix(in srgb, var(--surface-border) 20%, transparent)'

function MemorySwitch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-[background-color,border-color,filter,opacity] hover:brightness-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-blue)]/30"
      style={{
        borderColor: checked
          ? 'color-mix(in srgb, var(--color-blue) 42%, transparent)'
          : 'color-mix(in srgb, var(--surface-border) 68%, transparent)',
        background: checked
          ? 'color-mix(in srgb, var(--color-blue) 78%, var(--surface-floating-bg) 22%)'
          : 'color-mix(in srgb, var(--surface-floating-bg) 72%, var(--bg-content) 28%)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span
        aria-hidden="true"
        className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(3px)' }}
      />
    </button>
  )
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

function isExpired(entry: ReadyMemoryEntryView): boolean {
  if (entry.status === 'expired') return true
  return entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= Date.now()
}

function PolicyRow({
  title,
  description,
  control,
}: {
  title: string
  description: string
  control: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>{title}</div>
        <div className="mt-1 max-w-[620px] text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>
          {description}
        </div>
      </div>
      {control}
    </div>
  )
}

export function ReadyMemorySettingsPanel() {
  const currentScopeId = useAgent((state) => state.currentScopeId)
  const [view, setView] = useState<ReadyMemoryView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
  const [category, setCategory] = useState<ReadyMemoryCategory>('preference')
  const [content, setContent] = useState('')
  const [pinNewEntry, setPinNewEntry] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const api = window.electronAPI?.agent
      if (!api?.readReadyMemory) {
        setView(null)
        setError('长期记忆暂时不可用')
        return
      }
      const result = await api.readReadyMemory(currentScopeId ? { conversationId: currentScopeId } : {})
      if (!result.success || !result.data) {
        setView(null)
        setError(result.error || '读取长期记忆失败')
        return
      }
      setView(result.data)
    } catch (caught) {
      setView(null)
      setError(caught instanceof Error ? caught.message : '读取长期记忆失败')
    } finally {
      setLoading(false)
    }
  }, [currentScopeId])

  useEffect(() => {
    void load()
  }, [load])

  const applyResult = useCallback(async (
    key: string,
    action: () => Promise<{ success: boolean; data?: ReadyMemoryView; error?: string }>,
    successMessage?: string,
  ): Promise<boolean> => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      if (!result.success || !result.data) {
        setError(result.error || '保存长期记忆失败')
        return false
      }
      let nextView = result.data
      const refreshed = await window.electronAPI.agent.readReadyMemory(
        currentScopeId ? { conversationId: currentScopeId } : {},
      )
      if (refreshed.success && refreshed.data) nextView = refreshed.data
      else setError(refreshed.error || '已保存，但刷新当前对话的记忆设置失败')
      setView(nextView)
      if (successMessage) setNotice(successMessage)
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存长期记忆失败')
      return false
    } finally {
      setBusy(null)
    }
  }, [currentScopeId])

  const changeUsePolicy = useCallback(async (checked: boolean) => {
    await applyResult('use-policy', () => (
      window.electronAPI.agent.setReadyMemoryGlobalPolicy({ useMemories: checked })
    ))
  }, [applyResult])

  const changeGeneratePolicy = useCallback(async (checked: boolean) => {
    if (checked) {
      const confirmed = window.confirm(
        '自动整理会在 Ready 空闲时调用你当前使用的模型，因此可能产生模型费用。\n\n确认开启吗？',
      )
      if (!confirmed) return
    }
    await applyResult('generate-policy', () => (
      window.electronAPI.agent.setReadyMemoryGlobalPolicy({
        generateMemories: checked,
        ...(checked ? { acknowledgeModelCost: true } : {}),
      })
    ))
  }, [applyResult])

  const changeConversationPolicy = useCallback(async (checked: boolean) => {
    if (!currentScopeId) return
    await applyResult('conversation-policy', () => (
      window.electronAPI.agent.setReadyMemoryConversationPolicy({
        conversationId: currentScopeId,
        contributeToMemories: checked,
      })
    ))
  }, [applyResult, currentScopeId])

  const resetEditor = useCallback(() => {
    setEditingEntryId(null)
    setCategory('preference')
    setContent('')
    setPinNewEntry(false)
  }, [])

  const submitEntry = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = content.trim()
    if (!trimmed) {
      setError('请写下要记住的内容')
      return
    }
    const saved = editingEntryId
      ? await applyResult('save-entry', () => (
        window.electronAPI.agent.updateReadyMemory({
          entryId: editingEntryId,
          category,
          content: trimmed,
        })
      ), '已更新这条记忆')
      : await applyResult('save-entry', () => (
        window.electronAPI.agent.addReadyMemory({
          category,
          content: trimmed,
          pinned: pinNewEntry,
        })
      ), '已添加到长期记忆')
    if (saved) resetEditor()
  }, [applyResult, category, content, editingEntryId, pinNewEntry, resetEditor])

  const beginEdit = useCallback((entry: ReadyMemoryEntryView) => {
    setEditingEntryId(entry.entryId)
    setCategory(entry.category)
    setContent(entry.content)
    setPinNewEntry(false)
    setError(null)
    setNotice(null)
  }, [])

  const togglePin = useCallback(async (entry: ReadyMemoryEntryView) => {
    await applyResult(`pin:${entry.entryId}`, () => (
      window.electronAPI.agent.pinReadyMemory({ entryId: entry.entryId, pinned: !entry.pinned })
    ))
  }, [applyResult])

  const deleteEntry = useCallback(async (entry: ReadyMemoryEntryView) => {
    if (!window.confirm('删除这条长期记忆吗？')) return
    const deleted = await applyResult(`delete:${entry.entryId}`, () => (
      window.electronAPI.agent.deleteReadyMemory({ entryId: entry.entryId })
    ), '已删除这条记忆')
    if (deleted && editingEntryId === entry.entryId) resetEditor()
  }, [applyResult, editingEntryId, resetEditor])

  const resetAll = useCallback(async () => {
    const confirmed = window.confirm(
      '确认让 Ready 忘记全部长期记忆吗？\n\n这不会删除聊天记录，但这些记忆无法恢复。',
    )
    if (!confirmed) return
    const reset = await applyResult('reset', () => (
      window.electronAPI.agent.resetReadyMemory({ confirm: true })
    ), '已忘记全部长期记忆')
    if (reset) resetEditor()
  }, [applyResult, resetEditor])

  if (loading) {
    return (
      <div className="flex items-center gap-3 px-1 py-5" role="status">
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--color-blue)' }} />
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取长期记忆…</span>
      </div>
    )
  }

  if (!view) {
    return (
      <div className="flex items-start gap-3 rounded-xl px-4 py-3" style={settingsNoticeStyle('error')} role="alert">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="text-[13px] font-semibold">暂时无法打开长期记忆</div>
          <div className="mt-1 text-[12px]">{error || '请稍后重试'}</div>
          <button type="button" onClick={() => void load()} className="mt-3" style={SETTINGS_FLAT_BUTTON_STYLE}>
            重试
          </button>
        </div>
      </div>
    )
  }

  const operationBusy = busy !== null

  return (
    <div className="flex w-full max-w-[860px] flex-col gap-7">
      <section aria-labelledby="ready-memory-policy-title">
        <div className="flex items-end justify-between gap-5 border-b pb-3" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 24%, transparent)' }}>
          <div>
            <h3 id="ready-memory-policy-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
              记忆方式
            </h3>
            <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>
              你可以随时查看、修改或删除 Ready 记住的内容。
            </p>
          </div>
          <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-light)' }}>
            {view.entries.length} 条记忆
          </span>
        </div>
        <div style={{ borderBottom: DIVIDER }}>
          <PolicyRow
            title="使用长期记忆"
            description="新对话会带上与当前任务相关的已保存内容。关闭后不会删除已有记忆。"
            control={(
              <MemorySwitch
                label="使用长期记忆"
                checked={view.useMemories}
                disabled={operationBusy}
                onChange={(checked) => void changeUsePolicy(checked)}
              />
            )}
          />
        </div>
        <div style={{ borderBottom: DIVIDER }}>
          <PolicyRow
            title="自动整理"
            description={view.automaticGenerationAvailable
              ? '在空闲时从你允许的对话中整理可长期复用的内容。开启后可能产生模型费用。'
              : '当前模型通道无法安全找回中断的整理请求，因此暂不开放；手动记忆可正常使用。'}
            control={(
              <MemorySwitch
                label="自动整理长期记忆"
                checked={view.generateMemories}
                disabled={operationBusy || !view.automaticGenerationAvailable}
                onChange={(checked) => void changeGeneratePolicy(checked)}
              />
            )}
          />
        </div>
        {(view.pendingGenerationJobs > 0 || view.unresolvedGenerationJobs > 0) && (
          <div className="border-b py-3 text-[11px] leading-5" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 20%, transparent)', color: 'var(--text-light)' }}>
            {view.pendingGenerationJobs > 0 && `正在处理 ${view.pendingGenerationJobs} 项整理。`}
            {view.pendingGenerationJobs > 0 && view.unresolvedGenerationJobs > 0 && ' '}
            {view.unresolvedGenerationJobs > 0 && `另有 ${view.unresolvedGenerationJobs} 项只会查询原请求结果，不会重新提交。`}
          </div>
        )}
        <PolicyRow
          title="当前对话可用于整理"
          description={currentScopeId && view.contributeToMemories !== null
            ? '只控制当前本地对话是否可为自动整理提供内容。'
            : currentScopeId
              ? '远程、临时或已关闭的对话不会进入长期记忆整理。'
            : '先打开一个本地对话，再设置这个对话是否可用于整理。'}
          control={currentScopeId && view.contributeToMemories !== null ? (
            <MemorySwitch
              label="允许当前对话用于整理"
              checked={view.contributeToMemories === true}
              disabled={operationBusy}
              onChange={(checked) => void changeConversationPolicy(checked)}
            />
          ) : (
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-light)' }}>
              {currentScopeId ? '当前对话不支持' : '未打开对话'}
            </span>
          )}
        />
      </section>

      {(error || notice) && (
        <div role={error ? 'alert' : 'status'} style={settingsNoticeStyle(error ? 'error' : 'success')}>
          {error || notice}
        </div>
      )}

      <section aria-labelledby="ready-memory-editor-title">
        <div className="mb-3 flex items-center gap-2">
          {editingEntryId ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          <h3 id="ready-memory-editor-title" className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
            {editingEntryId ? '修改记忆' : '手动添加'}
          </h3>
        </div>
        <form onSubmit={(event) => void submitEntry(event)} className="rounded-2xl p-4" style={SETTINGS_SUBTLE_CARD_STYLE}>
          <div className="grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
            <label className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
              类型
              <select
                aria-label="记忆类型"
                value={category}
                onChange={(event) => setCategory(event.target.value as ReadyMemoryCategory)}
                disabled={operationBusy}
                className="mt-1.5"
                style={SETTINGS_FLAT_INPUT_STYLE}
              >
                {CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
              内容
              <textarea
                aria-label="记忆内容"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                disabled={operationBusy}
                maxLength={16_000}
                rows={3}
                placeholder="例如：我喜欢简洁、直接的中文回答。"
                className="mt-1.5 resize-y"
                style={SETTINGS_FLAT_INPUT_STYLE}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            {!editingEntryId ? (
              <label className="inline-flex cursor-pointer items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <input
                  type="checkbox"
                  checked={pinNewEntry}
                  onChange={(event) => setPinNewEntry(event.target.checked)}
                  disabled={operationBusy}
                />
                添加后固定
              </label>
            ) : <span />}
            <div className="flex items-center gap-2">
              {editingEntryId && (
                <button type="button" onClick={resetEditor} disabled={operationBusy} style={SETTINGS_FLAT_BUTTON_STYLE}>取消</button>
              )}
              <button
                type="submit"
                disabled={operationBusy || content.trim().length === 0}
                style={{ ...SETTINGS_PRIMARY_BUTTON_STYLE, opacity: operationBusy || !content.trim() ? 0.55 : 1 }}
              >
                {busy === 'save-entry' ? '保存中…' : editingEntryId ? '保存修改' : '添加记忆'}
              </button>
            </div>
          </div>
        </form>
      </section>

      <section aria-labelledby="ready-memory-list-title">
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <h3 id="ready-memory-list-title" className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>已记住的内容</h3>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-light)' }}>固定的内容会优先保留。</p>
          </div>
          <button
            type="button"
            onClick={() => void resetAll()}
            disabled={operationBusy || view.entries.length === 0}
            style={{ ...SETTINGS_DANGER_BUTTON_STYLE, opacity: operationBusy || view.entries.length === 0 ? 0.48 : 1 }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            全部忘记
          </button>
        </div>

        {view.entries.length === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl px-4 py-5" style={SETTINGS_SUBTLE_CARD_STYLE}>
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--color-blue)' }} />
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>还没有长期记忆</div>
              <div className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>
                {view.automaticGenerationAvailable
                  ? '你可以手动添加一条，或在确认费用后开启自动整理。'
                  : '你可以先手动添加；自动整理暂未开放。'}
              </div>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl" style={SETTINGS_SUBTLE_CARD_STYLE}>
            {view.entries.map((entry, index) => {
              const expired = isExpired(entry)
              const timestamp = entry.lastUsedAt
                ? `最后使用 ${formatTime(entry.lastUsedAt)}`
                : `更新于 ${formatTime(entry.updatedAt)}`
              return (
                <article
                  key={entry.entryId}
                  className="px-4 py-4"
                  style={{ borderTop: index === 0 ? 'none' : DIVIDER, opacity: expired ? 0.66 : 1 }}
                >
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold">
                        <span className="rounded-full px-2 py-0.5" style={{ background: 'color-mix(in srgb, var(--color-blue-light) 58%, transparent)', color: 'var(--color-blue)' }}>
                          {CATEGORY_LABELS[entry.category]}
                        </span>
                        <span style={{ color: 'var(--text-light)' }}>
                          {entry.origin === 'manual' ? '手动添加' : '自动整理'}
                        </span>
                        {entry.pinned && <span style={{ color: 'var(--color-orange)' }}>已固定</span>}
                        {expired && <span style={{ color: 'var(--color-red)' }}>已过期</span>}
                        {!expired && entry.status === 'superseded' && <span style={{ color: 'var(--text-light)' }}>已替代</span>}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6" style={{ color: 'var(--text-body)' }}>
                        {entry.content}
                      </p>
                      <div className="mt-2 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-light)' }}>
                        <Clock3 className="h-3 w-3" />
                        {timestamp}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-light)' }}>
                        来源：{entry.sourceRefs.length > 0
                          ? `${entry.sourceRefs.length} 段已完成对话${entry.origin === 'manual' ? '（已手动修改）' : ''}`
                          : '手动添加'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        data-memory-action="pin"
                        aria-label={`${entry.pinned ? '取消固定' : '固定'}：${entry.content}`}
                        title={entry.pinned ? '取消固定' : '固定'}
                        disabled={operationBusy}
                        onClick={() => void togglePin(entry)}
                        className="rounded-lg p-2 hover:bg-[var(--bg-hover)]"
                        style={{ color: entry.pinned ? 'var(--color-orange)' : 'var(--text-muted)' }}
                      >
                        {entry.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        data-memory-action="edit"
                        aria-label={`编辑：${entry.content}`}
                        title="编辑"
                        disabled={operationBusy}
                        onClick={() => beginEdit(entry)}
                        className="rounded-lg p-2 hover:bg-[var(--bg-hover)]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        data-memory-action="delete"
                        aria-label={`删除：${entry.content}`}
                        title="删除"
                        disabled={operationBusy}
                        onClick={() => void deleteEntry(entry)}
                        className="rounded-lg p-2 hover:bg-[var(--bg-hover)]"
                        style={{ color: 'var(--color-red)' }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
