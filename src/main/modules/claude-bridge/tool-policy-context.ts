import { inferDocumentWidgetTaskKind, shouldForceDocumentToolCall } from './tool-policy-heuristics'

const RETRY_ONLY_PATTERN =
  /^(再试一次|再试|重试|继续|继续试试|继续一下|重新试一次|重新来|再来一次|retry|try again|again|continue)$/i

export function isRetryOnlyPrompt(input: string): boolean {
  return RETRY_ONLY_PATTERN.test(input.trim())
}

export function resolveToolPolicyInput(currentInput: string, previousInputs: string[]): string {
  const normalizedCurrent = currentInput.trim()
  if (!normalizedCurrent) return currentInput
  if (!isRetryOnlyPrompt(normalizedCurrent)) return currentInput

  for (const previousInput of previousInputs) {
    const candidate = previousInput.trim()
    if (!candidate || isRetryOnlyPrompt(candidate)) continue
    if (inferDocumentWidgetTaskKind(candidate) || shouldForceDocumentToolCall(candidate)) {
      return candidate
    }
  }

  return currentInput
}
