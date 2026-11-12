import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  Check,
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
import { Button, Checkbox, IconButton, Select, Switch, Textarea } from '../../components/ui'
import {
  SettingsCard,
  SettingsNotice,
  SettingsRow,
} from './settings-shared'

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
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--rn-ink-2)' }} />
        <span className="text-[12px]" style={{ color: 'var(--rn-ink-2)' }}>正在读取长期记忆…</span>
      </div>
    )
  }

  if (!view) {
    return (
      <SettingsNotice
        tone="danger"
        title="暂时无法打开长期记忆"
        action={(
          <Button size="sm" onClick={() => void load()}>
            重试
          </Button>
        )}
      >
        {error || '请稍后重试'}
      </SettingsNotice>
    )
  }

  const operationBusy = busy !== null
  const generationJobsHint = (view.pendingGenerationJobs > 0 || view.unresolvedGenerationJobs > 0) ? (
    <span className="sx-meta mt-1 flex items-center gap-1.5">
      {view.pendingGenerationJobs > 0 && <Loader2 className="h-3 w-3 animate-spin" />}
      <span>
        {view.pendingGenerationJobs > 0 && `正在处理 ${view.pendingGenerationJobs} 项整理。`}
        {view.pendingGenerationJobs > 0 && view.unresolvedGenerationJobs > 0 && ' '}
        {view.unresolvedGenerationJobs > 0 && `另有 ${view.unresolvedGenerationJobs} 项只会查询原请求结果，不会重新提交。`}
      </span>
    </span>
  ) : null

  return (
    <div className="sx-stack w-full">
      <SettingsCard
        aria-labelledby="ready-memory-policy-title"
        title={<span id="ready-memory-policy-title">记忆方式</span>}
        description="你可以随时查看、修改或删除 Ready 记住的内容。"
        actions={<span className="sx-badge">{view.entries.length} 条记忆</span>}
      >
        <SettingsRow
          label="使用长期记忆"
          description="新对话会带上与当前任务相关的已保存内容。关闭后不会删除已有记忆。"
        >
          <Switch
            label="使用长期记忆"
            checked={view.useMemories}
            disabled={operationBusy}
            onChange={(checked) => void changeUsePolicy(checked)}
          />
        </SettingsRow>
        <SettingsRow
          label="自动整理"
          description={(
            <>
              {view.automaticGenerationAvailable
                ? '在空闲时从你允许的对话中整理可长期复用的内容。开启后可能产生模型费用。'
                : '当前模型通道无法安全找回中断的整理请求，因此暂不开放；手动记忆可正常使用。'}
              {generationJobsHint}
            </>
          )}
        >
          <Switch
            label="自动整理长期记忆"
            checked={view.generateMemories}
            disabled={operationBusy || !view.automaticGenerationAvailable}
            onChange={(checked) => void changeGeneratePolicy(checked)}
          />
        </SettingsRow>
        <SettingsRow
          label="当前对话可用于整理"
          description={currentScopeId && view.contributeToMemories !== null
            ? '只控制当前本地对话是否可为自动整理提供内容。'
            : currentScopeId
              ? '远程、临时或已关闭的对话不会进入长期记忆整理。'
            : '先打开一个本地对话，再设置这个对话是否可用于整理。'}
        >
          {currentScopeId && view.contributeToMemories !== null ? (
            <Switch
              label="允许当前对话用于整理"
              checked={view.contributeToMemories === true}
              disabled={operationBusy}
              onChange={(checked) => void changeConversationPolicy(checked)}
            />
          ) : (
            <span className="sx-badge">
              {currentScopeId ? '当前对话不支持' : '未打开对话'}
            </span>
          )}
        </SettingsRow>
      </SettingsCard>

      {(error || notice) && (
        error
          ? <SettingsNotice tone="danger">{error}</SettingsNotice>
          : <SettingsNotice tone="plain" icon={Check}>{notice}</SettingsNotice>
      )}

      <SettingsCard
        aria-labelledby="ready-memory-editor-title"
        title={(
          <span id="ready-memory-editor-title" className="inline-flex items-center gap-2">
            {editingEntryId
              ? <Pencil className="h-3.5 w-3.5" style={{ color: 'var(--rn-ink-2)' }} />
              : <Plus className="h-3.5 w-3.5" style={{ color: 'var(--rn-ink-2)' }} />}
            {editingEntryId ? '修改记忆' : '手动添加'}
          </span>
        )}
      >
        <form onSubmit={(event) => void submitEntry(event)}>
          <div className="sx-card__body grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label className="sx-field">
              <span className="sx-field__label">类型</span>
              <Select
                aria-label="记忆类型"
                value={category}
                onChange={(event) => setCategory(event.target.value as ReadyMemoryCategory)}
                disabled={operationBusy}
                options={CATEGORY_OPTIONS}
              />
            </label>
            <label className="sx-field">
              <span className="sx-field__label">内容</span>
              <Textarea
                aria-label="记忆内容"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                disabled={operationBusy}
                maxLength={16_000}
                rows={3}
                placeholder="例如：我喜欢简洁、直接的中文回答。"
              />
            </label>
          </div>
          <div className="sx-card__footer justify-between">
            {!editingEntryId ? (
              <span className="text-[12px]">
                <Checkbox
                  label="添加后固定"
                  checked={pinNewEntry}
                  onChange={setPinNewEntry}
                  disabled={operationBusy}
                />
              </span>
            ) : <span />}
            <div className="flex items-center gap-2">
              {editingEntryId && (
                <Button onClick={resetEditor} disabled={operationBusy}>取消</Button>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={operationBusy || content.trim().length === 0}
                aria-busy={busy === 'save-entry' ? true : undefined}
              >
                {busy === 'save-entry' ? '保存中…' : editingEntryId ? '保存修改' : '添加记忆'}
              </Button>
            </div>
          </div>
        </form>
      </SettingsCard>

      <SettingsCard
        aria-labelledby="ready-memory-list-title"
        title={<span id="ready-memory-list-title">已记住的内容</span>}
        description="固定的内容会优先保留。"
        actions={(
          <Button
            variant="danger"
            size="sm"
            onClick={() => void resetAll()}
            disabled={operationBusy || view.entries.length === 0}
            icon={<Trash2 />}
          >
            全部忘记
          </Button>
        )}
      >
        <div>
          {view.entries.length === 0 ? (
            <div className="flex items-start gap-3 px-6 py-6">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--rn-ink-2)' }} />
              <div>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--rn-ink)' }}>还没有长期记忆</div>
                <div className="mt-1 text-[12px] leading-5" style={{ color: 'var(--rn-ink-2)' }}>
                  {view.automaticGenerationAvailable
                    ? '你可以手动添加一条，或在确认费用后开启自动整理。'
                    : '你可以先手动添加；自动整理暂未开放。'}
                </div>
              </div>
            </div>
          ) : (
            view.entries.map((entry, index) => {
              const expired = isExpired(entry)
              const timestamp = entry.lastUsedAt
                ? `最后使用 ${formatTime(entry.lastUsedAt)}`
                : `更新于 ${formatTime(entry.updatedAt)}`
              return (
                <article
                  key={entry.entryId}
                  className="group/memory flex items-start gap-4 px-6 py-[18px] transition-colors hover:bg-[var(--rn-fill)]"
                  style={{
                    borderTop: index === 0 ? 'none' : '1px solid var(--rn-hair)',
                    opacity: expired ? 0.62 : 1,
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="sx-badge">{CATEGORY_LABELS[entry.category]}</span>
                      {entry.pinned && (
                        <span className="sx-badge sx-badge--ink">
                          <Pin />
                          已固定
                        </span>
                      )}
                      {expired && <span className="sx-badge sx-badge--warning">已过期</span>}
                      {!expired && entry.status === 'superseded' && <span className="sx-badge">已替代</span>}
                      <span className="sx-meta">
                        {entry.origin === 'manual' ? '手动添加' : '自动整理'}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6" style={{ color: 'var(--rn-ink)' }}>
                      {entry.content}
                    </p>
                    <div className="sx-meta mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock3 className="h-3 w-3" />
                        {timestamp}
                      </span>
                      <span>
                        来源：{entry.sourceRefs.length > 0
                          ? `${entry.sourceRefs.length} 段已完成对话${entry.origin === 'manual' ? '（已手动修改）' : ''}`
                          : '手动添加'}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton
                      icon={entry.pinned ? <PinOff /> : <Pin />}
                      data-memory-action="pin"
                      title={entry.pinned ? '取消固定' : '固定'}
                      aria-label={`${entry.pinned ? '取消固定' : '固定'}：${entry.content}`}
                      disabled={operationBusy}
                      onClick={() => void togglePin(entry)}
                      style={entry.pinned ? { color: 'var(--rn-ink)' } : undefined}
                    />
                    <IconButton
                      icon={<Pencil />}
                      data-memory-action="edit"
                      title="编辑"
                      aria-label={`编辑：${entry.content}`}
                      disabled={operationBusy}
                      onClick={() => beginEdit(entry)}
                    />
                    <IconButton
                      icon={<Trash2 />}
                      data-memory-action="delete"
                      title="删除"
                      aria-label={`删除：${entry.content}`}
                      disabled={operationBusy}
                      onClick={() => void deleteEntry(entry)}
                    />
                  </div>
                </article>
              )
            })
          )}
        </div>
      </SettingsCard>
    </div>
  )
}
