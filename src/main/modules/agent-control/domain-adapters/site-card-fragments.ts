import { join } from 'path'
import { createRequire } from 'node:module'
import { SiteCardReader } from '../knowledge/site-card-reader'

// CommonJS `require('electron')` rather than ESM `import { app }` — the named
// import crashes in non-Electron Node contexts (tsx tests reach this module
// through the orchestrator import chain). Same pattern as database.ts.
const electronApp = (() => {
  try {
    const electron = createRequire(import.meta.url)('electron') as typeof import('electron') | string
    return typeof electron === 'string' ? null : electron.app ?? null
  } catch {
    return null
  }
})()

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
  const roots: string[] = []
  if (process.resourcesPath) roots.push(join(process.resourcesPath, 'site-cards'))
  if (electronApp) roots.push(join(electronApp.getAppPath(), 'assets', 'site-cards'))
  roots.push(join(process.cwd(), 'assets', 'site-cards'))
  return roots
}

const MAX_SITE_CARD_CHARS = 800

export function loadSiteCardFragments(beliefRootPath?: string | null): SiteCardFragmentInput[] {
  try {
    const userKnowledgeRoot =
      beliefRootPath === undefined
        ? (electronApp ? join(electronApp.getPath('userData'), 'agent-memory') : null)
        : beliefRootPath
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
