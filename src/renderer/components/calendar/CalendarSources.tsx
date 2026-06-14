import { useState, useRef, useEffect } from 'react'
import {
  Plus, X, Pencil, Trash2, Check, Upload, Link as LinkIcon, RefreshCw,
} from 'lucide-react'

export interface CalendarSource {
  id: string
  name: string
  color: string
  enabled: boolean
  /**
   * L4-B — present when this source was created by `subscribeUrl` (the
   * upstream feed URL). Undefined / null for purely-local sources and
   * for sources backed by a one-shot ICS file import. UI uses this to
   * decide whether to surface the "立即同步" / "取消订阅" buttons.
   */
  syncUrl?: string | null
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
  /**
   * L4-B — invoked when the user picks a .ics file. Parent wires this
   * to `window.electronAPI.calendar.importIcsString({ rawIcs, sourceName: file.name })`
   * and refreshes the source list on success. Optional so existing
   * call sites compile until they opt in.
   */
  onImportIcs?: (file: File) => void
  /**
   * L4-B — invoked when the user submits the URL-subscription modal.
   * Parent wires this to `window.electronAPI.calendar.subscribeUrl(...)`.
   */
  onSubscribeUrl?: (payload: {
    url: string
    name: string
    color: string
    syncIntervalMinutes: number
  }) => void
  /**
   * L4-B — invoked when the user clicks "立即同步" on a subscribed
   * source row. Parent wires this to `window.electronAPI.calendar.
   * syncSourceNow(id)`.
   */
  onSyncNow?: (id: string) => void
}

export default function CalendarSources({
  sources,
  onToggleSource,
  onAddSource,
  onUpdateSource,
  onDeleteSource,
  onImportIcs,
  onSubscribeUrl,
  onSyncNow,
}: CalendarSourcesProps) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(PRESET_COLORS[0])
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // L4-B — inline (not portal) subscribe-URL modal state. We keep it
  // inline because the rest of the sidebar lives in an absolute-
  // positioned sidebar; a portal would be visually overkill for one
  // small form.
  const [showSubscribeForm, setShowSubscribeForm] = useState(false)
  const [subUrl, setSubUrl] = useState('')
  const [subName, setSubName] = useState('')
  const [subColor, setSubColor] = useState(PRESET_COLORS[5])
  const [subIntervalMinutes, setSubIntervalMinutes] = useState(60)
  const [subError, setSubError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const subUrlInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showAddForm) inputRef.current?.focus()
  }, [showAddForm])

  useEffect(() => {
    if (showSubscribeForm) subUrlInputRef.current?.focus()
  }, [showSubscribeForm])

  // L4-B — file picker handler. We use a hidden <input type="file"> +
  // programmatic click rather than rendering a visible file input
  // because the button needs custom styling that matches the rest of
  // the calendar sidebar.
  const handlePickIcsFile = () => {
    if (!onImportIcs) return
    fileInputRef.current?.click()
  }

  const handleIcsFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset the input so picking the same file twice still triggers
    // the change event. This is a common HTML form gotcha.
    e.currentTarget.value = ''
    if (!file || !onImportIcs) return
    onImportIcs(file)
  }

  const handleSubscribeSubmit = () => {
    setSubError(null)
    if (!onSubscribeUrl) return
    const trimmedUrl = subUrl.trim()
    const trimmedName = subName.trim()
    if (trimmedUrl.length === 0) {
      setSubError('请填写订阅 URL')
      return
    }
    if (!/^https?:\/\//i.test(trimmedUrl) && !/^webcal:\/\//i.test(trimmedUrl)) {
      setSubError('URL 必须以 http:// / https:// / webcal:// 开头')
      return
    }
    if (trimmedName.length === 0) {
      setSubError('请填写日历名称')
      return
    }
    // webcal:// → https:// canonical form so Node fetch can resolve it.
    const url = trimmedUrl.replace(/^webcal:\/\//i, 'https://')
    onSubscribeUrl({
      url,
      name: trimmedName,
      color: subColor,
      syncIntervalMinutes: subIntervalMinutes,
    })
    setShowSubscribeForm(false)
    setSubUrl('')
    setSubName('')
    setSubColor(PRESET_COLORS[5])
    setSubIntervalMinutes(60)
  }

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
                      width: 14, height: 14, borderRadius: 8, background: c,
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
                {/* L4-B — only externally-subscribed sources expose
                    "立即同步". Local sources don't have a remote feed
                    to pull from, so the button would be a no-op. */}
                {onSyncNow && typeof source.syncUrl === 'string' && source.syncUrl.length > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onSyncNow(source.id) }}
                    style={{ padding: 2, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex' }}
                    title="立即同步"
                  >
                    <RefreshCw style={{ width: 11, height: 11, color: 'var(--text-gray)' }} />
                  </button>
                )}
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
                  title={typeof source.syncUrl === 'string' && source.syncUrl.length > 0 ? '取消订阅' : '删除'}
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
                  width: 14, height: 14, borderRadius: 8, background: c,
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

      {/* L4-B — Import / subscribe entry buttons. Only render when the
          parent has wired the callbacks; this keeps the component back-
          compat for unit tests that don't care about external sync. */}
      {(onImportIcs || onSubscribeUrl) && (
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--border-default)',
          }}
        >
          {onImportIcs && (
            <div
              onClick={handlePickIcsFile}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                height: 22, cursor: 'pointer',
              }}
            >
              <Upload
                style={{ width: 12, height: 12, color: 'var(--text-light)' }}
                strokeWidth={2}
              />
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-gray)' }}>
                导入 .ics 文件
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".ics,text/calendar"
                onChange={handleIcsFileChange}
                style={{ display: 'none' }}
              />
            </div>
          )}
          {onSubscribeUrl && (
            <div
              onClick={() => setShowSubscribeForm(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                height: 22, cursor: 'pointer',
              }}
            >
              <LinkIcon
                style={{ width: 12, height: 12, color: 'var(--text-light)' }}
                strokeWidth={2}
              />
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-gray)' }}>
                订阅日历 URL
              </span>
            </div>
          )}
        </div>
      )}

      {/* L4-B — Subscribe-URL modal. Inline (not portal), styled to
          match the add-calendar form so the visual language stays
          consistent. */}
      {showSubscribeForm && onSubscribeUrl && (
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: 10, background: 'rgba(91,141,239,0.04)',
            border: '1px solid rgba(91,141,239,0.15)', borderRadius: 8,
            marginTop: 6,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-title)' }}>
            订阅外部日历
          </span>
          <input
            ref={subUrlInputRef}
            value={subUrl}
            onChange={e => { setSubUrl(e.target.value); setSubError(null) }}
            onKeyDown={e => { if (e.key === 'Escape') setShowSubscribeForm(false) }}
            placeholder="https:// 或 webcal:// 开头的 ICS URL"
            style={{
              width: '100%', padding: '4px 8px', borderRadius: 4,
              border: '1px solid #E8E8E8', background: '#FFFFFF',
              fontSize: 11, outline: 'none',
            }}
          />
          <input
            value={subName}
            onChange={e => { setSubName(e.target.value); setSubError(null) }}
            placeholder="日历名称（用于侧栏显示）"
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
                onClick={() => setSubColor(c)}
                style={{
                  width: 14, height: 14, borderRadius: 8, background: c,
                  border: subColor === c ? '2px solid var(--text-secondary)' : '2px solid transparent',
                  transform: subColor === c ? 'scale(1.2)' : undefined,
                  cursor: 'pointer', padding: 0,
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-gray)' }}>同步间隔（分钟）</span>
            <input
              type="number"
              min={5}
              max={1440}
              value={subIntervalMinutes}
              onChange={e => {
                const next = Number(e.target.value)
                setSubIntervalMinutes(Number.isFinite(next) && next >= 5 ? next : 60)
              }}
              style={{
                width: 70, padding: '2px 6px', borderRadius: 4,
                border: '1px solid #E8E8E8', background: '#FFFFFF',
                fontSize: 11, outline: 'none',
              }}
            />
          </div>
          {subError && (
            <span style={{ fontSize: 10, color: '#EB5757' }}>{subError}</span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={handleSubscribeSubmit}
              disabled={!subUrl.trim() || !subName.trim()}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '2px 8px', borderRadius: 4, border: 'none',
                background: '#5B8DEF', color: '#FFFFFF', fontSize: 10,
                cursor: 'pointer',
                opacity: subUrl.trim() && subName.trim() ? 1 : 0.4,
              }}
            >
              <Check style={{ width: 10, height: 10 }} /> 订阅
            </button>
            <button
              onClick={() => {
                setShowSubscribeForm(false)
                setSubError(null)
              }}
              style={{
                padding: '2px 8px', borderRadius: 4, border: 'none',
                background: 'transparent', color: 'var(--text-gray)', fontSize: 10,
                cursor: 'pointer',
              }}
            >
              <X style={{ width: 10, height: 10 }} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
