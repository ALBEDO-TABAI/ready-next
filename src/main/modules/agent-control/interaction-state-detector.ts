import type { ScopeRunResumableAction, ScopeRunWaitingFor } from './contracts/types'
import type { TaskInteractionState } from './contracts/run-contracts'

export interface GenericInteractionDetectionResult {
  interactionState: Exclude<TaskInteractionState, 'running' | 'suspended' | 'resuming'>
  waitingFor: Exclude<ScopeRunWaitingFor, 'none'>
  resumableActions: ScopeRunResumableAction[]
  blockedReason: string
}

function toBlockedReason(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export function detectGenericInteractionState(text: string): GenericInteractionDetectionResult | null {
  const normalized = String(text || '').trim()
  if (!normalized) return null

  if (
    /(请确认|确认后我继续|是否继续|要继续吗|确认一下|确认是否)/.test(normalized)
  ) {
    return {
      interactionState: 'awaiting_confirmation',
      waitingFor: 'confirmation',
      resumableActions: ['continue', 'cancel'],
      blockedReason: toBlockedReason(normalized),
    }
  }

  if (
    /(请手动|需要你手动|人工处理|完成后告诉我|处理完后告诉我|登录后告诉我|授权后告诉我|验证码|二次验证)/.test(normalized)
  ) {
    return {
      interactionState: 'human_takeover',
      waitingFor: 'agent_result',
      resumableActions: ['continue', 'cancel'],
      blockedReason: toBlockedReason(normalized),
    }
  }

  if (
    /(请提供|请告诉我|需要你补充|请补充|还需要你提供|为了继续请提供|先告诉我)/.test(normalized)
    && /[？?]/.test(normalized)
  ) {
    return {
      interactionState: 'awaiting_clarification',
      waitingFor: 'input',
      resumableActions: ['continue', 'cancel'],
      blockedReason: toBlockedReason(normalized),
    }
  }

  return null
}
