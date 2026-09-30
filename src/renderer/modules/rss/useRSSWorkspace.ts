import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSSource } from '../../components/rss/RSSFeed'
import { readRSSWindow, rssQueryKey, toRSSItem } from './workspace-query'

export function useRSSWorkspace(active: boolean) {
  const query = useRSSSession((state) => state.query)
  const storedView = useRSSSession((state) => state.view)
  const key = rssQueryKey(query)
  const view = storedView && rssQueryKey(storedView.query) === key ? storedView : null
  const items = useMemo(() => view?.items.map(toRSSItem) || [], [view])
  const [sources, setSources] = useState<RSSSource[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const query = useRSSSession.getState().query
    const key = rssQueryKey(query)
    const ticket = ++generation.current
    const current = useRSSSession.getState().view
    const count = current && rssQueryKey(current.query) === key ? Math.max(query.limit, current.items.length) : query.limit
    setLoading(true)
    setLoadingMore(false)
    setError(null)
    const currentRequest = () => ticket === generation.current && rssQueryKey(useRSSSession.getState().query) === key
    try {
      const [result, sourceResult] = await Promise.all([
        readRSSWindow(window.electronAPI.rss, query, count), window.electronAPI.rss.getSources(),
      ])
      if (!sourceResult.success) throw new Error(sourceResult.error || '订阅源读取失败')
      if (!currentRequest()) return
      useRSSSession.getState().setView(result)
      setSources((sourceResult.data || []).map((source) => ({ id: source.id, name: source.name, platform: source.platform, url: source.url })))
    } catch (cause) {
      if (!currentRequest()) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message === 'cursor_stale' ? '资料已发生变化，请重新读取当前范围。' : message)
      throw cause
    } finally { if (currentRequest()) setLoading(false) }
  }, [])

  const loadMore = useCallback(async () => {
    const state = useRSSSession.getState()
    const current = state.view
    const key = rssQueryKey(state.query)
    if (!current?.nextCursor || rssQueryKey(current.query) !== key || loading || loadingMore) return
    const ticket = ++generation.current
    setLoadingMore(true)
    setError(null)
    try {
      const response = await window.electronAPI.rss.queryItems({ ...current.query, cursor: current.nextCursor, expectedRevision: current.revision })
      if (ticket !== generation.current || rssQueryKey(useRSSSession.getState().query) !== key) return
      if (!response.success || !response.data) throw new Error(response.error || '下一页读取失败')
      useRSSSession.getState().setView({ ...response.data, items: [...current.items, ...response.data.items] })
    } catch (cause) {
      if (ticket === generation.current && rssQueryKey(useRSSSession.getState().query) === key) setError(cause instanceof Error && cause.message === 'cursor_stale' ? '资料已发生变化，请重新读取当前范围。' : '下一页读取失败，请重试。')
    } finally { if (ticket === generation.current) setLoadingMore(false) }
  }, [loading, loadingMore])

  useEffect(() => {
    if (active) void reload().catch(() => {})
    return () => { generation.current += 1 }
  }, [active, key, reload])

  return { query, view, items, sources, loading, loadingMore, error, reload, loadMore, hasHydrated: storedView !== null }
}
