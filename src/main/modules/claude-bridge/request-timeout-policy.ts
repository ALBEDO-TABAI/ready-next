import type { DocumentWidgetTaskKind } from './tool-policy-heuristics'

export interface ApiRequestTimeoutPolicyInput {
  forceDocumentTool?: boolean
  documentWidgetTaskKind?: DocumentWidgetTaskKind
}

export const DEFAULT_API_REQUEST_TIMEOUT_MS = 45_000
export const DOCUMENT_API_REQUEST_TIMEOUT_MS = 75_000
export const DOCUMENT_WIDGET_API_REQUEST_TIMEOUT_MS = 90_000

export function resolveApiRequestTimeoutMs(policy?: ApiRequestTimeoutPolicyInput | null): number {
  if (policy?.forceDocumentTool) {
    if (policy.documentWidgetTaskKind === 'create' || policy.documentWidgetTaskKind === 'update') {
      return DOCUMENT_WIDGET_API_REQUEST_TIMEOUT_MS
    }
    return DOCUMENT_API_REQUEST_TIMEOUT_MS
  }
  return DEFAULT_API_REQUEST_TIMEOUT_MS
}
