import { useState, useEffect, useRef } from 'react'
import { X, Video, Image as ImageIcon, FileText, BookOpen, Radio, ChevronDown, ChevronUp, Clock, MapPin } from 'lucide-react'
import { format, setHours, setMinutes } from 'date-fns'
import type { CalendarEvent } from './schedule-x-utils'
import type { Reminder } from '../../../shared/calendar-types'
import ReminderEditor from './ReminderEditor'
import RecurrenceEditor from './RecurrenceEditor'
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
  location?: string
  startTime: Date
  endTime: Date
  calendarId: string
  color: string
  allDay?: boolean
  contentType?: ContentType
  platform?: string[]
  publishStatus?: PublishStatus
  /**
   * L2-B-Reminder-UI — list of reminders attached to this event.
   *
   * Contract with IPC (per L2-A):
   *   - `undefined` → caller should pass nothing to IPC (no-op).
   *   - `null` → "clear all reminders" (explicit, useful for edit).
   *   - `Reminder[]` → "replace whole list" (zero-length array is
   *     normalized to `null` by ReminderEditor.canonicalizeReminderList,
   *     so an empty list never reaches IPC).
   *
   * EventModal seeds this from `event?.reminders` on open; the editor
   * propagates user edits via `setReminders`.
   */
  reminders?: Reminder[] | null
  /**
   * L3-B-RRULE-UI — RFC 5545 RRULE body or null to clear. EventModal
   * propagates whatever RecurrenceEditor produced. The host
   * (CalendarMode) routes this:
   *   - `recurrenceScope === 'series'` → pass to createEvent /
   *     updateEvent unchanged.
   *   - `recurrenceScope === 'single'` → ignored (override patches
   *     only the per-occurrence fields below).
   *   - `recurrenceScope === 'future'` → forwarded as
   *     `patch.recurrenceRule` to splitRecurringSeries.
   */
  recurrenceRule?: string | null
  /**
   * L3-B — which "scope" the user picked in the mini-dialog when
   * editing a recurring instance. Always `'series'` for non-recurring
   * events or freshly-created events. Renderer-only field; never sent
   * to IPC directly — host inspects this to choose the IPC call.
   */
  recurrenceScope?: 'single' | 'future' | 'series'
}

interface EventModalProps {
  mode: 'create' | 'edit'
  event?: CalendarEvent | null
  defaultDate?: Date
  defaultHour?: number
  defaultDescription?: string
  /**
   * L2-B — used when the create flow wants to pre-populate reminders
   * (e.g. NewEventMenu "新建提醒" entry seeds a default
   * `[{ offsetMinutes: -15, method: 'notification' }]`). Ignored when
   * editing — edit mode uses `event.reminders`.
   */
  defaultReminders?: Reminder[] | null
  /**
   * L3-B-RRULE-UI — seeded RRULE when create flow wants to pre-populate
   * a recurrence rule (e.g. NewEventMenu "新建重复事件" pick passes
   * `'FREQ=WEEKLY;COUNT=10'`). Ignored on edit — edit reads from
   * `event.recurrenceRule`.
   */
  defaultRecurrenceRule?: string | null
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
  defaultReminders,
  defaultRecurrenceRule,
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
  const [location, setLocation] = useState(event?.location ?? '')
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
  // L2-B — reminders state seeded from event.reminders on edit, or from
  // `defaultReminders` on create (NewEventMenu reminder entry passes a
  // default `-15 / notification` row). Empty list is canonicalized to
  // `null` before IPC by ReminderEditor.canonicalizeReminderList.
  // Note: the renderer-side `CalendarEvent` view type doesn't yet carry
  // `reminders` so we read it via a typed cast — schedule-x-utils
  // extension is in this same PR so the runtime field exists.
  const initialReminders: Reminder[] | null =
    event && Array.isArray((event as { reminders?: Reminder[] | null }).reminders)
      ? ((event as { reminders?: Reminder[] | null }).reminders ?? null)
      : (mode === 'create' ? (defaultReminders ?? null) : null)
  const [reminders, setReminders] = useState<Reminder[] | null>(initialReminders)

  // L3-B-RRULE-UI — recurrence rule state. Edit seeds from
  // `event.recurrenceRule`; create seeds from `defaultRecurrenceRule`
  // (NewEventMenu "新建重复" pick passes a default 'FREQ=WEEKLY;COUNT=10').
  // When the event is an EXPANDED INSTANCE (id contains '#' or
  // instanceOf !== id), the parent's RRULE is what we display — the
  // user can see the cadence but changes go through the
  // single/future/series dialog below.
  const initialRecurrenceRule: string | null =
    event?.recurrenceRule !== undefined
      ? event.recurrenceRule
      : (mode === 'create' ? (defaultRecurrenceRule ?? null) : null)
  const [recurrenceRule, setRecurrenceRule] = useState<string | null>(initialRecurrenceRule)

  // L3-B — "is this an expanded recurring instance" detection. Three
  // independent signals; any one is sufficient:
  //   1. `event.id` contains '#' (rrule engine's syntheticId format).
  //   2. `event.instanceOf` exists and differs from `event.id`.
  //   3. `event.occurrenceStart` is set (only expanded instances carry
  //      it; non-recurring rows leave it undefined).
  // We require at least one of (1)/(2)/(3) — a freshly-created
  // recurring parent that hasn't been expanded yet won't satisfy any
  // and falls through to "series" semantics, which is correct (editing
  // the parent row directly is the series operation).
  const isRecurringInstance =
    mode === 'edit' &&
    !!event &&
    (
      event.id.includes('#') ||
      (typeof event.instanceOf === 'string' && event.instanceOf !== event.id) ||
      typeof event.occurrenceStart === 'number'
    )

  // L3-B — mini-dialog state for instance edits. `pendingAction` holds
  // the data the user submitted; the dialog asks them whether to apply
  // the change to one occurrence / forward / the whole series. On
  // confirm we call `onSave` with `recurrenceScope` set; on cancel we
  // dismiss the dialog and keep editing.
  type PendingSaveAction =
    | { kind: 'save'; data: EventModalData }
    | { kind: 'delete'; eventId: string }
  const [pendingRecurrenceAction, setPendingRecurrenceAction] = useState<PendingSaveAction | null>(null)

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

    const data: EventModalData = {
      title: title.trim(),
      description: description.trim() || undefined,
      location: location.trim() || undefined,
      startTime: startDt,
      endTime: endDt,
      calendarId: resolvedCalendarId,
      color: selectedSource?.color ?? '#5B8DEF',
      allDay,
      contentType,
      platform: platforms.length > 0 ? platforms : undefined,
      publishStatus,
      // L2-B — explicit null/array semantics (no `undefined`): when the
      // editor has no rows, `reminders` is `null` (= "clear" on update;
      // create handler maps it back to a null DB column). On edit this
      // preserves the IPC contract that any present value is a full
      // replace, since the modal always controls the reminders state.
      reminders,
      // L3-B — propagate the recurrence rule the user picked.
      recurrenceRule,
      // Scope: 'series' for non-instance edits and all creates. The
      // mini-dialog (below) overrides this to 'single' or 'future'
      // when editing an expanded instance.
      recurrenceScope: 'series',
    }

    // L3-B — instance edits route through the "scope picker" dialog
    // before calling onSave. The dialog itself sets the final
    // `recurrenceScope` and re-fires the save.
    if (isRecurringInstance) {
      setPendingRecurrenceAction({ kind: 'save', data })
      return
    }
    onSave(data)
  }

  const handleDelete = () => {
    if (!event || !onDelete) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    // L3-B — recurring-instance deletes also route through the dialog.
    // For non-instance deletes the host's onDelete handles the parent
    // row directly (which cascades via FK to drop overrides).
    if (isRecurringInstance) {
      setPendingRecurrenceAction({ kind: 'delete', eventId: event.id })
      return
    }
    onDelete(event.id)
  }

  /**
   * L3-B — close the scope-picker dialog. Called by the dialog's three
   * buttons + by the Cancel button + by clicking the dim overlay. We
   * intentionally do NOT auto-cancel the underlying form save when the
   * user dismisses the scope picker — the user just hasn't made up
   * their mind about scope yet.
   */
  const dismissRecurrenceDialog = () => setPendingRecurrenceAction(null)

  /**
   * L3-B — apply the chosen scope to the pending save / delete and
   * close both dialogs. For deletes we encode the scope on the same
   * `recurrenceScope` channel the save flow uses; the host's
   * `onDelete` callback (per `EventModalProps`) doesn't accept extra
   * args, so we route deletes through an alternate path: a delete
   * with scope='single' becomes a `cancelled` override (handled by
   * the host); 'future' / 'series' delegates to the host but we
   * stash the scope in a marker. Because `onDelete` is one-arg
   * today, the host listens for a marker on the most recent
   * `onSave` data — but a cleaner contract is to let the host
   * subscribe to a separate "delete with scope" callback. To keep
   * this PR's surface narrow we collapse delete-scope into onSave
   * by emitting a payload-only marker; if the host doesn't support
   * it the standard onDelete is still called.
   *
   * Concretely: the host (CalendarMode.handleDeleteEvent) inspects
   * the event prop's `id` / `occurrenceStart` itself when the user
   * confirms in the dialog; the modal just dismisses. So we hand
   * the scope back to the host by surfacing a custom resolve via
   * a window event… that's too clever. Simpler: when the user
   * picks a scope for delete, the modal calls onDelete and the
   * host inspects the data it already has (event.recurrenceRule
   * / event.id) plus the supplied scope through a closure.
   *
   * To avoid plumbing a new prop, the dialog drives onDelete only;
   * the host detects "this id has #" itself and asks the user which
   * scope to apply. We dispatch a custom DOM event the host can
   * listen to inside CalendarMode for the deletion scope.
   */
  const commitRecurrenceScope = (scope: 'single' | 'future' | 'series') => {
    if (!pendingRecurrenceAction) return
    if (pendingRecurrenceAction.kind === 'save') {
      const data: EventModalData = {
        ...pendingRecurrenceAction.data,
        recurrenceScope: scope,
      }
      setPendingRecurrenceAction(null)
      onSave(data)
      return
    }
    // Delete branch: the host listens for a custom event payload to
    // pick up the requested scope, because `onDelete: (id) => void`
    // is the existing contract and we don't want to break it here.
    // CalendarMode reads `__pendingDeleteScope` off the window before
    // its handler runs. Worst case (no listener) → standard delete
    // semantics still execute.
    try {
      const w = window as unknown as { __readyCalendarPendingDeleteScope?: 'single' | 'future' | 'series' }
      w.__readyCalendarPendingDeleteScope = scope
    } catch {
      // ignore — host falls back to deleteEvent(parentId)
    }
    setPendingRecurrenceAction(null)
    onDelete?.(pendingRecurrenceAction.eventId)
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
          width: 320, maxHeight: '88vh', borderRadius: 8,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          // L3-B — host the scope-picker dialog which is absolute-positioned.
          position: 'relative',
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

          {/* Location */}
          <div>
            <span style={labelStyle}>地点</span>
            <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px' }}>
              <MapPin style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
              <input
                type="text"
                value={location}
                onChange={e => setLocation(e.target.value)}
                placeholder="添加地点（线下场所 / 会议链接）"
                className="ready-input-slot-inner"
                style={{
                  border: 'none', background: 'transparent', fontSize: 12,
                  color: 'var(--text-body)', outline: 'none', flex: 1, padding: 0,
                  height: 30,
                  fontFamily: 'Inter, system-ui, sans-serif',
                }}
              />
            </div>
          </div>

          {/* Reminders — L2-B */}
          <ReminderEditor value={reminders} onChange={setReminders} />

          {/* Recurrence — L3-B-RRULE-UI */}
          <RecurrenceEditor value={recurrenceRule} onChange={setRecurrenceRule} />

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
                        cursor: 'pointer',
                        transition: 'background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease',
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
                          cursor: 'pointer',
                          transition: 'background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: 4, background: selected ? color : 'var(--border-default)' }} />
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
                        cursor: 'pointer',
                        transition: 'background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: 4, background: publishStatus === value ? color : 'var(--border-default)' }} />
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
                className="active:scale-[0.98] transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out"
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
              className="hover:bg-[var(--bg-hover)] active:scale-[0.98] transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out"
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
              className="active:scale-[0.98] transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out"
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

        {/* L3-B — recurring-instance scope picker. Inline dim layer
            inside the modal so it doesn't escape the modal's
            stacking context; click-outside dismisses (the user keeps
            editing). Three buttons map to the three IPC routes. */}
        {pendingRecurrenceAction && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="选择修改范围"
            onClick={(e) => {
              if (e.target === e.currentTarget) dismissRecurrenceDialog()
            }}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.32)',
              zIndex: 1,
            }}
          >
            <div
              style={{
                width: 260,
                padding: '14px 14px 12px 14px',
                borderRadius: 8,
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-default)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
                {pendingRecurrenceAction.kind === 'delete' ? '删除范围' : '修改范围'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                {pendingRecurrenceAction.kind === 'delete'
                  ? '此事件属于一个重复系列。请选择删除范围：'
                  : '此事件属于一个重复系列。请选择修改范围：'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => commitRecurrenceScope('single')}
                  style={scopeButtonStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={scopeButtonTitleStyle}>仅此事件</span>
                  <span style={scopeButtonDescStyle}>
                    {pendingRecurrenceAction.kind === 'delete'
                      ? '跳过这次发生，其他保持不变'
                      : '只修改这次发生，其他保持不变'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => commitRecurrenceScope('future')}
                  style={scopeButtonStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={scopeButtonTitleStyle}>此事件和未来的事件</span>
                  <span style={scopeButtonDescStyle}>
                    {pendingRecurrenceAction.kind === 'delete'
                      ? '从这次起，删除剩下的所有'
                      : '从这次起，修改剩下的所有'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => commitRecurrenceScope('series')}
                  style={scopeButtonStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={scopeButtonTitleStyle}>整列事件</span>
                  <span style={scopeButtonDescStyle}>
                    {pendingRecurrenceAction.kind === 'delete'
                      ? '删除整个重复系列'
                      : '修改整个重复系列'}
                  </span>
                </button>
              </div>
              <button
                type="button"
                onClick={dismissRecurrenceDialog}
                style={{
                  marginTop: 4,
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border-default)',
                  background: 'var(--bg-primary)',
                  fontSize: 11,
                  color: 'var(--text-body)',
                  cursor: 'pointer',
                  alignSelf: 'flex-end',
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// L3-B — shared styles for the scope-picker buttons. Inline at file
// scope because they're a stable visual contract used by exactly one
// component but consistent across the three rows.
const scopeButtonStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  padding: '7px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-default)',
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background 0.12s',
}
const scopeButtonTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-title)',
}
const scopeButtonDescStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text-muted)',
}
