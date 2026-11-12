/** Both requests can start together. Await firstScreen for the local shell; await sieve independently. */
export function queryToday() {
  return { firstScreen: window.electronAPI.today.firstScreen(), sieve: window.electronAPI.today.sieve() }
}
export type { TodayFirstScreen, TodaySieve, TodayItem } from '../../../shared/today'
