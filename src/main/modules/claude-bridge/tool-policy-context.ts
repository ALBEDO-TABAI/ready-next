import { inferDocumentWidgetTaskKind, shouldForceDocumentToolCall } from './tool-policy-heuristics'

const RETRY_ONLY_PATTERN =
  /^(再试一次|再试|重试|继续|继续试试|继续一下|重新试一次|重新来|再来一次|retry|try again|again|continue)$/i
const HOST_INJECTED_USER_PATTERN =
  /^(系统检查：|\[tool_result\]|请基于以上工具结果继续下一步)/i

export function isRetryOnlyPrompt(input: string): boolean {
  return RETRY_ONLY_PATTERN.test(input.trim())
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
  if (!isRetryOnlyPrompt(normalizedCurrent)) return currentInput

  for (const previousInput of compactToolPolicyHistory(previousInputs, previousInputs.length || 1)) {
    const candidate = previousInput.trim()
    if (!candidate || isRetryOnlyPrompt(candidate) || isHostInjectedUserPrompt(candidate)) continue
    if (inferDocumentWidgetTaskKind(candidate) || shouldForceDocumentToolCall(candidate)) {
      return candidate
    }
  }

  return currentInput
}
