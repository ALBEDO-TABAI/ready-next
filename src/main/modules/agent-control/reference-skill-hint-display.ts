import { isRetryOnlyTurn } from './skill-detection-inputs'

function normalizeToken(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '')
    .trim()
}

function containsToken(text: string, token: string): boolean {
  const normalizedText = normalizeToken(text)
  const normalizedToken = normalizeToken(token)
  return normalizedToken.length >= 3 && normalizedText.includes(normalizedToken)
}

export function shouldDisplayReferenceSkillHintForLatestUserText(params: {
  latestUserText?: string | null
  skillId?: string | null
  skillName?: string | null
}): boolean {
  const text = String(params.latestUserText || '').trim()
  if (!text) return true
  if (containsToken(text, String(params.skillId || ''))) return true
  if (containsToken(text, String(params.skillName || ''))) return true
  if (isRetryOnlyTurn(text)) return true
  return /(?:继续|接着|恢复|重试|再跑|重新跑|进度|状态|跟进|追踪|汇报|跑完|完成任务|monitor|progress|status|resume|continue)/i.test(text)
}
