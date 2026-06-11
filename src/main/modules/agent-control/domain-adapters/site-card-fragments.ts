import { join } from 'path'
import { app } from 'electron'
import { SiteCardReader } from '../knowledge/site-card-reader'

/**
 * EP1-B3 — build per-domain site-card fragment inputs for the browser adapter.
 * Electron-coupled (resolves bundled roots + belief store root), so it lives
 * outside the adapter, which stays electron-free. One fragment per available
 * domain (bundled seeds + user overrides). The injected text leads with the
 * authoritative risk line (from the code store / isHighControlPlatformText),
 * then the card's experience body.
 */

export interface SiteCardFragmentInput {
  domain: string
  aliases: string[]
  text: string
}

/** Chinese / short aliases for the bundled seed domains (matching cues). */
const DOMAIN_ALIASES: Record<string, string[]> = {
  'xiaohongshu.com': ['xiaohongshu', '小红书', 'xhs'],
  'weibo.com': ['weibo', '微博'],
  'bilibili.com': ['bilibili', '哔哩哔哩', 'b站', 'b 站'],
  'zhihu.com': ['zhihu', '知乎'],
  'taobao.com': ['taobao', '淘宝'],
}

function siteCardBundledRoots(): string[] {
  return [
    join(process.resourcesPath, 'site-cards'),
    join(app.getAppPath(), 'assets', 'site-cards'),
    join(process.cwd(), 'assets', 'site-cards'),
  ]
}

const MAX_SITE_CARD_CHARS = 800

export function loadSiteCardFragments(beliefRootPath?: string | null): SiteCardFragmentInput[] {
  try {
    const userKnowledgeRoot =
      beliefRootPath === undefined ? join(app.getPath('userData'), 'agent-memory') : beliefRootPath
    const reader = new SiteCardReader({
      bundledRoots: siteCardBundledRoots(),
      userKnowledgeRoot,
    })
    const out: SiteCardFragmentInput[] = []
    for (const domain of reader.listDomains()) {
      const card = reader.render(domain)
      if (!card) continue
      const keyword = domain.split('.')[0]
      const aliases = Array.from(new Set([keyword, domain, ...(DOMAIN_ALIASES[domain] ?? [])]))
      const text = `[风险等级: ${card.riskLevel}（以代码 store 为准）]\n${card.body}`.slice(0, MAX_SITE_CARD_CHARS)
      out.push({ domain, aliases, text })
    }
    return out
  } catch {
    return []
  }
}
