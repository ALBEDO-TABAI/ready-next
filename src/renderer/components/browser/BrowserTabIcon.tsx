import { useState } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import type { BrowserTab } from '../../stores/useBrowserTabs'

/**
 * A tab's icon in the sidebar: the spinner while the page loads, the site's own icon, or the globe when the site
 * has none. An icon that cannot be shown (a page on plain http, a file that is not there) is the globe too, never
 * a broken picture; a new address for the icon is tried afresh.
 */
export function BrowserTabIcon({ tab }: { tab: Pick<BrowserTab, 'loading' | 'favicon'> }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (tab.loading) return <Loader2 className="browser-tab-list__icon animate-spin" strokeWidth={2} aria-hidden="true" />
  const favicon = tab.favicon || ''
  if (favicon && favicon !== failed) {
    return (
      <img
        className="browser-tab-list__icon browser-tab-list__favicon"
        src={favicon}
        alt=""
        draggable={false}
        onError={() => setFailed(favicon)}
      />
    )
  }
  return <Globe className="browser-tab-list__icon" strokeWidth={1.8} aria-hidden="true" />
}
