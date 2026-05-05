import type { IntentClassification } from './intent-classifier'

export function shouldEnforcePetToolRetry(params: {
  intent: IntentClassification
  allowedToolNames: string[]
  toolCallsCount: number
}): boolean {
  if (params.toolCallsCount > 0) return false
  if (params.intent.primaryDomain !== 'pet') return false
  return params.allowedToolNames.includes('pet_show_sticky_note')
}
