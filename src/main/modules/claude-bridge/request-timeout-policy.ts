import type { DocumentWidgetTaskKind } from './tool-policy-heuristics'

export interface ApiRequestTimeoutPolicyInput {
  forceDocumentTool?: boolean
  documentWidgetTaskKind?: DocumentWidgetTaskKind
  allowBrowserTools?: boolean
  preferredSkillToolNames?: string[] | null
}

export const DEFAULT_API_REQUEST_TIMEOUT_MS = 45_000
export const DOCUMENT_API_REQUEST_TIMEOUT_MS = 75_000
export const DOCUMENT_WIDGET_API_REQUEST_TIMEOUT_MS = 90_000
export const KIMI_CODING_TOOL_REQUEST_TIMEOUT_MS = 90_000
export const BROWSER_OR_SKILL_API_REQUEST_TIMEOUT_MS = 120_000

function isKimiCodingBaseUrl(baseUrl: string | null | undefined): boolean {
  return String(baseUrl || '').trim().replace(/\/+$/, '').includes('api.kimi.com/coding')
}

export function resolveApiRequestTimeoutMs(
  policy?: ApiRequestTimeoutPolicyInput | null,
  options?: { baseUrl?: string | null },
): number {
  let timeoutMs = DEFAULT_API_REQUEST_TIMEOUT_MS
  if (policy?.forceDocumentTool) {
    if (policy.documentWidgetTaskKind === 'create' || policy.documentWidgetTaskKind === 'update') {
      timeoutMs = DOCUMENT_WIDGET_API_REQUEST_TIMEOUT_MS
    } else {
      timeoutMs = DOCUMENT_API_REQUEST_TIMEOUT_MS
    }
  }

  if (policy?.allowBrowserTools || (policy?.preferredSkillToolNames && policy.preferredSkillToolNames.length > 0)) {
    timeoutMs = Math.max(timeoutMs, BROWSER_OR_SKILL_API_REQUEST_TIMEOUT_MS)
  }

  if (isKimiCodingBaseUrl(options?.baseUrl)) {
    return Math.max(timeoutMs, KIMI_CODING_TOOL_REQUEST_TIMEOUT_MS)
  }

  return timeoutMs
}
