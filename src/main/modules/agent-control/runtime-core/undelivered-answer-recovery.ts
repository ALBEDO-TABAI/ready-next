import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type { RunMetaRecord } from '../task-projection/run-meta-repository'

const RECOVERABLE_REASONS = new Set(['proof_gap', 'adjudication_degraded', 'delivery_failed'])

function looksLikeFallbackText(text: string): boolean {
  return /这轮还没完整完成|可以继续发送|任务已完成，但本次没有产生可发送的文本结果/.test(text)
}

export function recoverUndeliveredAnswerForRetry(params: {
  projection: TaskProjectionRecord | null | undefined
  runMeta: Pick<RunMetaRecord, 'status' | 'terminalReason' | 'lastMessageText'> | null | undefined
}): string | null {
  const { projection, runMeta } = params
  if (!projection || !runMeta) return null
  if (projection.status !== 'failed') return null
  if (projection.module !== 'browser' && projection.taskType !== 'research') return null
  if (runMeta.status !== 'error') return null
  if (!RECOVERABLE_REASONS.has(String(runMeta.terminalReason || ''))) return null

  const answer = String(runMeta.lastMessageText || '').trim()
  if (answer.length < 8 || looksLikeFallbackText(answer)) return null
  return `刚才的结果没有成功显示，我重新发一次：\n\n${answer}`
}
