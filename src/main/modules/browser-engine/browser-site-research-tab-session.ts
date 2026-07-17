import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import type { BrowserCapabilityService } from './capability-service'
import type { BrowserStructuredItem, BrowserStructuredTemplate } from './capability-types'

function xiaohongshuResearchScript(template: BrowserStructuredTemplate, limit: number): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const text = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector)
        const value = normalize(node?.textContent)
        if (value) return value
      }
      return ''
    }
    if (${JSON.stringify(template)} === 'card_list') {
      const cards = Array.from(document.querySelectorAll('section.note-item, .note-item'))
        .filter(visible)
        .slice(0, ${JSON.stringify(limit)})
      const items = cards.map((card) => {
        const anchor = card.querySelector('a.cover[href], a[href*="/search_result/"][href], a[href*="/explore/"][href]')
        return {
          sourceUrl: location.href,
          title: text(card, ['.title span', '.title', '[class*="title"]']),
          link: anchor instanceof HTMLAnchorElement ? anchor.href : '',
          summary: '',
          rawFields: {
            author: text(card, ['.author .name', '.author-wrapper .name', '[class*="author"] [class*="name"]']),
            engagement: text(card, ['.like-wrapper .count', '[class*="like"] [class*="count"]', '.count']),
            publishedAt: text(card, ['.time', '[class*="date"]']),
            structure: { inMainContentRegion: true },
          },
        }
      }).filter((item) => item.title && item.link)
      if (items.length > 0) return items
      const pageText = normalize(document.body?.innerText)
      const state = /验证码|安全验证|访问频繁|扫码登录|登录后查看|请先登录|captcha|verification|challenge/i.test(pageText)
        ? 'waiting_human'
        : /暂无(?:相关)?结果|没有找到(?:相关)?内容|搜索无结果|换个词试试/i.test(pageText)
          ? 'verified_empty'
          : location.pathname.toLowerCase().startsWith('/user/profile/') && (document.title || pageText)
            ? 'account_read'
            : 'structure_unavailable'
      return [{
        sourceUrl: location.href,
        title: '__READY_RESEARCH_STATE__',
        link: location.href,
        summary: '',
        rawFields: {
          researchState: state,
          accountTitle: location.pathname.toLowerCase().startsWith('/user/profile/') ? normalize(document.title) : '',
          accountSummary: location.pathname.toLowerCase().startsWith('/user/profile/') ? pageText.slice(0, 2000) : '',
          structure: { inMainContentRegion: true },
        },
      }]
    }
    const roots = Array.from(document.querySelectorAll('.note-detail-mask .note-container, .note-detail-mask .note-content, .note-container, .note-detail, main'))
      .filter(visible)
    for (const root of roots) {
      const body = text(root, ['#detail-desc', '.desc', '.note-text', '[class*="desc"]', '[class*="content"]'])
      const title = text(root, ['#detail-title', '.title', 'h1', 'h2'])
      if (!body && !title) continue
      return [{
        sourceUrl: location.href,
        title: title || document.title,
        link: location.href,
        summary: body,
        rawFields: {
          body,
          author: text(root, ['.author .username', '.author .name', '[class*="author"] [class*="name"]']),
          engagement: text(root, ['.like-wrapper .count', '[class*="like"] [class*="count"]', '.count']),
          publishedAt: text(root, ['.date', '.time', '[class*="date"]']),
          structure: { inMainContentRegion: true },
        },
      }]
    }
    return []
  })()`
}

function xiaohongshuReadyScript(template: BrowserStructuredTemplate): string {
  return `(() => {
    const pageText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim()
    const terminalText = [
      '验证码', '安全验证', '访问频繁', '扫码登录', '登录后查看', '请先登录',
      '暂无相关结果', '没有找到相关内容', '搜索无结果', '换个词试试',
      'captcha', 'verification', 'challenge',
    ].some((term) => pageText.toLowerCase().includes(term.toLowerCase()))
    if (${JSON.stringify(template)} === 'card_list') {
      if (location.pathname.toLowerCase().startsWith('/user/profile/')) {
        return Boolean(document.querySelector('section.note-item, .note-item')) || pageText.length > 40 || terminalText
      }
      return Boolean(document.querySelector('section.note-item, .note-item')) || terminalText
    }
    return Boolean(document.querySelector('.note-detail-mask .note-container, .note-detail-mask .note-content, .note-container, .note-detail, main')) || terminalText
  })()`
}

export class BrowserSiteResearchTabSession {
  constructor(
    private readonly capabilityService: BrowserCapabilityService,
    private readonly leaseService: BrowserWriteLeaseService,
    private readonly surface: AgentBrowserSurface,
    private readonly leaseId: string,
    private readonly researchTabId: string,
  ) {}

  get tabId(): string | null {
    return this.researchTabId
  }

  async extract(
    url: string,
    options: { template: BrowserStructuredTemplate; limit: number },
  ): Promise<BrowserStructuredItem[]> {
    if (this.leaseService.checkWrite({ surface: this.surface, leaseId: this.leaseId }) !== null) {
      throw new Error('lease_lost')
    }
    const leaseGate = { service: this.leaseService, surface: this.surface, leaseId: this.leaseId }
    const navigated = await this.capabilityService.navigateTargetTab(this.researchTabId, url, leaseGate)
    if (!navigated.success) throw new Error(navigated.error || 'research_tab_navigation_failed')
    this.leaseService.heartbeat(this.leaseId)
    const isXiaohongshu = (() => {
      try { return /(^|\.)xiaohongshu\.com$/i.test(new URL(url).hostname) } catch { return false }
    })()
    const extracted = await this.capabilityService.extractStructured(this.researchTabId, {
      template: isXiaohongshu ? 'custom' : options.template,
      limit: options.limit,
      ...(isXiaohongshu ? { customScript: xiaohongshuResearchScript(options.template, options.limit) } : {}),
      wait: isXiaohongshu
        ? {
            condition: 'custom_js',
            customJs: xiaohongshuReadyScript(options.template),
            timeoutMs: 12_000,
            checkIntervalMs: 250,
            stableIterations: 1,
          }
        : { condition: 'content_stable', timeoutMs: 12_000, checkIntervalMs: 250, stableIterations: 2 },
    })
    return extracted.items
  }
}
