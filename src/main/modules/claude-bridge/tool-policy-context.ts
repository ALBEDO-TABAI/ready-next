import { inferDocumentWidgetTaskKind, shouldForceDocumentToolCall } from './tool-policy-heuristics'

const RETRY_ONLY_PATTERN =
  /^(再试一次|再试|重试|再重试|再重试一次|继续|继续试试|继续一下|重新试一次|重新来|再来一次|retry|try again|again|continue)$/i
const HOST_INJECTED_USER_PATTERN =
  /^(系统检查：|\[tool_result\]|请基于以上工具结果继续下一步)/i
const CONTEXT_DEPENDENT_EDIT_PATTERN =
  /^(再|继续|把|让|统一|改|调整|优化|去掉|移除|淡一点|浅一点|更.*一点|收紧|拉开|简化)/i
const PET_CONTEXT_PATTERN = /(宠物|猫猫|桌面猫|宠物气泡|信息气泡|便利贴|便签|贴纸|pet)/i
const PET_STICKY_FOLLOWUP_PATTERN = /(贴起来|贴上|贴到|放上|放到|便利贴|便签|气泡)/i

export function isRetryOnlyPrompt(input: string): boolean {
  return RETRY_ONLY_PATTERN.test(input.trim())
}

export function isContextDependentEditPrompt(input: string): boolean {
  const normalized = input.trim()
  if (!normalized) return false
  if (isRetryOnlyPrompt(normalized)) return true
  return normalized.length <= 80 && CONTEXT_DEPENDENT_EDIT_PATTERN.test(normalized)
}

export function isHostInjectedUserPrompt(input: string): boolean {
  return HOST_INJECTED_USER_PATTERN.test(input.trim())
}

export function compactToolPolicyHistory(inputs: string[], limit: number): string[] {
  return inputs
    .map((input) => input.trim())
    .filter((input) => input.length > 0)
    .filter((input) => !isHostInjectedUserPrompt(input))
    .slice(-limit)
    .reverse()
}

export function resolveToolPolicyInput(currentInput: string, previousInputs: string[]): string {
  const normalizedCurrent = currentInput.trim()
  if (!normalizedCurrent) return currentInput
  if (normalizedCurrent.length <= 120 && PET_STICKY_FOLLOWUP_PATTERN.test(normalizedCurrent)) {
    for (const previousInput of compactToolPolicyHistory(previousInputs, previousInputs.length || 1)) {
      const candidate = previousInput.trim()
      if (!candidate || isRetryOnlyPrompt(candidate) || isHostInjectedUserPrompt(candidate)) continue
      if (PET_CONTEXT_PATTERN.test(candidate)) {
        return `${candidate}\n\n继续要求：${normalizedCurrent}`
      }
    }
  }
  if (!isContextDependentEditPrompt(normalizedCurrent)) return currentInput

  for (const previousInput of compactToolPolicyHistory(previousInputs, previousInputs.length || 1)) {
    const candidate = previousInput.trim()
    if (!candidate || isRetryOnlyPrompt(candidate) || isHostInjectedUserPrompt(candidate)) continue
    if (inferDocumentWidgetTaskKind(candidate) || shouldForceDocumentToolCall(candidate)) {
      if (isRetryOnlyPrompt(normalizedCurrent)) return candidate
      return `${candidate}\n\n追加要求：${normalizedCurrent}`
    }
  }

  return currentInput
}
