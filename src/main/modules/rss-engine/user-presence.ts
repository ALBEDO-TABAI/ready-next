/**
 * How long the person has been away from the computer. Session subscriptions only refresh on their own while
 * someone is there; a locked screen counts as away however recently the pointer moved.
 */
export interface SystemIdleSource {
  getSystemIdleTime(): number
  getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown'
}

export function readSystemIdleMs(source: SystemIdleSource): number {
  try {
    if (source.getSystemIdleState(1) === 'locked') return Number.POSITIVE_INFINITY
    return Math.max(0, source.getSystemIdleTime()) * 1000
  } catch {
    // silent-catch: without an idle reading the person is treated as present, as before this gate existed
    return 0
  }
}
