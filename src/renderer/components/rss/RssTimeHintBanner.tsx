import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarPlus, X } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { Input, Select } from '../ui/Field'
import { Chip } from '../ui/Display'
import { closeFloat, openFloat } from '../ui/float/float-store'
import { stripHtml } from '../../utils/strip-html'
import { dayOf, isoDate, newId, systemTimeZone, type Calendar } from '../../../shared/calendar'

/**
 * L5-B — banner chip + dialog (a float of the shared host, W1 §5) that surfaces the time expressions
 * detected in the currently-selected RSS item and lets the user create
 * a calendar event from one of them. Renderer-only; the chrono-node
 * detector lives in main and is reached via
 * `window.electronAPI.calendar.detectTimeExpressions(...)`.
 *
 * Design rules (per CLAUDE.md §6.9 / §0.5.5):
 *   - The detector NEVER triggers live-info intent classification —
 *     this component only reads `item.title + item.summary + item.author`
 *     locally and shows a chip. It does not write to chat, intent
 *     classifiers, or browser-task planners.
 *   - Confidence-low matches ("稍后", "soon" …) are filtered out so the
 *     UX doesn't fire on vague phrases.
 *   - When the main IPC returns `mock: true` the component renders
 *     nothing — the mock path returns an empty list anyway.
 *   - Failures are silent (console.warn only). The hint is opt-in
 *     value-add; a broken detection must not block reading.
 */

interface DetectedExpression {
  text: string
  startIndex: number
  endIndex: number
  startTime: number
  endTime: number
  hasTime: boolean
  confidence: 'high' | 'medium' | 'low'
  locale: 'en' | 'zh'
}

interface RssTimeHintBannerProps {
  /** Article id — used to invalidate detection state when the user
   *  switches to a different item. */
  itemId: string
  /** Headline. Used both as the detection input and the default event
   *  title in the modal. */
  title: string
  /** Optional article summary or excerpt (may contain raw HTML; we
   *  strip it before passing to the detector). */
  summary?: string | null
  /** Optional author / source byline; appended to detection input
   *  because some bylines carry dates ("Posted on May 17 …"). */
  author?: string | null
  /** ISO timestamp of when the article was published. We do NOT use
   *  it as the chrono reference date by default (the user reads
   *  "tomorrow" with respect to NOW, not the article's publish day);
   *  it is purely informational. */
  publishedAt?: string | null
}

function formatStart(unixSeconds: number, hasTime: boolean): string {
  const date = new Date(unixSeconds * 1000)
  if (hasTime) {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function toLocalDatetimeInputValue(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const min = pad(d.getMinutes())
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

function fromLocalDatetimeInputValue(value: string): number | null {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return Math.floor(parsed.getTime() / 1000)
}

export default function RssTimeHintBanner({
  itemId,
  title,
  summary,
  author,
}: RssTimeHintBannerProps) {
  const [expressions, setExpressions] = useState<DetectedExpression[]>([])
  const dialogRef = useRef<string | null>(null)

  // Cancellation guard for the async detection request — we don't want
  // a stale reply for a previous article to clobber the current state
  // when the user clicks through rapidly.
  const detectionGenRef = useRef(0)

  const closeDialog = useCallback(() => {
    if (dialogRef.current) closeFloat(dialogRef.current, true)
    dialogRef.current = null
  }, [])

  useEffect(() => {
    const myGen = ++detectionGenRef.current
    setExpressions([])
    closeDialog()
    const api = window.electronAPI?.calendar
    if (!api || typeof api.detectTimeExpressions !== 'function') return
    const combined = [title, stripHtml(summary), author].filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n')
    if (combined.length === 0) return
    void api.detectTimeExpressions({ text: combined }).then(
      (res) => {
        if (detectionGenRef.current !== myGen) return
        if (!res || !res.success || res.mock || !Array.isArray(res.data)) return
        setExpressions(res.data.filter((e) => e.confidence !== 'low'))
      },
      (err) => {
        if (detectionGenRef.current !== myGen) return
        // Silent failure per design — surface to the dev console only.
        console.warn('[RssTimeHintBanner] detectTimeExpressions failed:', err)
      },
    )
  }, [itemId, title, summary, author, closeDialog])

  useEffect(() => closeDialog, [closeDialog])

  const previewTexts = useMemo(() => expressions.slice(0, 3).map((e) => `“${e.text}”`).join(' · '), [
    expressions,
  ])

  const handleOpen = useCallback(() => {
    dialogRef.current = openFloat({
      anchor: { left: 0, top: 0, right: 0, bottom: 0 },
      placement: 'center',
      modal: true,
      role: 'dialog',
      label: '创建日程',
      className: 'rn-dialog rss-time-hint-modal',
      onClose: () => { dialogRef.current = null },
      render: (close) => <TimeHintDialog expressions={expressions} articleTitle={title} close={close} />,
    })
  }, [expressions, title])

  if (expressions.length === 0) return null

  return (
    <Chip
      icon={<CalendarPlus />}
      onClick={handleOpen}
      className="rss-time-hint-chip"
      title={`识别到 ${expressions.length} 个时间表达式 — 点击创建日程`}
    >
      <span className="rss-time-hint-chip__text">
        识别到 {expressions.length} 个时间 · {previewTexts || '点击创建日程'}
      </span>
    </Chip>
  )
}

function TimeHintDialog({ expressions, articleTitle, close }: { expressions: DetectedExpression[]; articleTitle: string; close: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [eventTitle, setEventTitle] = useState(articleTitle)
  const [sources, setSources] = useState<Calendar[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState(false)
  const selected = expressions[selectedIndex] ?? null
  const [editedStartSeconds, setEditedStartSeconds] = useState<number | null>(null)
  const [editedEndSeconds, setEditedEndSeconds] = useState<number | null>(null)

  // Load calendar sources once the dialog opens, so we don't pay the IPC round-trip for every article preview.
  useEffect(() => {
    const api = window.electronAPI?.calendar
    if (!api) return
    let live = true
    void api.snapshot().then(
      (res) => {
        if (!live || !res.success || !res.data) return
        const writable = res.data.calendars.filter(source => !source.readOnly)
        setSources(writable)
        if (writable.length > 0) setSelectedSourceId((current) => current || (writable.find(source => source.primary) || writable[0]).id)
      },
      (err) => {
        console.warn('[RssTimeHintBanner] snapshot failed:', err)
      },
    )
    return () => { live = false }
  }, [])

  useEffect(() => {
    setEditedStartSeconds(selected ? selected.startTime : null)
    setEditedEndSeconds(selected ? selected.endTime : null)
  }, [selected])

  const handleSubmit = async () => {
    const api = window.electronAPI?.calendar
    if (!api) return
    if (!selected) return
    if (selectedSourceId === '') {
      setSubmitError('请选择日历')
      return
    }
    if (eventTitle.trim().length === 0) {
      setSubmitError('请填写事件标题')
      return
    }
    const startSeconds = editedStartSeconds ?? selected.startTime
    let endSeconds = editedEndSeconds ?? selected.endTime
    if (endSeconds <= startSeconds) endSeconds = startSeconds + 3600
    setSubmitting(true)
    setSubmitError(null)
    try {
      const id = newId('event'), now = Date.now(), timeZone = systemTimeZone(), allDay = !selected.hasTime
      const res = await api.mutate({type: 'create', event: {
        id, uid: `${id}@ready.local`, createdAt: now, updatedAt: now, timeZone,
        calendarId: selectedSourceId,
        title: eventTitle.trim(),
        start: allDay ? isoDate(dayOf(startSeconds * 1000, timeZone)) : startSeconds * 1000,
        end: allDay ? isoDate(dayOf((endSeconds - 1) * 1000, timeZone) + 1) : endSeconds * 1000,
        allDay, status: 'confirmed', transparency: allDay ? 'transparent' : 'opaque',
        description: `From RSS · 来自文章：${articleTitle}`,
      }}, {})
      if (!res || !res.success) {
        setSubmitError(res?.error ?? '创建失败')
        return
      }
      setSubmitSuccess(true)
      window.setTimeout(close, 1200)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSubmitError(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rss-time-hint">
      <div className="rss-add-source__header">
        <h2 className="rn-dialog__title">创建日程</h2>
        <IconButton size="sm" icon={<X />} title="关闭" onClick={close} />
      </div>

      <label className="rss-add-source__field">
        <span>识别到的时间</span>
        <Select
          value={String(selectedIndex)}
          onChange={(e) => setSelectedIndex(Number(e.target.value))}
          options={expressions.map((expr, i) => ({
            value: String(i),
            label: `“${expr.text}” → ${formatStart(expr.startTime, expr.hasTime)}${expr.confidence === 'high' ? '' : ' (待确认)'}`,
          }))}
        />
      </label>

      <label className="rss-add-source__field">
        <span>事件标题</span>
        <Input type="text" value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} data-autofocus />
      </label>

      <div className="rss-time-hint__times">
        <label className="rss-add-source__field">
          <span>开始时间</span>
          <Input
            type="datetime-local"
            value={editedStartSeconds !== null ? toLocalDatetimeInputValue(editedStartSeconds) : ''}
            onChange={(e) => {
              const next = fromLocalDatetimeInputValue(e.target.value)
              if (next !== null) setEditedStartSeconds(next)
            }}
          />
        </label>
        <label className="rss-add-source__field">
          <span>结束时间</span>
          <Input
            type="datetime-local"
            value={editedEndSeconds !== null ? toLocalDatetimeInputValue(editedEndSeconds) : ''}
            onChange={(e) => {
              const next = fromLocalDatetimeInputValue(e.target.value)
              if (next !== null) setEditedEndSeconds(next)
            }}
          />
        </label>
      </div>

      <label className="rss-add-source__field">
        <span>日历</span>
        <Select
          value={selectedSourceId}
          onChange={(e) => setSelectedSourceId(e.target.value)}
          disabled={sources.length === 0}
          options={sources.length === 0 ? [{ value: '', label: '(加载中…)' }] : sources.map((s) => ({ value: s.id, label: s.name }))}
        />
      </label>

      {submitError && <p className="rss-time-hint__status" data-tone="bad" role="alert">{submitError}</p>}
      {submitSuccess && <p className="rss-time-hint__status" role="status">已创建</p>}

      <div className="rn-dialog__actions">
        <Button variant="ghost" onClick={close}>取消</Button>
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={submitting || submitSuccess || sources.length === 0}>
          {submitting ? '创建中…' : '创建日程'}
        </Button>
      </div>
    </div>
  )
}
