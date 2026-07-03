import type { BrowserCapabilityTaskStatus } from './capability-types'

export type BrowserTaskStatus = Extract<BrowserCapabilityTaskStatus, 'paused' | 'completed' | 'failed'>

export interface CollectionVerdictParams {
  collected: number
  expected: number | undefined
  stopReason: string
  failures: number
  cursorValid: boolean
  targetQuality?: 'trustworthy' | 'suspect_navigation_pollution' | 'structure_context_missing'
  /** P1-R1 (2026-07-03) — high-control platform (XHS/Douyin/…). On these, a
   *  polluted/empty freeze usually means the page served only its navigation
   *  shell (anti-crawl/login-gating didn't render the target content), which is
   *  a RECOVERABLE user-takeover situation ("open/log into the page yourself,
   *  then continue"), not a hard failure. See rescope doc §7. */
  highControl?: boolean
}

export type CollectionVerdict =
  | 'needs_attention'
  | 'needs_user_takeover'
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
  // P1-R1 — on a high-control platform, a polluted/empty freeze means the page
  // rendered only its nav shell (the target content was gated/not served to the
  // agent's navigation). That is recoverable via user takeover, not a hard
  // failure: surface `paused` + a takeover label so the run reads "打开/登录
  // 页面后继续" instead of a dead 失败. Generic sites keep the hard-failure
  // semantics below (a real empty/polluted result there is a genuine failure).
  const highControlTakeover: CollectionVerdictResult = {
    status: 'paused',
    keepCursor: false,
    labelKey: 'verdict.collection_needs_user_takeover',
    verdict: 'needs_user_takeover',
  }

  if (params.targetQuality === 'suspect_navigation_pollution') {
    if (params.highControl) return highControlTakeover
    return {
      status: 'failed',
      keepCursor: false,
      labelKey: 'verdict.collection_target_polluted',
      verdict: 'needs_attention',
    }
  }

  if (params.targetQuality === 'structure_context_missing' && params.collected === 0) {
    if (params.highControl) return highControlTakeover
    return {
      status: 'failed',
      keepCursor: false,
      labelKey: 'verdict.collection_structure_context_missing',
      verdict: 'needs_attention',
    }
  }

  if (params.collected === 0) {
    if (params.highControl) return highControlTakeover
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
