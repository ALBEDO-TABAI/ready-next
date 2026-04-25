function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

export function isRetryOnlyTurn(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (normalized.length > 32) return false
  return /^(再?重试(一次|一下)?|再试(一次|一下)?|再来(一次|一下)?|重新(试|来|开始)|继续(一下|处理|执行|刚才|上次|当前|这个|任务)?|接着(来|做|处理|执行)?|恢复(上次|刚才|当前)?|try again|retry|continue)$/i.test(normalized)
}

export function buildSkillDetectionInputs(params: {
  contextualUserInput: string
  primaryInstruction?: string | null
  pureUserText?: string | null
  previousPureUserInputs?: string[] | null
}): string[] {
  const currentInputs = uniqueNonEmpty([
    params.contextualUserInput,
    params.primaryInstruction,
    params.pureUserText,
  ])
  const shouldReuseRecentGoals = currentInputs.some(isRetryOnlyTurn)
  if (!shouldReuseRecentGoals) return currentInputs

  return uniqueNonEmpty([
    ...currentInputs,
    ...(params.previousPureUserInputs || []).slice(0, 6),
  ])
}
