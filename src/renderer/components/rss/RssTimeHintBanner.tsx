import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarPlus, X } from 'lucide-react'
import { stripHtml } from '../../utils/strip-html'

/**
 * L5-B — banner chip + modal that surfaces the time expressions
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

interface CalendarSource {
  id: string
  name: string
  color: string
  enabled: boolean
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
  const [open, setOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [eventTitle, setEventTitle] = useState(title)
  const [sources, setSources] = useState<CalendarSource[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState(false)

  // Cancellation guard for the async detection request — we don't want
  // a stale reply for a previous article to clobber the current state
  // when the user clicks through rapidly.
  const detectionGenRef = useRef(0)

  useEffect(() => {
    const myGen = ++detectionGenRef.current
    setExpressions([])
    setOpen(false)
    setSelectedIndex(0)
    setSubmitError(null)
    setSubmitSuccess(false)
    const api = window.electronAPI?.calendar
    if (!api || typeof api.detectTimeExpressions !== 'function') return
    const combined = [title, stripHtml(summary), author].filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n')
    if (combined.length === 0) return
    void api.detectTimeExpressions({ text: combined }).then(
      (res) => {
        if (detectionGenRef.current !== myGen) return
        if (!res || !res.success || res.mock || !Array.isArray(res.data)) return
        const filtered = res.data.filter((e) => e.confidence !== 'low')
        setSelectedIndex(0)
        setExpressions(filtered)
      },
      (err) => {
        if (detectionGenRef.current !== myGen) return
        // Silent failure per design — surface to the dev console only.
        console.warn('[RssTimeHintBanner] detectTimeExpressions failed:', err)
      },
    )
  }, [itemId, title, summary, author])

  // Keep the editable event title in sync when the user changes
  // article (it pre-fills with the headline, but they can still edit
  // it in the modal).
  useEffect(() => {
    setEventTitle(title)
  }, [title])

  // Load calendar sources lazily — only when the modal first opens —
  // so we don't pay the IPC round-trip for every article preview.
  useEffect(() => {
    if (!open) return
    if (sources.length > 0) return
    const api = window.electronAPI?.calendar
    if (!api || typeof api.getSources !== 'function') return
    void api.getSources().then(
      (res) => {
        if (!res || !res.success || !Array.isArray(res.data)) return
        const enabled = (res.data as CalendarSource[]).filter((s) => s.enabled !== false)
        setSources(enabled)
        if (enabled.length > 0 && selectedSourceId === '') {
          setSelectedSourceId(enabled[0].id)
        }
      },
      (err) => {
        console.warn('[RssTimeHintBanner] getSources failed:', err)
      },
    )
  }, [open, sources.length, selectedSourceId])

  const previewTexts = useMemo(() => expressions.slice(0, 3).map((e) => `“${e.text}”`).join(' · '), [
    expressions,
  ])

  const selected = expressions[selectedIndex] ?? null
  const [editedStartSeconds, setEditedStartSeconds] = useState<number | null>(null)
  const [editedEndSeconds, setEditedEndSeconds] = useState<number | null>(null)

  useEffect(() => {
    if (!selected) {
      setEditedStartSeconds(null)
      setEditedEndSeconds(null)
      return
    }
    setEditedStartSeconds(selected.startTime)
    setEditedEndSeconds(selected.endTime)
  }, [selected])

  const handleOpen = useCallback(() => {
    setOpen(true)
    setSelectedIndex(0)
    setSubmitError(null)
    setSubmitSuccess(false)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
    setSubmitError(null)
  }, [])

  const handleSubmit = useCallback(async () => {
    const api = window.electronAPI?.calendar
    if (!api || typeof api.createEvent !== 'function') return
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
      const res = await api.createEvent({
        calendarId: selectedSourceId,
        title: eventTitle.trim(),
        startTime: new Date(startSeconds * 1000).toISOString(),
        endTime: new Date(endSeconds * 1000).toISOString(),
        allDay: !selected.hasTime,
        description: `From RSS · 来自文章：${title}`,
      })
      if (!res || !res.success) {
        setSubmitError(res?.error ?? '创建失败')
        return
      }
      setSubmitSuccess(true)
      window.setTimeout(() => {
        setOpen(false)
      }, 1200)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSubmitError(message)
    } finally {
      setSubmitting(false)
    }
  }, [
    selected,
    selectedSourceId,
    eventTitle,
    editedStartSeconds,
    editedEndSeconds,
    title,
  ])

  if (expressions.length === 0) return null

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="rss-time-hint-chip flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors hover:bg-black/5"
        style={{
          background: 'color-mix(in srgb, var(--color-blue) 12%, transparent)',
          color: 'var(--color-blue)',
          border: '1px solid color-mix(in srgb, var(--color-blue) 28%, transparent)',
        }}
        title={`识别到 ${expressions.length} 个时间表达式 — 点击创建日程`}
      >
        <CalendarPlus className="w-3.5 h-3.5" strokeWidth={2} />
        <span className="truncate max-w-[260px]">
          识别到 {expressions.length} 个时间 · {previewTexts || '点击创建日程'}
        </span>
      </button>

      {open && (
        <div
          className="rss-time-hint-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.36)' }}
          onClick={handleClose}
        >
          <div
            className="rss-time-hint-modal glass-surface-panel rounded-xl p-5 max-w-[560px] w-[92%]"
            style={{
              background: 'var(--surface-card-bg)',
              border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-lg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[15px] font-semibold text-[var(--text-title)]">
                创建日程
              </h3>
              <button
                onClick={handleClose}
                className="p-1 rounded hover:bg-black/5"
                aria-label="关闭"
              >
                <X className="w-4 h-4 text-[var(--text-muted)]" />
              </button>
            </div>

            <label className="block mb-3">
              <span className="block text-[11px] text-[var(--text-muted)] mb-1">识别到的时间</span>
              <select
                value={selectedIndex}
                onChange={(e) => setSelectedIndex(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 rounded-md text-[13px]"
                style={{
                  background: 'var(--bg-content)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-body)',
                }}
              >
                {expressions.map((expr, i) => (
                  <option key={`${expr.startIndex}:${expr.text}`} value={i}>
                    “{expr.text}” → {formatStart(expr.startTime, expr.hasTime)}
                    {expr.confidence === 'high' ? '' : ' (待确认)'}
                  </option>
                ))}
              </select>
            </label>

            <label className="block mb-3">
              <span className="block text-[11px] text-[var(--text-muted)] mb-1">事件标题</span>
              <input
                type="text"
                value={eventTitle}
                onChange={(e) => setEventTitle(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-md text-[13px]"
                style={{
                  background: 'var(--bg-content)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-body)',
                }}
              />
            </label>

            <div className="flex gap-2 mb-3">
              <label className="block flex-1">
                <span className="block text-[11px] text-[var(--text-muted)] mb-1">开始时间</span>
                <input
                  type="datetime-local"
                  value={editedStartSeconds !== null ? toLocalDatetimeInputValue(editedStartSeconds) : ''}
                  onChange={(e) => {
                    const next = fromLocalDatetimeInputValue(e.target.value)
                    if (next !== null) setEditedStartSeconds(next)
                  }}
                  className="w-full px-2 py-1.5 rounded-md text-[12px]"
                  style={{
                    background: 'var(--bg-content)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-body)',
                  }}
                />
              </label>
              <label className="block flex-1">
                <span className="block text-[11px] text-[var(--text-muted)] mb-1">结束时间</span>
                <input
                  type="datetime-local"
                  value={editedEndSeconds !== null ? toLocalDatetimeInputValue(editedEndSeconds) : ''}
                  onChange={(e) => {
                    const next = fromLocalDatetimeInputValue(e.target.value)
                    if (next !== null) setEditedEndSeconds(next)
                  }}
                  className="w-full px-2 py-1.5 rounded-md text-[12px]"
                  style={{
                    background: 'var(--bg-content)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-body)',
                  }}
                />
              </label>
            </div>

            <label className="block mb-4">
              <span className="block text-[11px] text-[var(--text-muted)] mb-1">日历</span>
              <select
                value={selectedSourceId}
                onChange={(e) => setSelectedSourceId(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-md text-[13px]"
                style={{
                  background: 'var(--bg-content)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-body)',
                }}
                disabled={sources.length === 0}
              >
                {sources.length === 0 ? (
                  <option value="">(加载中…)</option>
                ) : (
                  sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))
                )}
              </select>
            </label>

            {submitError && (
              <div className="mb-3 text-[12px] text-[var(--color-red, #dc2626)]">{submitError}</div>
            )}
            {submitSuccess && (
              <div className="mb-3 text-[12px]" style={{ color: 'var(--color-green, #10b981)' }}>已创建</div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-3 py-1.5 rounded-md text-[12px] hover:bg-black/5"
                style={{ color: 'var(--text-muted)' }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || submitSuccess || sources.length === 0}
                className="px-3 py-1.5 rounded-md text-[12px] text-white"
                style={{
                  background: 'var(--color-blue)',
                  opacity: submitting || submitSuccess || sources.length === 0 ? 0.6 : 1,
                  cursor: submitting || submitSuccess || sources.length === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {submitting ? '创建中…' : '创建日程'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
