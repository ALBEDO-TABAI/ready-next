import { useEffect, useState, type MouseEvent } from 'react'
import { Rss } from 'lucide-react'
import { anchorOf, openMenu, showToast } from '../ui'
import { requestWorkbenchModeOpen } from '../../modules/workbench/mode-transition'
import type { BrowserPageCapabilities } from '../../../shared/browser-shell'

type Feed = BrowserPageCapabilities['feeds'][number]
const sameFeed = (left: string, right: string) => left.replace(/\/$/, '') === right.replace(/\/$/, '')

/**
 * 订阅 in the address field (W7 §4.10): shown only when the page declares a feed. One feed subscribes at once; several
 * open a short menu. It adds the feed through 资讯's own rss.addSource, then offers to open 资讯.
 */
export default function BrowserSubscribeButton({ feeds, pageTitle }: { feeds: Feed[]; pageTitle: string }) {
  const [subscribed, setSubscribed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const key = feeds.map(feed => feed.url).join('\n')

  useEffect(() => {
    let cancelled = false
    void window.electronAPI?.rss?.getSources?.().then(result => {
      if (!cancelled && result?.success) setSubscribed((result.data || []).map(source => source.url))
    }).catch(error => console.warn('[subscribe] sources unavailable:', error instanceof Error ? error.message : String(error)))
    return () => { cancelled = true }
  }, [key])

  if (feeds.length === 0) return null
  const open = feeds.filter(feed => !subscribed.some(url => sameFeed(url, feed.url)))
  const done = open.length === 0

  const subscribe = async (feed: Feed) => {
    setBusy(true)
    try {
      const name = feed.title.trim() || pageTitle.trim() || new URL(feed.url).hostname
      const result = await window.electronAPI.rss.addSource({ name, url: feed.url })
      if (!result?.success) throw new Error(result?.error || '订阅失败')
      setSubscribed(current => [...current, feed.url])
      showToast(`已订阅「${result.data?.name || name}」`, { actions: [{ label: '去资讯', onClick: () => requestWorkbenchModeOpen('rss') }] })
    } catch (error) {
      /* silent-catch: the failure is shown to the person as a toast; nothing else depends on it. */
      showToast(`没能订阅：${error instanceof Error ? error.message : String(error)}`, { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (done || busy) return
    if (open.length === 1) { void subscribe(open[0]); return }
    openMenu(anchorOf(event.currentTarget), open.map(feed => ({
      id: feed.url, label: feed.title || feed.url, icon: <Rss />, onSelect: () => { void subscribe(feed) },
    })), { label: '选择要订阅的源' })
  }

  return (
    <button
      type="button"
      className="rn-subscribe"
      data-browser-subscribe={done ? 'done' : 'open'}
      disabled={busy}
      aria-disabled={done || undefined}
      title={done ? '这个网站的订阅源已在资讯里' : open.length > 1 ? '这个网站有多个订阅源' : `订阅 ${open[0].title || '这个网站'}`}
      onClick={onClick}
    >
      {busy ? '订阅中…' : done ? '已订阅' : '订阅'}
    </button>
  )
}
