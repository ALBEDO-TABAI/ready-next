import { useEffect } from 'react'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'
import { useRSSSession } from '../../stores/useRSSSession'

/**
 * W5 V5: clicking a 必须知道 notification opens that article in 资讯. Main keeps the request until 资讯 acknowledges it,
 * so a click that lands before this listener exists is picked up here, and 资讯 opens it once it is showing.
 */
export function useRSSNotificationOpen(): void {
  useEffect(() => {
    const api = window.electronAPI.rss
    const take = () => { useRSSSession.getState().takeNotificationOpen(); requestWorkbenchModeOpen('rss') }
    let live = true
    void api.sievePendingOpen().then((result) => { if (live && result.success && result.data) take() })
      .catch((error: unknown) => console.warn('[rss-sieve] pending notification not read', error))
    const stop = api.onSieveOpenPending(take)
    return () => { live = false; stop() }
  }, [])
}
