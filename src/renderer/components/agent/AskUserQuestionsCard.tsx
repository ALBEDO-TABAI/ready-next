/**
 * Renders an `ask_user_questions` card inline in the chat stream.
 *
 * Pending: one question visible at a time. All `questions` are pre-rendered
 * into local state so the back/forward arrows feel instant — only the
 * `currentIndex` slot changes when the user advances. Submit is only enabled
 * once every `required` question has an answer.
 *
 * Submitted / cancelled / timeout: collapsed summary line; click to expand
 * the full Q/A list. The summary stays in chat history permanently.
 *
 * Tone matches Ready's existing capsule styling (mirrors SkillAskUserPrompt
 * tokens) but adapted for inline placement — no fixed positioning, no z-index
 * boost.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Check, AlertCircle } from 'lucide-react'

import type { AskUserQuestionsCardState } from '../../modules/agent/types'
import { renderInline } from './chat-panel/markdown'

interface AskUserQuestionsCardProps {
  card: AskUserQuestionsCardState
  onSubmit: (cardId: string, answers: Array<{ id: string; answer: string | string[] }>) => Promise<{
    success: boolean
    error?: string
  }>
  onCancel: (cardId: string, reason?: string) => Promise<{ success: boolean; error?: string }>
}

type AnswerMap = Record<string, string | string[]>

function isQuestionAnswered(
  question: AskUserQuestionsCardState['questions'][number],
  answers: AnswerMap,
): boolean {
  const value = answers[question.id]
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return false
}

/**
 * Stage U (PR 1) — `cancelReason` → 中文展示文案。新增的 cancelReason
 * 来源详见 `error-kinds.ts` 与 `ipc-handler.ts`。未知 reason 走 fallback
 * 文案，避免 `default-cancelled` UI 出现裸的英文 reason 字符串。
 */
function cancelHeadlineFromReason(reason?: string): string {
  switch (reason) {
    case 'user_typed_instead': return '已用新消息替代（跳过）'
    case 'user_cancelled': return '已取消'
    case 'app_restart': return '已取消（应用已重启）'
    case 'session_reset': return '已取消（会话已重置）'
    case 'card_resolver_missed': return '已取消（系统状态不一致，答案未送达模型）'
    case 'cancel_persist_failed': return '已取消（服务端记录失败，重启后会自动清理）'
    case 'card_row_missing': return '已取消（卡片已被会话清理）'
    case undefined: return '已取消'
    default: return '已取消'
  }
}

function buildInitialAnswers(card: AskUserQuestionsCardState): AnswerMap {
  if (card.status === 'submitted' && Array.isArray(card.answers)) {
    const out: AnswerMap = {}
    for (const a of card.answers) out[a.id] = a.answer
    return out
  }
  const out: AnswerMap = {}
  for (const q of card.questions) {
    if (q.kind === 'multi_choice') out[q.id] = []
    else out[q.id] = ''
  }
  return out
}

export function AskUserQuestionsCard({ card, onSubmit, onCancel }: AskUserQuestionsCardProps): ReactElement {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<AnswerMap>(() => buildInitialAnswers(card))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandSummary, setExpandSummary] = useState(false)

  // If the card mutates (e.g. status flips from pending to submitted via push),
  // re-seed the answer map so the collapsed view reflects what shipped.
  useEffect(() => {
    setAnswers(buildInitialAnswers(card))
    setError(null)
    setIsSubmitting(false)
    setIsCancelling(false)
    if (card.status !== 'pending') {
      setExpandSummary(false)
    }
  }, [card.cardId, card.status])

  const isPending = card.status === 'pending'
  const totalQuestions = card.questions.length
  const safeIndex = Math.min(Math.max(currentIndex, 0), Math.max(totalQuestions - 1, 0))
  const currentQ = card.questions[safeIndex]

  const allRequiredAnswered = useMemo(() => {
    return card.questions.every((q) => !q.required || isQuestionAnswered(q, answers))
  }, [card.questions, answers])
  const answeredCount = useMemo(() => {
    return card.questions.filter((q) => isQuestionAnswered(q, answers)).length
  }, [card.questions, answers])

  const canGoBack = safeIndex > 0
  const canGoForward = safeIndex < totalQuestions - 1
  // Stage U (PR 1, B.5) — `localDisabled` is the pre-send cancel hook saying
  // "an in-flight cancel for this card timed out; do not allow submit until
  // the late cancel result lands". We keep status:'pending' so the card UI
  // shape doesn't jump, but the submit button is greyed and a hint is shown.
  const localDisabled = card.localDisabled === true
  const canSubmit = isPending && allRequiredAnswered && !localDisabled

  const setAnswer = useCallback((id: string, value: string | string[]) => {
    setAnswers((prev) => ({ ...prev, [id]: value }))
  }, [])

  const handleSelectOption = useCallback((q: AskUserQuestionsCardState['questions'][number], option: string) => {
    if (q.kind === 'single_choice') {
      setAnswer(q.id, option)
    } else if (q.kind === 'multi_choice') {
      const currentVal = Array.isArray(answers[q.id]) ? [...(answers[q.id] as string[])] : []
      const idx = currentVal.indexOf(option)
      if (idx >= 0) currentVal.splice(idx, 1)
      else currentVal.push(option)
      setAnswer(q.id, currentVal)
    }
  }, [answers, setAnswer])

  const handleFreeTextChange = useCallback((q: AskUserQuestionsCardState['questions'][number], value: string) => {
    setAnswer(q.id, value)
  }, [setAnswer])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setError(null)
    const payload: Array<{ id: string; answer: string | string[] }> = []
    for (const q of card.questions) {
      const raw = answers[q.id]
      if (raw === undefined || raw === null) continue
      if (q.kind === 'multi_choice') {
        if (!Array.isArray(raw) || raw.length === 0) continue
        payload.push({ id: q.id, answer: raw })
        continue
      }
      const str = typeof raw === 'string' ? raw.trim() : (Array.isArray(raw) ? raw.join(', ') : '')
      if (!str) continue
      payload.push({ id: q.id, answer: str })
    }
    try {
      const result = await onSubmit(card.cardId, payload)
      if (!result.success) {
        setError(result.error || '提交失败')
      }
    } catch (submitErr) {
      setError(submitErr instanceof Error ? submitErr.message : '提交失败')
    } finally {
      setIsSubmitting(false)
    }
  }, [canSubmit, card.questions, card.cardId, answers, onSubmit])

  const handleCancel = useCallback(async () => {
    if (!isPending) return
    setIsCancelling(true)
    try {
      await onCancel(card.cardId, 'user_cancelled')
    } finally {
      setIsCancelling(false)
    }
  }, [card.cardId, isPending, onCancel])

  // Collapsed (submitted / cancelled / timeout) view.
  if (!isPending) {
    const headlineByStatus: Record<typeof card.status, string> = {
      pending: '等待回答',
      submitted: `已回复 ${card.answers?.length ?? 0}/${totalQuestions} 题`,
      cancelled: cancelHeadlineFromReason(card.cancelReason),
      timeout: '已超时（未回答）',
    }
    return (
      <div
        data-ready-ask-user-card={card.status}
        style={{
          width: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          color: 'var(--text-body)',
        }}
        role="group"
        aria-label={`反问卡片 ${card.cardId}`}
      >
        <button
          type="button"
          onClick={() => setExpandSummary((prev) => !prev)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'transparent',
            color: 'inherit',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontSize: 12.5,
            fontWeight: 600,
            width: '100%',
            minWidth: 0,
            textAlign: 'left',
          }}
        >
          {card.status === 'submitted'
            ? <Check size={14} color="var(--color-green, #16a34a)" />
            : <AlertCircle size={14} color="var(--text-light)" />}
          <span style={{ minWidth: 0 }}>{headlineByStatus[card.status]}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-light)', flexShrink: 0 }}>
            {expandSummary ? '收起' : '展开'}
          </span>
        </button>
        {expandSummary && (
          <ol
            data-ready-ask-user-summary-list="true"
            className="ready-ask-user-summary-list"
            style={{
              width: '100%',
              minWidth: 0,
              margin: '10px 0 0',
              padding: '0 0 0 22px',
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {card.questions.map((q) => {
              const answer = card.answers?.find((a) => a.id === q.id)
              const rendered = answer
                ? Array.isArray(answer.answer)
                  ? answer.answer.join(' / ')
                  : String(answer.answer)
                : '(未作答)'
              return (
                <li key={q.id} style={{ minWidth: 0, fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                  <div style={{ color: 'var(--text-body)' }}>{renderInline(q.question)}</div>
                  <div style={{ color: 'var(--text-gray)', fontStyle: answer ? 'normal' : 'italic' }}>→ {rendered}</div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    )
  }

  // Pending — active wizard.
  const selectedMulti = Array.isArray(answers[currentQ.id]) ? (answers[currentQ.id] as string[]) : []
  const selectedSingle = typeof answers[currentQ.id] === 'string' ? (answers[currentQ.id] as string) : ''
  const freeTextValue = typeof answers[currentQ.id] === 'string' ? (answers[currentQ.id] as string) : ''

  // Shared token palette aligned with task-card / info-card styling
  // (see ChatPanel.tsx:847-895). The card lives inline in the chat stream so
  // it adopts the same translucent panel surface and `--border-default`
  // outline; option chips re-use the same recipe at a lower mix percentage.
  const surfaceBg = 'color-mix(in srgb, var(--surface-card-bg) 26%, transparent)'
  const chipBgIdle = 'color-mix(in srgb, var(--surface-card-bg) 22%, transparent)'
  const chipBgHover = 'color-mix(in srgb, var(--surface-card-bg) 32%, transparent)'
  const chipBorderIdle = '1px solid var(--border-default)'
  const chipBgSelected = 'color-mix(in srgb, var(--color-blue) 12%, transparent)'
  const chipBorderSelected = '1px solid color-mix(in srgb, var(--color-blue) 32%, transparent)'

  return (
    <div
      data-ready-ask-user-card="pending"
      style={{
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        borderRadius: 12,
        padding: 14,
        border: '1px solid var(--border-default)',
        background: surfaceBg,
        color: 'var(--text-body)',
      }}
      role="dialog"
      aria-live="polite"
      aria-label="Agent 反问卡片"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-light)', fontWeight: 500 }}>
          Agent 反问 · {safeIndex + 1}/{totalQuestions}
        </span>
        <button
          type="button"
          onClick={handleCancel}
          disabled={isCancelling || isSubmitting}
          style={{
            background: 'transparent',
            color: 'var(--text-light)',
            border: 'none',
            fontSize: 11,
            cursor: isCancelling || isSubmitting ? 'not-allowed' : 'pointer',
          }}
        >
          跳过
        </button>
      </div>

      <div style={{ fontSize: 13.5, lineHeight: 1.55, marginBottom: 12, whiteSpace: 'pre-wrap', color: 'var(--text-body)' }}>
        {renderInline(currentQ.question)}
        {currentQ.required === false && (
          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-light)' }}>（可选）</span>
        )}
      </div>

      {currentQ.kind === 'single_choice' && currentQ.options && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {currentQ.options.map((option) => {
            const isSelected = selectedSingle === option
            return (
              <button
                key={option}
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSelectOption(currentQ, option)}
                onMouseEnter={(e) => { if (!isSelected && !isSubmitting) (e.currentTarget.style.background = chipBgHover) }}
                onMouseLeave={(e) => { if (!isSelected && !isSubmitting) (e.currentTarget.style.background = chipBgIdle) }}
                style={{
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: isSelected ? chipBorderSelected : chipBorderIdle,
                  background: isSelected ? chipBgSelected : chipBgIdle,
                  color: isSelected ? 'var(--color-blue)' : 'var(--text-body)',
                  fontSize: 12.5,
                  fontWeight: isSelected ? 600 : 500,
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  transition: 'background-color 120ms ease, border-color 120ms ease',
                }}
              >
                {option}
              </button>
            )
          })}
        </div>
      )}

      {currentQ.kind === 'multi_choice' && currentQ.options && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {currentQ.options.map((option) => {
            const isSelected = selectedMulti.includes(option)
            return (
              <button
                key={option}
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSelectOption(currentQ, option)}
                onMouseEnter={(e) => { if (!isSelected && !isSubmitting) (e.currentTarget.style.background = chipBgHover) }}
                onMouseLeave={(e) => { if (!isSelected && !isSubmitting) (e.currentTarget.style.background = chipBgIdle) }}
                style={{
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: isSelected ? chipBorderSelected : chipBorderIdle,
                  background: isSelected ? chipBgSelected : chipBgIdle,
                  color: isSelected ? 'var(--color-blue)' : 'var(--text-body)',
                  fontSize: 12.5,
                  fontWeight: isSelected ? 600 : 500,
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'background-color 120ms ease, border-color 120ms ease',
                }}
              >
                {isSelected && <Check size={12} />}
                {option}
              </button>
            )
          })}
        </div>
      )}

      {currentQ.kind === 'free_text' && (
        <textarea
          value={freeTextValue}
          onChange={(e) => handleFreeTextChange(currentQ, e.target.value)}
          placeholder={currentQ.placeholder || '请输入你的回答'}
          rows={3}
          disabled={isSubmitting}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--input-slot-border)',
            background: 'var(--input-slot-bg)',
            color: 'var(--text-body)',
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 12,
            outline: 'none',
            boxShadow: 'var(--input-slot-shadow)',
          }}
        />
      )}

      {error && (
        <div style={{ color: 'var(--color-red, #ef4444)', fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          disabled={!canGoBack || isSubmitting}
          onClick={() => setCurrentIndex(safeIndex - 1)}
          aria-label="上一题"
          title="上一题"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 8,
            border: '1px solid var(--border-default)',
            background: canGoBack && !isSubmitting ? chipBgIdle : 'transparent',
            color: 'var(--text-body)',
            opacity: canGoBack && !isSubmitting ? 1 : 0.35,
            cursor: canGoBack && !isSubmitting ? 'pointer' : 'not-allowed',
          }}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          disabled={!canGoForward || isSubmitting}
          onClick={() => setCurrentIndex(safeIndex + 1)}
          aria-label="下一题"
          title="下一题"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 8,
            border: '1px solid var(--border-default)',
            background: canGoForward && !isSubmitting ? chipBgIdle : 'transparent',
            color: 'var(--text-body)',
            opacity: canGoForward && !isSubmitting ? 1 : 0.35,
            cursor: canGoForward && !isSubmitting ? 'pointer' : 'not-allowed',
          }}
        >
          <ChevronRight size={16} />
        </button>

        <span style={{ fontSize: 11.5, color: 'var(--text-light)', marginLeft: 2 }}>
          已答 {answeredCount}/{totalQuestions}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {localDisabled && (
            <span style={{ fontSize: 11.5, color: 'var(--text-light)', fontStyle: 'italic' }}>
              取消处理中…
            </span>
          )}
          <button
            type="button"
            disabled={!canSubmit || isSubmitting}
            onClick={handleSubmit}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: canSubmit && !isSubmitting
                ? '1px solid var(--color-blue)'
                : '1px solid var(--border-default)',
              background: canSubmit && !isSubmitting
                ? 'var(--color-blue)'
                : chipBgIdle,
              color: canSubmit && !isSubmitting ? '#fff' : 'var(--text-light)',
              fontSize: 12.5,
              fontWeight: 600,
              cursor: canSubmit && !isSubmitting ? 'pointer' : 'not-allowed',
              transition: 'background-color 120ms ease, border-color 120ms ease',
            }}
          >
            {isSubmitting ? '提交中…' : localDisabled ? '已禁用' : '提交回答'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default AskUserQuestionsCard
