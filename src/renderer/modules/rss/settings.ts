import {
  DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS,
  parseRSSAutoRefreshInterval,
  RSS_AUTO_REFRESH_INTERVAL_KEY,
} from '../../../shared/rss-auto-refresh'
import type { RSSAutoRefreshSnapshot } from '../../../shared/rss-auto-refresh'

export {
  DEFAULT_RSS_AUTO_REFRESH_INTERVAL_MS,
  parseRSSAutoRefreshInterval,
  RSS_AUTO_REFRESH_INTERVAL_KEY,
}

export type RSSRefreshRiskLevel = 'none' | 'notice' | 'warning' | 'danger'

export interface RSSRefreshIntervalOption {
  value: number
  label: string
  helper: string
}

export interface RSSRefreshRisk {
  level: RSSRefreshRiskLevel
  title: string
  message: string
}

export const RSS_REFRESH_INTERVAL_OPTIONS: RSSRefreshIntervalOption[] = [
  { value: 0, label: '手动', helper: '只在点击刷新时拉取' },
  { value: 15 * 60 * 1000, label: '15 分钟', helper: '当前默认，较频繁' },
  { value: 30 * 60 * 1000, label: '30 分钟', helper: '仍偏频繁' },
  { value: 60 * 60 * 1000, label: '1 小时', helper: '推荐日常使用' },
  { value: 3 * 60 * 60 * 1000, label: '3 小时', helper: '更稳妥' },
  { value: 6 * 60 * 60 * 1000, label: '6 小时', helper: '低干扰' },
  { value: 12 * 60 * 60 * 1000, label: '12 小时', helper: '低频归档' },
]

const RISKY_PLATFORM_KEYWORDS = [
  'bilibili',
  'weibo',
  'douyin',
  'xiaohongshu',
  'xhs',
  'rsshub',
  'browser',
  'scraper',
]

export function formatRSSRefreshInterval(value: number): string {
  return RSS_REFRESH_INTERVAL_OPTIONS.find((option) => option.value === value)?.label || '15 分钟'
}

export function getRSSAutoRefreshWarning(snapshot: RSSAutoRefreshSnapshot): string | null {
  if (snapshot.intervalMs <= 0 || snapshot.running || !snapshot.completedAt) return null
  if (snapshot.status !== 'completed_with_warnings' && snapshot.success !== false) return null
  if (snapshot.errors.length > 0) {
    return `RSS 自动刷新完成，但存在错误：${snapshot.errors[0]}`
  }
  return snapshot.message || 'RSS 自动刷新失败，稍后会再次尝试。'
}

export function getRSSFetchAllResultWarning(result: {
  success: boolean
  error?: string
  data?: { message?: string; errors?: string[] }
}): string | null {
  if (!result.success) {
    const detail = result.error || result.data?.errors?.[0] || result.data?.message
    return detail ? `RSS 刷新失败：${detail}` : 'RSS 刷新失败，稍后可再次尝试。'
  }
  if (result.data?.errors?.length) {
    return `RSS 刷新完成，但存在错误：${result.data.errors[0]}`
  }
  return null
}

export function hasRiskyRSSPlatform(platforms: Array<string | null | undefined>): boolean {
  return platforms.some((platform) => {
    const normalized = platform?.trim().toLowerCase()
    if (!normalized) return false
    return RISKY_PLATFORM_KEYWORDS.some((keyword) => normalized.includes(keyword))
  })
}

export function getRSSRefreshRisk(
  intervalMs: number,
  platforms: Array<string | null | undefined>,
): RSSRefreshRisk {
  if (intervalMs <= 0) {
    return {
      level: 'none',
      title: '手动刷新',
      message: '后台不会自动抓取订阅源，适合只在需要时手动查看。',
    }
  }

  const hasRiskyPlatform = hasRiskyRSSPlatform(platforms)
  if (intervalMs <= 15 * 60 * 1000) {
    return {
      level: 'danger',
      title: '刷新非常频繁',
      message: hasRiskyPlatform
        ? '部分源依赖 RSSHub、浏览器采集或平台登录，15 分钟刷新可能更容易触发风控。建议改为 1 小时或 3 小时。'
        : '15 分钟刷新会更快拿到新内容，但也更容易遇到来源站限制。建议日常使用 1 小时或 3 小时。',
    }
  }

  if (intervalMs <= 30 * 60 * 1000) {
    return {
      level: 'warning',
      title: '刷新偏频繁',
      message: hasRiskyPlatform
        ? '当前源里有较容易被限流的平台，30 分钟刷新仍可能触发登录、验证或抓取失败。'
        : '30 分钟刷新适合短时间盯内容，长期使用建议放宽到 1 小时以上。',
    }
  }

  if (intervalMs <= 60 * 60 * 1000) {
    return {
      level: 'notice',
      title: '推荐日常频率',
      message: '1 小时刷新能兼顾新内容时效和来源站稳定性。',
    }
  }

  return {
    level: 'none',
    title: '低频刷新',
    message: '这个频率更稳妥，适合把 RSS 当作定时收件箱使用。',
  }
}
