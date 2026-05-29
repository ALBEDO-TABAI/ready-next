import { useState } from 'react'
import { useMemories } from '../../hooks/useMemory'
import type { MemoryQueryFilters, MemoryEntry } from '../../types/electron'
import { Trash2, Layers, Tag, Clock, Eye } from 'lucide-react'
import { SETTINGS_INPUT_STYLE } from '../settings/settings-theme'

const fieldStyle = {
  ...SETTINGS_INPUT_STYLE
}

function memorySourceLabel(sourceType: MemoryEntry['sourceType'] | undefined): string {
  switch (sourceType) {
    case 'resident_agent':
      return '常驻记忆'
    case 'resident_user':
      return '用户偏好'
    case 'scope_memory':
      return '当前任务'
    case 'trigger_rule':
      return '触发规则'
    default:
      return '未分类'
  }
}

export default function MemoryListPanel() {
  const [filters, setFilters] = useState<MemoryQueryFilters>({ limit: 50 })
  const { memories, loading, error, deleteMemory } = useMemories(filters)
  const [selectedMemory, setSelectedMemory] = useState<MemoryEntry | null>(null)

  const handleDelete = async (id: string) => {
    if (confirm('确定要删除这条记忆吗？')) {
      try {
        await deleteMemory(id)
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
      {/* Filter Bar */}
      <div
        className="border-b flex items-center gap-3"
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
          onChange={(e) =>
            setFilters({ ...filters, sourceType: (e.target.value as any) || undefined })
          }
        >
          <option value="">所有来源</option>
          <option value="resident_agent">常驻记忆</option>
          <option value="resident_user">用户偏好</option>
          <option value="scope_memory">当前任务</option>
          <option value="trigger_rule">触发规则</option>
        </select>
        <select
          className="text-[13px] border rounded-lg transition-[box-shadow,border-color,background-color] duration-200"
          style={{
            ...fieldStyle,
            padding: '8px 12px'
          }}
          value={filters.layer || ''}
          onChange={(e) => setFilters({ ...filters, layer: (e.target.value as any) || undefined })}
        >
          <option value="">所有层级</option>
          <option value="l0">L0 - 常量</option>
          <option value="l1">L1 - 会话</option>
          <option value="l2">L2 - 触发器</option>
        </select>
        <select
          className="text-[13px] border rounded-lg transition-[box-shadow,border-color,background-color] duration-200"
          style={{
            ...fieldStyle,
            padding: '8px 12px'
          }}
          value={filters.category || ''}
          onChange={(e) =>
            setFilters({ ...filters, category: (e.target.value as any) || undefined })
          }
        >
          <option value="">所有类别</option>
          <option value="summary">摘要</option>
          <option value="learning">学习</option>
          <option value="trigger">触发器</option>
          <option value="rule">规则</option>
          <option value="user_preference">用户偏好</option>
          <option value="global_fact">全局事实</option>
          <option value="personality_trait">人格特征</option>
        </select>
        <label
          className="flex items-center gap-2 text-[13px]"
          style={{ color: 'var(--text-body)' }}
        >
          <input
            type="checkbox"
            checked={filters.includeArchived || false}
            onChange={(e) => setFilters({ ...filters, includeArchived: e.target.checked })}
            className="rounded"
          />
          包含已归档
        </label>
      </div>

      {/* Memory List */}
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
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--color-blue)' }}
                      >
                        {memory.layer}
                      </span>
                      <span
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--color-orange)' }}
                      >
                        {memorySourceLabel(memory.sourceType)}
                      </span>
                      <span
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--color-green)' }}
                      >
                        {memory.category}
                      </span>
                      {memory.archivedAt && (
                        <span
                          className="text-[11px] font-medium"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          已归档
                        </span>
                      )}
                    </div>
                    <div
                      className="text-[13px] font-medium mb-1 truncate"
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
                      <span className="flex items-center gap-1">
                        <Layers className="w-3 h-3" />
                        优先级 {memory.priority}
                      </span>
                      <span className="flex items-center gap-1">
                        <Eye className="w-3 h-3" />
                        访问 {memory.accessCount} 次
                      </span>
                      {memory.lastAccessedAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(memory.lastAccessedAt * 1000).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(memory.id)
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

      {/* Selected Memory Details */}
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
            记忆详情
          </div>
          <div className="space-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <div>ID: {selectedMemory.id}</div>
            <div>来源: {memorySourceLabel(selectedMemory.sourceType)}</div>
            <div>内容键: {selectedMemory.contentKey}</div>
            <div>作用域: {selectedMemory.scopeId || '全局'}</div>
            <div>创建时间: {new Date(selectedMemory.createdAt * 1000).toLocaleString()}</div>
            <div>更新时间: {new Date(selectedMemory.updatedAt * 1000).toLocaleString()}</div>
            {selectedMemory.expiresAt && (
              <div>过期时间: {new Date(selectedMemory.expiresAt * 1000).toLocaleString()}</div>
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
