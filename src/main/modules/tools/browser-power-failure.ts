/**
 * P1-A1 (2026-07-03, 7/01 browser reliability contract A1) — deterministic
 * failure advice for the Power browser tools. A Power failure must carry a
 * recovery hint matched to WHAT failed, not a generic "read map again":
 * the four classes below mirror the contract's suggested next actions.
 * Pure string classification so the mapping is unit-testable.
 */

export type BrowserPowerFailureClass =
  | 'timeout'
  | 'target_stale'
  | 'frame_context'
  | 'eval_runtime'
  | 'unknown'

export interface BrowserPowerFailureAdvice {
  failureClass: BrowserPowerFailureClass
  nextSuggestedAction: string
}

const TIMEOUT_PATTERN = /timed out|timeout/i
const TARGET_STALE_PATTERN =
  /no active tab|tab (?:not found|missing|closed)|webcontents.*(?:destroyed|disposed)|target (?:closed|crashed|detached|not found)|no target with given id|session closed|cannot find context with specified id/i
const FRAME_CONTEXT_PATTERN =
  /frame|isolated world|oopif|execution ?context(?!.*specified id)|browser_power_frame_(?:eval|context)_unavailable/i
const EVAL_RUNTIME_PATTERN =
  /syntaxerror|referenceerror|typeerror|rangeerror|is not defined|is not a function|unexpected token|unexpected identifier|exceptiondetails|uncaught|promise.*rejected|script failed to execute/i

export function classifyBrowserPowerFailure(message: string): BrowserPowerFailureAdvice {
  const text = String(message || '')
  if (TIMEOUT_PATTERN.test(text)) {
    return {
      failureClass: 'timeout',
      nextSuggestedAction:
        'reduce probe scope (shorter code / smaller duration) or switch to browser_power_resource_forensics / browser_power_network_trace',
    }
  }
  if (TARGET_STALE_PATTERN.test(text)) {
    return {
      failureClass: 'target_stale',
      nextSuggestedAction: 'use browser_get_tabs and rebind the BrowserActionSession target tab, then retry',
    }
  }
  if (FRAME_CONTEXT_PATTERN.test(text)) {
    return {
      failureClass: 'frame_context',
      nextSuggestedAction: 'use browser_power_cdp Page.getFrameTree then retry with the correct frame_id',
    }
  }
  if (EVAL_RUNTIME_PATTERN.test(text)) {
    return {
      failureClass: 'eval_runtime',
      nextSuggestedAction:
        'retry browser_power_eval with a wrapped async IIFE, or use browser_power_cdp Runtime.evaluate for exception details',
    }
  }
  return {
    failureClass: 'unknown',
    nextSuggestedAction: 'recover target tab/frame and read map again',
  }
}

export function browserToolOriginFromUrl(url: string | null | undefined): string | null {
  const trimmed = String(url || '').trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}
