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
 * Built from the shared primitives on Ready's design tokens, adapted for inline
 * placement — no fixed positioning, no z-index boost.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Check, AlertCircle } from 'lucide-react'

import type { AskUserQuestionsCardState } from '../../modules/agent/types'
import { Button, Chip, IconButton, Textarea } from '../ui'
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
    case 'app_restart': return '已取消（连接中断，请重新发送）'
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seeds only when the card identity or status changes; depending on the whole card object would wipe in-progress answers whenever the parent passes a new object for the same pending card
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
          color: 'var(--rn-ink)',
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
            fontSize: 13,
            fontWeight: 500,
            width: '100%',
            minWidth: 0,
            textAlign: 'left',
          }}
        >
          {card.status === 'submitted'
            ? <Check size={14} color="var(--rn-ok)" />
            : <AlertCircle size={14} color="var(--rn-ink-3)" />}
          <span style={{ minWidth: 0 }}>{headlineByStatus[card.status]}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--rn-ink-3)', flexShrink: 0 }}>
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
                  <div style={{ color: 'var(--rn-ink)' }}>{renderInline(q.question)}</div>
                  <div style={{ color: 'var(--rn-ink-3)', fontStyle: answer ? 'normal' : 'italic' }}>→ {rendered}</div>
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

  // An inlay card on the assistant's glass (V2): thin glass and a .5px hairline, no panel. Options are the shared
  // Chip (a chosen option is pressed, in ink), the free answer is the shared Textarea, the pager is IconButton and
  // the one primary action is the ink Button (DL5: the signal colour is not a button colour).
  return (
    <div
      data-ready-ask-user-card="pending"
      style={{
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        borderRadius: 'var(--rn-r-card)',
        padding: 14,
        background: 'var(--rn-inlay)',
        boxShadow: 'inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2)',
        color: 'var(--rn-ink)',
      }}
      role="dialog"
      aria-live="polite"
      aria-label="Agent 反问卡片"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--rn-ink-3)', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
          Agent 反问 · {safeIndex + 1}/{totalQuestions}
        </span>
        <button
          type="button"
          onClick={handleCancel}
          disabled={isCancelling || isSubmitting}
          style={{
            background: 'transparent',
            color: 'var(--rn-ink-3)',
            border: 'none',
            fontSize: 11,
            cursor: isCancelling || isSubmitting ? 'not-allowed' : 'pointer',
          }}
        >
          跳过
        </button>
      </div>

      <div style={{ fontSize: 13, lineHeight: '20px', marginBottom: 12, whiteSpace: 'pre-wrap', color: 'var(--rn-ink)' }}>
        {renderInline(currentQ.question)}
        {currentQ.required === false && (
          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--rn-ink-3)' }}>（可选）</span>
        )}
      </div>

      {currentQ.kind === 'single_choice' && currentQ.options && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {currentQ.options.map((option) => (
            <Chip
              key={option}
              aria-pressed={selectedSingle === option}
              disabled={isSubmitting}
              onClick={() => handleSelectOption(currentQ, option)}
            >
              {option}
            </Chip>
          ))}
        </div>
      )}

      {currentQ.kind === 'multi_choice' && currentQ.options && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {currentQ.options.map((option) => {
            const isSelected = selectedMulti.includes(option)
            return (
              <Chip
                key={option}
                icon={isSelected ? <Check /> : undefined}
                aria-pressed={isSelected}
                disabled={isSubmitting}
                onClick={() => handleSelectOption(currentQ, option)}
              >
                {option}
              </Chip>
            )
          })}
        </div>
      )}

      {currentQ.kind === 'free_text' && (
        <Textarea
          value={freeTextValue}
          onChange={(e) => handleFreeTextChange(currentQ, e.target.value)}
          placeholder={currentQ.placeholder || '请输入你的回答'}
          rows={3}
          disabled={isSubmitting}
          style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginBottom: 12 }}
        />
      )}

      {error && (
        <div style={{ color: 'var(--rn-bad)', fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconButton
          icon={<ChevronLeft />}
          title="上一题"
          disabled={!canGoBack || isSubmitting}
          onClick={() => setCurrentIndex(safeIndex - 1)}
        />
        <IconButton
          icon={<ChevronRight />}
          title="下一题"
          disabled={!canGoForward || isSubmitting}
          onClick={() => setCurrentIndex(safeIndex + 1)}
        />

        <span style={{ fontSize: 12, color: 'var(--rn-ink-3)', marginLeft: 2, fontVariantNumeric: 'tabular-nums' }}>
          已答 {answeredCount}/{totalQuestions}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {localDisabled && (
            <span style={{ fontSize: 12, color: 'var(--rn-ink-3)', fontStyle: 'italic' }}>
              取消处理中…
            </span>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit || isSubmitting}
            onClick={handleSubmit}
          >
            {isSubmitting ? '提交中…' : localDisabled ? '已禁用' : '提交回答'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default AskUserQuestionsCard
