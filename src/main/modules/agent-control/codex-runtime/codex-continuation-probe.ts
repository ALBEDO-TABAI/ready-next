import type { RunMessage } from '../contracts/run-contracts'

export const CONTINUATION_PROBE_CONTRACT = 'ready_continuation_probe_input_v1' as const

export function buildContinuationProbeInput(
  workbenchMode: 'browser' | 'document' | 'rss' | 'calendar',
): {
  contract: typeof CONTINUATION_PROBE_CONTRACT
  message: RunMessage
  requestEnvelope: {
    primaryInstruction: string
    environmentHints: { workbenchMode: typeof workbenchMode }
  }
} {
  const primaryInstruction = '这是一条普通的新消息，请简短回复已收到。'
  return {
    contract: CONTINUATION_PROBE_CONTRACT,
    message: primaryInstruction,
    requestEnvelope: {
      primaryInstruction,
      environmentHints: { workbenchMode },
    },
  }
}
