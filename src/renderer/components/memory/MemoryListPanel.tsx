import { useState } from 'react'
import type { MemoryQueryFilters, MemoryEntry } from '../../types/electron'
import { Trash2, Layers, Tag, Clock, Eye } from 'lucide-react'
import { SETTINGS_INPUT_STYLE } from '../settings/settings-theme'

const fieldStyle = {
  ...SETTINGS_INPUT_STYLE
}

function memorySourceLabel(sourceType: MemoryEntry['sourceType'] | undefined): string {
  switch (sourceType) {
    case 'resident_agent':
      return 'Agent 主动记住'
    case 'resident_user':
      return '关于你的偏好'
    case 'scope_memory':
      return '来自任务'
    case 'trigger_rule':
      return '按需唤起'
    default:
      return '未分类'
  }
}

function memoryCategoryLabel(category: MemoryEntry['category'] | undefined): string {
  switch (category) {
    case 'summary':
      return '任务摘要'
    case 'learning':
      return '经验沉淀'
    case 'trigger':
      return '唤起线索'
    case 'rule':
      return '工作规则'
    case 'user_preference':
      return '用户偏好'
    case 'global_fact':
      return '长期事实'
    case 'personality_trait':
      return '协作习惯'
    default:
      return '未分类'
  }
}

function memoryLayerLabel(layer: MemoryEntry['layer'] | undefined): string {
  switch (layer) {
    case 'l0':
      return '长期保留'
    case 'l1':
      return '任务沉淀'
    case 'l2':
      return '按需唤起'
    default:
      return '未分类'
  }
}

function stringMeta(memory: MemoryEntry, keys: string[]): string | null {
  for (const key of keys) {
    const value = memory.meta?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function memoryOriginLabel(memory: MemoryEntry): string {
  if (memory.sourceType === 'scope_memory') {
    const taskName = stringMeta(memory, ['taskTitle', 'conversationTitle', 'scopeTitle', 'sourceTitle'])
    return taskName ? `来自任务：${taskName}` : '来自一次任务'
  }
  return memorySourceLabel(memory.sourceType)
}

interface MemoryListPanelProps {
  memories: MemoryEntry[]
  loading: boolean
  error: Error | null
  filters: MemoryQueryFilters
  onFiltersChange: (filters: MemoryQueryFilters) => void
  onDeleteMemory: (id: string) => Promise<void>
  showAdvancedDetails?: boolean
}

export default function MemoryListPanel({
  memories,
  loading,
  error,
  filters,
  onFiltersChange,
  onDeleteMemory,
  showAdvancedDetails = false
}: MemoryListPanelProps) {
  const [selectedMemory, setSelectedMemory] = useState<MemoryEntry | null>(null)

  const updateFilters = (updates: Partial<MemoryQueryFilters>) => {
    onFiltersChange({ ...filters, ...updates, offset: undefined })
  }

  const handleDelete = async (memory: MemoryEntry) => {
    if (confirm('确定要删除这条记忆吗？')) {
      try {
        await onDeleteMemory(memory.id)
        if (selectedMemory?.id === memory.id) setSelectedMemory(null)
      } catch (err) {
        alert(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[13px]" style={{ color: 'var(--color-red)' }}>
          错误: {error.message}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div
        className="border-b flex items-center gap-3 flex-wrap"
        style={{
          borderColor: 'var(--border-default)',
          padding: '16px 20px'
        }}
      >
        <select
          className="text-[13px] border rounded-lg transition-[box-shadow,border-color,background-color] duration-200"
          style={{
            ...fieldStyle,
            padding: '8px 12px'
          }}
          value={filters.sourceType || ''}
          onChange={(event) =>
            updateFilters({
              sourceType: (event.target.value as MemoryEntry['sourceType']) || undefined
            })
          }
        >
          <option value="">所有来源</option>
          <option value="resident_agent">Agent 主动记住</option>
          <option value="resident_user">关于你的偏好</option>
          <option value="scope_memory">来自任务</option>
          <option value="trigger_rule">按需唤起</option>
        </select>
        {showAdvancedDetails && (
          <select
            className="text-[13px] border rounded-lg transition-[box-shadow,border-color,background-color] duration-200"
            style={{
              ...fieldStyle,
              padding: '8px 12px'
            }}
            value={filters.layer || ''}
            onChange={(event) =>
              updateFilters({ layer: (event.target.value as MemoryEntry['layer']) || undefined })
            }
          >
            <option value="">所有层级</option>
            <option value="l0">L0 - 长期保留</option>
            <option value="l1">L1 - 任务沉淀</option>
            <option value="l2">L2 - 按需唤起</option>
          </select>
        )}
        <select
          className="text-[13px] border rounded-lg transition-[box-shadow,border-color,background-color] duration-200"
          style={{
            ...fieldStyle,
            padding: '8px 12px'
          }}
          value={filters.category || ''}
          onChange={(event) =>
            updateFilters({ category: (event.target.value as MemoryEntry['category']) || undefined })
          }
        >
          <option value="">所有类别</option>
          <option value="summary">任务摘要</option>
          <option value="learning">经验沉淀</option>
          <option value="trigger">唤起线索</option>
          <option value="rule">工作规则</option>
          <option value="user_preference">用户偏好</option>
          <option value="global_fact">长期事实</option>
          <option value="personality_trait">协作习惯</option>
        </select>
        <label
          className="flex items-center gap-2 text-[13px]"
          style={{ color: 'var(--text-body)' }}
        >
          <input
            type="checkbox"
            checked={filters.includeArchived || false}
            onChange={(event) => updateFilters({ includeArchived: event.target.checked })}
            className="rounded"
          />
          包含已归档
        </label>
      </div>

      <div className="flex-1 overflow-y-auto">
        {memories.length === 0 ? (
          <div
            className="flex items-center justify-center h-full text-[13px]"
            style={{ color: 'var(--text-muted)' }}
          >
            暂无记忆
          </div>
        ) : (
          <div style={{ padding: '12px' }}>
            {memories.map((memory) => (
              <div
                key={memory.id}
                data-selected={selectedMemory?.id === memory.id ? 'true' : 'false'}
                className="ready-memory-card mb-2 cursor-pointer transition-[background-color,color] duration-200"
                style={{
                  borderRadius: 12,
                  padding: '12px 14px',
                  ...(selectedMemory?.id === memory.id && {
                    background:
                      'color-mix(in srgb, var(--color-blue-light) 60%, transparent)'
                  })
                }}
                onClick={() => setSelectedMemory(memory)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      {showAdvancedDetails && (
                        <span
                          className="text-[11px] font-medium"
                          style={{ color: 'var(--color-blue)' }}
                        >
                          {memory.layer}
                        </span>
                      )}
                      <span
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--color-orange)' }}
                      >
                        {memoryOriginLabel(memory)}
                      </span>
                      <span
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--color-green)' }}
                      >
                        {memoryCategoryLabel(memory.category)}
                      </span>
                      <span
                        className="text-[11px] font-medium"
                        style={{ color: memory.archivedAt ? 'var(--text-muted)' : 'var(--color-blue)' }}
                      >
                        {memory.archivedAt ? '已归档' : '保留中'}
                      </span>
                    </div>
                    <div
                      className="text-[13px] font-medium mb-1"
                      style={{ color: 'var(--text-title)' }}
                    >
                      {memory.title}
                    </div>
                    {memory.summary && (
                      <div
                        className="text-[12px] line-clamp-2 mb-2"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {memory.summary}
                      </div>
                    )}
                    <div
                      className="flex items-center gap-4 text-[11px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {showAdvancedDetails && (
                        <>
                          <span className="flex items-center gap-1">
                            <Layers className="w-3 h-3" />
                            {memoryLayerLabel(memory.layer)}
                          </span>
                          <span className="flex items-center gap-1">
                            <Eye className="w-3 h-3" />
                            访问 {memory.accessCount} 次
                          </span>
                        </>
                      )}
                      {memory.lastAccessedAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(memory.lastAccessedAt * 1000).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleDelete(memory)
                    }}
                    className="shrink-0 p-1 rounded-md transition-colors duration-200 hover:bg-[var(--bg-hover)]"
                    aria-label="删除记忆"
                  >
                    <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--color-red)' }} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedMemory && (
        <div
          className="border-t"
          style={{
            borderColor: 'var(--border-default)',
            padding: '16px 20px',
            background: 'color-mix(in srgb, var(--surface-panel-bg) 48%, transparent)'
          }}
        >
          <div
            className="text-[11px] font-semibold uppercase tracking-wider mb-3"
            style={{ color: 'var(--text-light)' }}
          >
            {showAdvancedDetails ? '记忆详情' : '这条记忆'}
          </div>
          <div className="space-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {showAdvancedDetails ? (
              <>
                <div>ID: {selectedMemory.id}</div>
                <div>层级: {selectedMemory.layer}</div>
                <div>来源: {memorySourceLabel(selectedMemory.sourceType)}</div>
                <div>内容键: {selectedMemory.contentKey}</div>
                <div>作用域: {selectedMemory.scopeId || '全局'}</div>
                <div>创建时间: {new Date(selectedMemory.createdAt * 1000).toLocaleString()}</div>
                <div>更新时间: {new Date(selectedMemory.updatedAt * 1000).toLocaleString()}</div>
                {selectedMemory.expiresAt && (
                  <div>过期时间: {new Date(selectedMemory.expiresAt * 1000).toLocaleString()}</div>
                )}
              </>
            ) : (
              <>
                <div>{memoryOriginLabel(selectedMemory)}</div>
                <div>类型: {memoryCategoryLabel(selectedMemory.category)}</div>
                <div>创建时间: {new Date(selectedMemory.createdAt * 1000).toLocaleString()}</div>
              </>
            )}
            {selectedMemory.tags && selectedMemory.tags.length > 0 && (
              <div className="flex items-center gap-1">
                <Tag className="w-3 h-3" />
                {selectedMemory.tags.join(', ')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
