import { useState, useEffect, useRef } from 'react'
import {
  CalendarPlus, CheckSquare, Repeat, Flag, Bell, StickyNote,
  Upload, Link, X, Clock, MapPin, Users,
} from 'lucide-react'

// --- Menu items ---
const MENU_ITEMS = [
  { key: 'event', icon: CalendarPlus, color: '#EB5757', title: '新建日程事件', desc: '创建一个新的日历事件' },
  { key: 'task', icon: CheckSquare, color: '#F2994A', title: '新建任务', desc: '添加待办任务到日程' },
  { key: 'repeat', icon: Repeat, color: '#9B51E0', title: '新建重复事件', desc: '每天/每周/每月重复' },
  { key: 'milestone', icon: Flag, color: '#2D9CDB', title: '新建里程碑', desc: '标记项目关键节点' },
  { key: 'reminder', icon: Bell, color: '#27AE60', title: '新建提醒', desc: '设置时间提醒通知' },
  { key: 'memo', icon: StickyNote, color: '#F2C94C', title: '新建备忘', desc: '快速记录备忘信息' },
]

const BOTTOM_ITEMS = [
  { key: 'import', icon: Upload, color: 'var(--text-light)', title: '导入日程 (.ics)', desc: '从文件导入日程事件' },
  { key: 'subscribe', icon: Link, color: 'var(--text-light)', title: '订阅日历', desc: '通过 URL 订阅外部日历' },
]

const EVENT_COLORS = [
  { color: '#EB5757', name: '红色' },
  { color: '#F2994A', name: '橙色' },
  { color: '#F2C94C', name: '黄色' },
  { color: '#27AE60', name: '绿色' },
  { color: '#2D9CDB', name: '蓝色' },
  { color: '#9B51E0', name: '紫色' },
  { color: '#EB83B5', name: '粉色' },
]

// --- NewEventMenu dropdown (Primary Menu) ---
export function NewEventMenu({
  position,
  onSelect,
  onClose,
}: {
  position: { top: number; left: number }
  onSelect: (type: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const renderItem = (item: typeof MENU_ITEMS[0]) => (
    <div
      key={item.key}
      onClick={() => onSelect(item.key)}
      onMouseEnter={() => setHoveredKey(item.key)}
      onMouseLeave={() => setHoveredKey(null)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 10px', cursor: 'pointer',
        borderRadius: 6,
        background: hoveredKey === item.key ? 'var(--bg-hover)' : 'transparent',
        transition: 'background 0.12s',
      }}
    >
      <span
        style={{
          width: 26, height: 26, borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${item.color}14`, flexShrink: 0,
        }}
      >
        <item.icon style={{ width: 14, height: 14, color: item.color }} strokeWidth={1.8} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-body)' }}>{item.title}</span>
        <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}>{item.desc}</span>
      </div>
    </div>
  )

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', zIndex: 30,
        top: position.top, left: position.left,
        width: 220, borderRadius: 10,
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-default)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
        display: 'flex', flexDirection: 'column',
        padding: 6,
      }}
    >
      {/* Header */}
      <div style={{ padding: '6px 10px 4px 10px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>新建日程</span>
      </div>

      {/* Main items */}
      {MENU_ITEMS.map((item) => renderItem(item))}

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--border-default)', margin: '4px 0' }} />

      {/* Bottom items */}
      {BOTTOM_ITEMS.map(item => renderItem(item))}
    </div>
  )
}

// --- Event type titles for the card header ---
const EVENT_TYPE_TITLES: Record<string, string> = {
  event: '新建日程事件',
  task: '新建任务',
  repeat: '新建重复事件',
  milestone: '新建里程碑',
  reminder: '新建提醒',
  memo: '新建备忘',
  import: '导入日程 (.ics)',
  subscribe: '订阅日历',
}

// --- NewEventCard form (Secondary Form Panel) ---
export function NewEventCard({
  day,
  hour,
  position,
  sources,
  eventType,
  defaultDescription,
  onSubmit,
  onClose,
}: {
  day: Date
  hour: number
  position: { top: number; left: number }
  sources: { id: string; name: string; color: string }[]
  eventType?: string
  defaultDescription?: string
  onSubmit: (data: { title: string; startTime: Date; endTime: Date; calendarId: string; color: string; description?: string; location?: string }) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const safeEndHour = hour >= 23 ? 23 : hour + 1
  const safeEndMinute = hour >= 23 ? 59 : 0
  const [startTimeStr, setStartTimeStr] = useState(`${String(hour).padStart(2, '0')}:00`)
  const [endTimeStr, setEndTimeStr] = useState(`${String(safeEndHour).padStart(2, '0')}:${String(safeEndMinute).padStart(2, '0')}`)
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState(defaultDescription ?? '')
  const [selectedColor, setSelectedColor] = useState(EVENT_COLORS[0].color)
  const ref = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const cardTitle = EVENT_TYPE_TITLES[eventType ?? 'event'] ?? '新建日程事件'

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const handleSave = () => {
    if (!title.trim()) return
    const [sh, sm] = startTimeStr.split(':').map(Number)
    const [eh, em] = endTimeStr.split(':').map(Number)
    const startTime = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm)
    let endTime = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em)
    // Ensure endTime is after startTime
    if (endTime.getTime() <= startTime.getTime()) {
      endTime = new Date(startTime.getTime() + 60 * 60 * 1000)
    }
    const source = sources[0]
    onSubmit({
      title: title.trim(),
      startTime,
      endTime,
      calendarId: source?.id || '',
      color: selectedColor,
      description: description.trim() || undefined,
      location: location.trim() || undefined,
    })
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 32, padding: '6px 10px',
    borderRadius: 6, border: '1px solid var(--input-slot-border)',
    background: 'var(--input-slot-bg)', boxShadow: 'var(--input-slot-shadow)',
    fontSize: 12, color: 'var(--text-body)',
    outline: 'none', fontFamily: 'Inter, system-ui, sans-serif',
    transition: 'border-color 0.2s',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 4,
    display: 'block',
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', zIndex: 30,
        top: position.top, left: position.left,
        width: 300, borderRadius: 10,
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-default)',
        overflow: 'hidden',
        boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>{cardTitle}</span>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: 4, borderRadius: 4, display: 'flex',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <X style={{ width: 14, height: 14, color: 'var(--text-muted)' }} strokeWidth={2} />
        </button>
      </div>

      {/* Form body */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
        {/* Title */}
        <div>
          <span style={labelStyle}>标题</span>
          <input
            ref={titleRef}
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose() }}
            placeholder="输入事件标题"
            style={inputStyle}
            onFocus={e => (e.target.style.borderColor = 'var(--color-blue)')}
            onBlur={e => (e.target.style.borderColor = '')}
          />
        </div>

        {/* Time — two inputs side by side */}
        <div>
          <span style={labelStyle}>时间</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <Clock style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
              <input
                type="time"
                value={startTimeStr}
                onChange={e => setStartTimeStr(e.target.value)}
                className="ready-input-slot-inner"
                style={{
                  border: 'none', background: 'transparent', fontSize: 12,
                  color: 'var(--text-body)', outline: 'none', flex: 1, padding: 0,
                  fontFamily: 'Inter, system-ui, sans-serif',
                }}
              />
            </div>
            <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <Clock style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
              <input
                type="time"
                value={endTimeStr}
                onChange={e => setEndTimeStr(e.target.value)}
                className="ready-input-slot-inner"
                style={{
                  border: 'none', background: 'transparent', fontSize: 12,
                  color: 'var(--text-body)', outline: 'none', flex: 1, padding: 0,
                  fontFamily: 'Inter, system-ui, sans-serif',
                }}
              />
            </div>
          </div>
        </div>

        {/* Location */}
        <div>
          <span style={labelStyle}>地点</span>
          <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
            <MapPin style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
            <input
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="添加地点..."
              className="ready-input-slot-inner"
              style={{
                border: 'none', background: 'transparent', fontSize: 12,
                color: 'var(--text-body)', outline: 'none', flex: 1, padding: 0,
                fontFamily: 'Inter, system-ui, sans-serif',
              }}
            />
          </div>
        </div>

        {/* Participants */}
        <div>
          <span style={labelStyle}>参与者</span>
          <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Users style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>添加参与者...</span>
          </div>
        </div>

        {/* Color labels */}
        <div>
          <span style={labelStyle}>颜色标签</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {EVENT_COLORS.map(c => (
              <span
                key={c.color}
                onClick={() => setSelectedColor(c.color)}
                title={c.name}
                style={{
                  width: 18, height: 18, borderRadius: 9,
                  background: c.color, cursor: 'pointer',
                  border: selectedColor === c.color ? '2px solid var(--bg-primary)' : '2px solid transparent',
                  outline: selectedColor === c.color ? `2px solid ${c.color}` : '2px solid transparent',
                  transition: 'outline-color 0.15s, border-color 0.15s',
                }}
              />
            ))}
          </div>
        </div>

        {/* Notes */}
        <div>
          <span style={labelStyle}>备注</span>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="添加备注..."
            style={{
              width: '100%', height: 52, padding: '6px 10px',
              borderRadius: 6, border: '1px solid var(--input-slot-border)',
              background: 'var(--input-slot-bg)', boxShadow: 'var(--input-slot-shadow)',
              fontSize: 12, color: 'var(--text-body)',
              outline: 'none', resize: 'none',
              fontFamily: 'Inter, system-ui, sans-serif',
              transition: 'border-color 0.2s',
            }}
            onFocus={e => (e.target.style.borderColor = 'var(--color-blue)')}
            onBlur={e => (e.target.style.borderColor = '')}
          />
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: 8, padding: '0 14px 14px 14px',
        }}
      >
        <button
          onClick={onClose}
          className="hover:bg-[var(--bg-hover)] active:scale-[0.98] transition-all duration-150 ease-out"
          style={{
            padding: '5px 14px', borderRadius: 6,
            border: '1px solid var(--border-default)', background: 'var(--bg-primary)',
            fontSize: 12, color: 'var(--text-body)', cursor: 'pointer',
          }}
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={!title.trim()}
          className="active:scale-[0.98] transition-all duration-150 ease-out"
          style={{
            padding: '5px 14px', borderRadius: 6,
            border: 'none', background: 'var(--text-title)',
            fontSize: 12, fontWeight: 600, color: 'var(--bg-primary)',
            cursor: title.trim() ? 'pointer' : 'not-allowed',
            opacity: title.trim() ? 1 : 0.5,
          }}
        >
          保存
        </button>
      </div>
    </div>
  )
}
