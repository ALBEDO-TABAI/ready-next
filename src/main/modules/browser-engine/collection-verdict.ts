import type { BrowserCapabilityTaskStatus } from './capability-types'

export type BrowserTaskStatus = Extract<BrowserCapabilityTaskStatus, 'paused' | 'completed' | 'failed'>

export interface CollectionVerdictParams {
  collected: number
  expected: number | undefined
  stopReason: string
  failures: number
  cursorValid: boolean
}

export type CollectionVerdict =
  | 'needs_attention'
  | 'recoverable_paused'
  | 'completed_partial'
  | 'completed'

export interface CollectionVerdictResult {
  status: BrowserTaskStatus
  keepCursor: boolean
  labelKey: string
  verdict: CollectionVerdict
}

export function resolveCollectionVerdict(params: CollectionVerdictParams): CollectionVerdictResult {
  if (params.collected === 0) {
    return {
      status: 'failed',
      keepCursor: false,
      labelKey: 'verdict.empty_collection',
      verdict: 'needs_attention',
    }
  }

  if (params.expected === undefined || params.collected >= params.expected) {
    return {
      status: 'completed',
      keepCursor: false,
      labelKey: 'verdict.completed',
      verdict: 'completed',
    }
  }

  if (params.cursorValid) {
    return {
      status: 'paused',
      keepCursor: true,
      labelKey: 'verdict.recoverable_paused',
      verdict: 'recoverable_paused',
    }
  }

  return {
    status: 'failed',
    keepCursor: false,
    labelKey: 'verdict.unrecoverable_partial',
    verdict: 'completed_partial',
  }
}
