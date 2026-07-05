/**
 * D5 — 终态任务卡的 per-run 评分控件（1-5 星）。
 *
 * 提交只带 taskId：权威 runId 由 main 侧从 task projection 解析（重试后
 * 反馈落最新 run）。同一 run 复交为修改（fb_<runId> upsert 槽）。挂载时
 * 按 taskId 回读最近一条反馈以恢复已评分状态。
 */
import { useEffect, useRef, useState } from 'react'
import { IconStar, IconStarFilled } from '@tabler/icons-react'

const STAR_SIZE = 13

export function RunFeedbackStars({ taskId }: { taskId: string }) {
  const [rating, setRating] = useState<1 | 2 | 3 | 4 | 5 | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)
  const mountedRef = useRef(true)

  const api = typeof window !== 'undefined' ? window.electronAPI?.runFeedback : undefined

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!api) return
    let cancelled = false
    api.list({ taskId, limit: 1 })
      .then((result) => {
        if (cancelled || !mountedRef.current) return
        const record = result.success ? result.data?.[0] : null
        if (record && typeof record.rating === 'number') {
          setRating(record.rating)
        }
      })
      .catch(() => { /* 回读失败不阻塞评分 — 提交路径自带错误态 */ })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  if (!api) return null

  const submit = async (value: 1 | 2 | 3 | 4 | 5) => {
    if (submitting) return
    setSubmitting(true)
    setFailed(false)
    try {
      const result = await api.submit({ taskId, rating: value })
      if (!mountedRef.current) return
      if (result.success) {
        setRating(value)
      } else {
        setFailed(true)
      }
    } catch {
      // silent-catch: submit failure surfaces as the failed UI state
      if (mountedRef.current) setFailed(true)
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }

  const activeUpTo = hovered ?? rating ?? 0

  return (
    <div
      data-ready-run-feedback="true"
      data-ready-run-feedback-task-id={taskId}
      data-ready-run-feedback-rating={rating ?? undefined}
      className="flex items-center gap-2"
      style={{ paddingTop: 2 }}
      onMouseLeave={() => setHovered(null)}
    >
      <span className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-light)' }}>
        {failed ? '评分未保存，点击重试' : rating ? '已评分' : '评价本次运行'}
      </span>
      <div className="flex items-center" style={{ gap: 2 }}>
        {([1, 2, 3, 4, 5] as const).map((value) => {
          const filled = value <= activeUpTo
          const StarIcon = filled ? IconStarFilled : IconStar
          return (
            <button
              key={value}
              type="button"
              data-ready-run-feedback-star={value}
              aria-label={`评分 ${value} 星`}
              disabled={submitting}
              onMouseEnter={() => setHovered(value)}
              onFocus={() => setHovered(value)}
              onBlur={() => setHovered(null)}
              onClick={() => submit(value)}
              style={{
                border: 'none',
                background: 'transparent',
                padding: 2,
                margin: 0,
                cursor: submitting ? 'default' : 'pointer',
                lineHeight: 0,
                opacity: submitting ? 0.6 : 1,
              }}
            >
              <StarIcon
                style={{
                  width: STAR_SIZE,
                  height: STAR_SIZE,
                  color: filled ? 'var(--color-amber, #e8a33d)' : 'var(--text-light)',
                }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
