import { useState, useEffect, useRef } from 'react'
import { X, Video, Image as ImageIcon, FileText, BookOpen, Radio, ChevronDown, ChevronUp, Clock } from 'lucide-react'
import { format, setHours, setMinutes } from 'date-fns'
import type { CalendarEvent } from './schedule-x-utils'
import { getDroppedFilesFromDataTransfer, toFileUrl } from '../../utils/dragDrop'

type ContentType = 'video' | 'image' | 'article' | 'story' | 'live'
type PublishStatus = 'draft' | 'scheduled' | 'published' | 'failed'

const CONTENT_TYPES: { value: ContentType; label: string; Icon: typeof Video }[] = [
  { value: 'video', label: '视频', Icon: Video },
  { value: 'image', label: '图片', Icon: ImageIcon },
  { value: 'article', label: '文章', Icon: FileText },
  { value: 'story', label: '动态', Icon: BookOpen },
  { value: 'live', label: '直播', Icon: Radio },
]

const PLATFORMS = [
  { value: 'douyin', label: '抖音', color: '#161823' },
  { value: 'bilibili', label: 'B站', color: '#00A1D6' },
  { value: 'xiaohongshu', label: '小红书', color: '#FF2442' },
  { value: 'wechat', label: '微信', color: '#07C160' },
  { value: 'weibo', label: '微博', color: '#E6162D' },
]

const STATUS_OPTIONS: { value: PublishStatus; label: string; color: string }[] = [
  { value: 'draft', label: '草稿', color: 'var(--text-muted)' },
  { value: 'scheduled', label: '已排期', color: 'var(--color-blue)' },
  { value: 'published', label: '已发布', color: 'var(--color-green)' },
  { value: 'failed', label: '失败', color: 'var(--color-red)' },
]

export interface EventModalData {
  title: string
  description?: string
  startTime: Date
  endTime: Date
  calendarId: string
  color: string
  allDay?: boolean
  contentType?: ContentType
  platform?: string[]
  publishStatus?: PublishStatus
}

interface EventModalProps {
  mode: 'create' | 'edit'
  event?: CalendarEvent | null
  defaultDate?: Date
  defaultHour?: number
  defaultDescription?: string
  sources: { id: string; name: string; color: string }[]
  onSave: (data: EventModalData) => void
  onDelete?: (id: string) => void
  onClose: () => void
}

export default function EventModal({
  mode,
  event,
  defaultDate,
  defaultHour,
  defaultDescription,
  sources,
  onSave,
  onDelete,
  onClose,
}: EventModalProps) {
  const initDate = event?.startTime ?? defaultDate ?? new Date()
  const initHour = event ? event.startTime.getHours() : (defaultHour ?? 9)
  const initEndHour = event ? event.endTime.getHours() : Math.min(23, initHour + 1)
  const initStartMin = event ? event.startTime.getMinutes() : 0
  const initEndMin = event ? event.endTime.getMinutes() : (initHour >= 23 ? 59 : 0)

  const [title, setTitle] = useState(event?.title ?? '')
  const [description, setDescription] = useState(event?.description ?? defaultDescription ?? '')
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? sources[0]?.id ?? '')
  const [allDay, setAllDay] = useState(event?.allDay ?? false)
  const [startDate, setStartDate] = useState(format(initDate, 'yyyy-MM-dd'))
  const [startTime, setStartTime] = useState(`${String(initHour).padStart(2, '0')}:${String(initStartMin).padStart(2, '0')}`)
  const [endDate, setEndDate] = useState(format(event?.endTime ?? initDate, 'yyyy-MM-dd'))
  const [endTime, setEndTime] = useState(`${String(initEndHour).padStart(2, '0')}:${String(initEndMin).padStart(2, '0')}`)
  const [contentType, setContentType] = useState<ContentType | undefined>(event?.contentType)
  const [platforms, setPlatforms] = useState<string[]>(event?.platform ?? [])
  const [publishStatus, setPublishStatus] = useState<PublishStatus>(event?.publishStatus ?? 'draft')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [descriptionDropActive, setDescriptionDropActive] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(mode === 'edit')

  const overlayRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }

  const togglePlatform = (value: string) => {
    setPlatforms(prev =>
      prev.includes(value) ? prev.filter(p => p !== value) : [...prev, value]
    )
  }

  const handleSave = () => {
    if (!title.trim()) return

    const [sy, sm, sd] = startDate.split('-').map(Number)
    const [sh, smin] = startTime.split(':').map(Number)
    const [ey, em, ed] = endDate.split('-').map(Number)
    const [eh, emin] = endTime.split(':').map(Number)

    const startDt = allDay
      ? new Date(sy, sm - 1, sd, 0, 0)
      : setMinutes(setHours(new Date(sy, sm - 1, sd), sh), smin)
    const endDtRaw = allDay
      ? new Date(ey, em - 1, ed, 23, 59)
      : setMinutes(setHours(new Date(ey, em - 1, ed), eh), emin)

    if (Number.isNaN(startDt.getTime()) || Number.isNaN(endDtRaw.getTime())) {
      return
    }

    const resolvedCalendarId = calendarId || sources[0]?.id || ''
    if (!resolvedCalendarId) return

    let endDt = endDtRaw
    if (endDt.getTime() <= startDt.getTime()) {
      endDt = allDay
        ? new Date(startDt.getFullYear(), startDt.getMonth(), startDt.getDate(), 23, 59)
        : new Date(startDt.getTime() + 60 * 60 * 1000)
    }

    const selectedSource = sources.find(s => s.id === resolvedCalendarId)

    onSave({
      title: title.trim(),
      description: description.trim() || undefined,
      startTime: startDt,
      endTime: endDt,
      calendarId: resolvedCalendarId,
      color: selectedSource?.color ?? '#5B8DEF',
      allDay,
      contentType,
      platform: platforms.length > 0 ? platforms : undefined,
      publishStatus,
    })
  }

  const handleDelete = () => {
    if (!event || !onDelete) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    onDelete(event.id)
  }

  const handleDescriptionDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const types = new Set(Array.from(e.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!descriptionDropActive) setDescriptionDropActive(true)
  }

  const handleDescriptionDragLeave = () => {
    if (descriptionDropActive) setDescriptionDropActive(false)
  }

  const handleDescriptionDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    if (droppedFiles.length === 0) return
    e.preventDefault()
    setDescriptionDropActive(false)

    const lines = droppedFiles.map((file) => `- [${file.name}](${toFileUrl(file.path)})`)
    const snippet = `\n附件:\n${lines.join('\n')}\n`
    setDescription((prev) => (prev.trim().length > 0 ? `${prev.trimEnd()}\n${snippet}` : snippet.trimStart()))
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
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.18)' }}
      onClick={handleOverlayClick}
    >
      <div
        style={{
          width: 320, maxHeight: '88vh', borderRadius: 10,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid var(--border-default)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
            {mode === 'create' ? '新建日程事件' : '编辑事件'}
          </span>
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

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
          {/* Title */}
          <div>
            <span style={labelStyle}>标题</span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
              placeholder="输入事件标题"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = 'var(--color-blue)')}
              onBlur={e => (e.target.style.borderColor = '')}
            />
          </div>

          {/* All Day Toggle + Calendar Source */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
              <div
                style={{
                  width: 28, height: 16, borderRadius: 8, position: 'relative',
                  background: allDay ? 'var(--color-blue)' : 'var(--border-default)',
                  cursor: 'pointer', transition: 'background 0.2s',
                }}
                onClick={() => setAllDay(!allDay)}
              >
                <div
                  style={{
                    position: 'absolute', top: 2, width: 12, height: 12,
                    borderRadius: 6, background: '#FFFFFF',
                    left: allDay ? 14 : 2, transition: 'left 0.2s',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
                  }}
                />
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-body)' }}>全天</span>
            </label>
            <div style={{ flex: 1 }}>
              <select
                value={calendarId}
                onChange={e => setCalendarId(e.target.value)}
                style={{
                  ...inputStyle, height: 28, padding: '4px 8px', fontSize: 11,
                }}
              >
                {sources.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Date & Time */}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <span style={labelStyle}>开始</span>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                style={{ ...inputStyle, fontSize: 11 }}
                onFocus={e => (e.target.style.borderColor = 'var(--color-blue)')}
                onBlur={e => (e.target.style.borderColor = '')}
              />
              {!allDay && (
                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                  <Clock style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
                  <input
                    type="time"
                    value={startTime}
                    onChange={e => setStartTime(e.target.value)}
                    className="ready-input-slot-inner"
                    style={{
                      border: 'none', background: 'transparent', fontSize: 12,
                      color: 'var(--text-body)', outline: 'none', flex: 1, padding: 0,
                      fontFamily: 'Inter, system-ui, sans-serif',
                    }}
                  />
                </div>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <span style={labelStyle}>结束</span>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                style={{ ...inputStyle, fontSize: 11 }}
                onFocus={e => (e.target.style.borderColor = 'var(--color-blue)')}
                onBlur={e => (e.target.style.borderColor = '')}
              />
              {!allDay && (
                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                  <Clock style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
                  <input
                    type="time"
                    value={endTime}
                    onChange={e => setEndTime(e.target.value)}
                    className="ready-input-slot-inner"
                    style={{
                      border: 'none', background: 'transparent', fontSize: 12,
                      color: 'var(--text-body)', outline: 'none', flex: 1, padding: 0,
                      fontFamily: 'Inter, system-ui, sans-serif',
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Description */}
          <div>
            <span style={labelStyle}>备注</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              onDragOver={handleDescriptionDragOver}
              onDragLeave={handleDescriptionDragLeave}
              onDrop={handleDescriptionDrop}
              placeholder="添加备注..."
              rows={2}
              style={{
                width: '100%', height: 52, padding: '6px 10px',
                borderRadius: 6,
                border: `1px solid ${descriptionDropActive ? 'var(--color-blue)' : 'var(--input-slot-border)'}`,
                background: 'var(--input-slot-bg)', boxShadow: 'var(--input-slot-shadow)',
                fontSize: 12, color: 'var(--text-body)',
                outline: 'none', resize: 'none',
                fontFamily: 'Inter, system-ui, sans-serif',
                transition: 'border-color 0.2s',
              }}
              onFocus={e => (e.target.style.borderColor = 'var(--color-blue)')}
              onBlur={e => { if (!descriptionDropActive) e.target.style.borderColor = '' }}
            />
            <div style={{ fontSize: 10, marginTop: 2, color: descriptionDropActive ? 'var(--color-blue)' : 'var(--text-light)' }}>
              可从文件面板拖入作为附件链接
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--border-default)' }} />

          {/* Advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '5px 10px', borderRadius: 6,
              border: '1px solid var(--border-default)', fontSize: 11,
              color: 'var(--text-muted)', background: 'var(--bg-primary)',
              cursor: 'pointer',
            }}
          >
            <span>更多设置（发布信息）</span>
            {showAdvanced ? <ChevronUp style={{ width: 14, height: 14 }} /> : <ChevronDown style={{ width: 14, height: 14 }} />}
          </button>

          {showAdvanced && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Content Type */}
              <div>
                <span style={labelStyle}>内容类型</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  {CONTENT_TYPES.map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      onClick={() => setContentType(contentType === value ? undefined : value)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '3px 8px', borderRadius: 6, fontSize: 10,
                        border: `1px solid ${contentType === value ? 'var(--color-blue)' : 'var(--border-default)'}`,
                        background: contentType === value ? 'var(--color-blue-light)' : 'transparent',
                        color: contentType === value ? 'var(--color-blue)' : 'var(--text-body)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      <Icon style={{ width: 12, height: 12 }} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Platform Targets */}
              <div>
                <span style={labelStyle}>发布平台</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  {PLATFORMS.map(({ value, label, color }) => {
                    const selected = platforms.includes(value)
                    return (
                      <button
                        key={value}
                        onClick={() => togglePlatform(value)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '3px 8px', borderRadius: 6, fontSize: 10,
                          border: `1px solid ${selected ? color : 'var(--border-default)'}`,
                          background: selected ? `${color}12` : 'transparent',
                          color: selected ? color : 'var(--text-body)',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: 3, background: selected ? color : 'var(--border-default)' }} />
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Publish Status */}
              <div>
                <span style={labelStyle}>发布状态</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  {STATUS_OPTIONS.map(({ value, label, color }) => (
                    <button
                      key={value}
                      onClick={() => setPublishStatus(value)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '3px 8px', borderRadius: 6, fontSize: 10,
                        border: `1px solid ${publishStatus === value ? color : 'var(--border-default)'}`,
                        background: publishStatus === value ? `${color}15` : 'transparent',
                        color: publishStatus === value ? color : 'var(--text-body)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: 3, background: publishStatus === value ? color : 'var(--border-default)' }} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px',
            borderTop: '1px solid var(--border-default)',
            flexShrink: 0,
          }}
        >
          <div>
            {mode === 'edit' && onDelete && event && (
              <button
                onClick={handleDelete}
                className="active:scale-[0.98] transition-all duration-150 ease-out"
                style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                  background: confirmDelete ? 'var(--color-red)' : 'transparent',
                  color: confirmDelete ? '#FFFFFF' : 'var(--color-red)',
                  border: confirmDelete ? 'none' : '1px solid var(--color-red)',
                }}
              >
                {confirmDelete ? '确认删除' : '删除事件'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              {mode === 'create' ? '创建' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
