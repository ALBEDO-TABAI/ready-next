import type { RSSItem, RSSSource } from '../../components/rss/RSSFeed'
import type { RSSWarmCacheSnapshot } from './rssWarmCache'

function computeUnreadCounts(list: RSSItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of list) {
    if (!item.read) {
      counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1)
    }
  }
  return counts
}

export async function fetchRSSWarmSnapshot(): Promise<RSSWarmCacheSnapshot> {
  if (typeof window !== 'undefined' && window.electronAPI) {
    const result = await window.electronAPI.rss.getItems()
    if (result.success === false) {
      throw new Error(result.error || '获取 RSS 项目失败')
    }

    const items: RSSItem[] = (result.data || []).map((item) => ({
      id: item.id,
      sourceId: item.sourceId,
      title: item.title,
      link: item.link,
      summary: item.summary ?? '',
      author: item.author ?? '',
      source: item.source ?? '',
      publishedAt: item.publishedAt ? new Date(item.publishedAt).toLocaleString() : '',
      inboxVisible: item.inboxVisible ?? true,
      read: item.read,
      starred: item.starred,
      coverImage: item.coverImage ?? undefined,
    }))

    const sourcesResult = await window.electronAPI.rss.getSources()
    if (sourcesResult.success === false) {
      throw new Error(sourcesResult.error || '获取 RSS 源失败')
    }

    const unreadCounts = computeUnreadCounts(items)
    const sources: RSSSource[] = (sourcesResult.data || []).map((source) => ({
      id: source.id,
      name: source.name,
      count: unreadCounts.get(source.id) ?? 0,
      platform: source.platform,
      url: source.url,
    }))

    return {
      items,
      sources,
      isMock: result.mock || false,
      fetchedAt: Date.now(),
    }
  }

  return {
    items: [
      {
        id: '1', sourceId: '1', title: 'AI 创作工具的下一个十年',
        link: 'https://36kr.com/p/123456', summary: '探讨 AI 如何改变内容创作行业...',
        author: '',
        source: '36氪', publishedAt: new Date(Date.now() - 3600000).toLocaleString(),
        inboxVisible: true,
        read: false, starred: false,
      },
      {
        id: '2', sourceId: '2', title: '自媒体运营的核心方法论',
        link: 'https://www.huxiu.com/article/789', summary: '从 0 到 1 打造个人 IP 的实战经验...',
        author: '',
        source: '虎嗅', publishedAt: new Date(Date.now() - 7200000).toLocaleString(),
        inboxVisible: true,
        read: false, starred: true,
      },
    ],
    sources: [
      { id: '1', name: '36氪', count: 15 },
      { id: '2', name: '虎嗅', count: 12 },
    ],
    isMock: true,
    fetchedAt: Date.now(),
  }
}
