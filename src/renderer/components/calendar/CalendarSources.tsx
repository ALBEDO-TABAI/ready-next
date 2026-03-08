import { useState, useRef, useEffect } from 'react'
import { Plus, X, Pencil, Trash2, Check } from 'lucide-react'

export interface CalendarSource {
  id: string
  name: string
  color: string
  enabled: boolean
}

const PRESET_COLORS = [
  '#5B8DEF', '#E97A2B', '#34D399', '#8B5CF6',
  '#EB5757', '#F59E0B', '#EC4899', '#06B6D4',
  '#10B981', '#6366F1', '#14B8A6', '#F97316',
]

interface CalendarSourcesProps {
  sources: CalendarSource[]
  onToggleSource: (id: string) => void
  onAddSource: (source: CalendarSource) => void
  onUpdateSource: (id: string, updates: Partial<CalendarSource>) => void
  onDeleteSource: (id: string) => void
}

export default function CalendarSources({
  sources,
  onToggleSource,
  onAddSource,
  onUpdateSource,
  onDeleteSource,
}: CalendarSourcesProps) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(PRESET_COLORS[0])
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showAddForm) inputRef.current?.focus()
  }, [showAddForm])

  const handleAddSubmit = () => {
    if (!newName.trim()) return
    const id = `calendar-${Date.now()}`
    onAddSource({ id, name: newName.trim(), color: newColor, enabled: true })
    setNewName('')
    setNewColor(PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)])
    setShowAddForm(false)
  }

  const handleEditStart = (source: CalendarSource) => {
    setEditingId(source.id)
    setEditName(source.name)
    setEditColor(source.color)
  }

  const handleEditSave = () => {
    if (!editingId || !editName.trim()) return
    onUpdateSource(editingId, { name: editName.trim(), color: editColor })
    setEditingId(null)
  }

  const handleDelete = (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      return
    }
    onDeleteSource(id)
    setConfirmDeleteId(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
      {/* Section title */}
      <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-gray)' }}>我的日历</span>

      {/* Source list */}
      {sources.map(source => {
        const isEditing = editingId === source.id
        const isHovered = hoveredId === source.id

        if (isEditing) {
          return (
            <div
              key={source.id}
              style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                padding: '8px 10px', background: 'var(--bg-hover)',
                border: '1px solid var(--border-default)', borderRadius: 8,
              }}
            >
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleEditSave(); if (e.key === 'Escape') setEditingId(null) }}
                autoFocus
                style={{
                  width: '100%', padding: '3px 8px', borderRadius: 4,
                  border: '1px solid var(--border-default)', background: 'var(--bg-primary)',
                  fontSize: 11, outline: 'none',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                {PRESET_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setEditColor(c)}
                    style={{
                      width: 14, height: 14, borderRadius: 7, background: c,
                      border: editColor === c ? '2px solid var(--text-secondary)' : '2px solid transparent',
                      transform: editColor === c ? 'scale(1.2)' : undefined,
                      cursor: 'pointer', padding: 0,
                    }}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={handleEditSave}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 3,
                    padding: '2px 8px', borderRadius: 4, border: 'none',
                    background: '#5B8DEF', color: '#FFFFFF', fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  <Check style={{ width: 10, height: 10 }} /> 保存
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  style={{
                    padding: '2px 8px', borderRadius: 4, border: 'none',
                    background: 'transparent', color: 'var(--text-gray)', fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )
        }

        return (
          <div
            key={source.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              height: 22, cursor: 'pointer',
              opacity: source.enabled ? 1 : 0.5,
            }}
            onMouseEnter={() => setHoveredId(source.id)}
            onMouseLeave={() => { setHoveredId(null); setConfirmDeleteId(null) }}
          >
            {/* Colored dot (8x8 ellipse, matches .pen design) */}
            <span
              onClick={() => onToggleSource(source.id)}
              style={{
                width: 8, height: 8, borderRadius: 4, flexShrink: 0,
                background: source.color,
                cursor: 'pointer',
              }}
            />

            <span
              onClick={() => onToggleSource(source.id)}
              style={{
                flex: 1, fontSize: 11, fontWeight: 500,
                color: 'var(--text-body)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              {source.name}
            </span>

            {/* Hover actions */}
            {isHovered && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <button
                  onClick={(e) => { e.stopPropagation(); handleEditStart(source) }}
                  style={{ padding: 2, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}
                  title="编辑"
                >
                  <Pencil style={{ width: 11, height: 11, color: 'var(--text-gray)' }} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(source.id) }}
                  style={{ padding: 2, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}
                  title="删除"
                >
                  <Trash2 style={{ width: 11, height: 11, color: confirmDeleteId === source.id ? '#EB5757' : 'var(--text-gray)' }} />
                </button>
              </div>
            )}
          </div>
        )
      })}

      {/* Add Calendar Form */}
      {showAddForm && (
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: 10, background: 'rgba(91,141,239,0.04)',
            border: '1px solid rgba(91,141,239,0.15)', borderRadius: 8,
            marginTop: 2,
          }}
        >
          <input
            ref={inputRef}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddSubmit(); if (e.key === 'Escape') setShowAddForm(false) }}
            placeholder="日历名称"
            style={{
              width: '100%', padding: '4px 8px', borderRadius: 4,
              border: '1px solid #E8E8E8', background: '#FFFFFF',
              fontSize: 11, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                onClick={() => setNewColor(c)}
                style={{
                  width: 14, height: 14, borderRadius: 7, background: c,
                  border: newColor === c ? '2px solid var(--text-secondary)' : '2px solid transparent',
                  transform: newColor === c ? 'scale(1.2)' : undefined,
                  cursor: 'pointer', padding: 0,
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={handleAddSubmit}
              disabled={!newName.trim()}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '2px 8px', borderRadius: 4, border: 'none',
                background: '#5B8DEF', color: '#FFFFFF', fontSize: 10,
                cursor: 'pointer', opacity: newName.trim() ? 1 : 0.4,
              }}
            >
              <Plus style={{ width: 10, height: 10 }} /> 添加
            </button>
            <button
              onClick={() => { setShowAddForm(false); setNewName('') }}
              style={{
                padding: '2px 8px', borderRadius: 4, border: 'none',
                background: 'transparent', color: 'var(--text-gray)', fontSize: 10,
                cursor: 'pointer',
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Add Calendar Button - matches .pen: plus icon #999999, text "添加日历帐号" #8A8A8A */}
      {!showAddForm && (
        <div
          onClick={() => setShowAddForm(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            height: 22, cursor: 'pointer',
          }}
        >
          <Plus style={{ width: 12, height: 12, color: 'var(--text-light)' }} strokeWidth={2} />
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-gray)' }}>添加日历帐号</span>
        </div>
      )}
    </div>
  )
}
