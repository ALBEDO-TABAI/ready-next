export interface RSSAddSourceStatusSource {
  name?: string
  itemCount?: number
  warning?: string
}

export function getRSSAddSourceStatusMessage(source?: RSSAddSourceStatusSource): string | null {
  if (!source?.name) return null
  if (source.warning === 'source_exists') {
    const itemCountText = typeof source.itemCount === 'number' ? `，已有 ${source.itemCount} 条内容` : ''
    return `${source.name} 已存在，已切换到该订阅源${itemCountText}`
  }
  return source.warning || `${source.name} 已添加`
}
