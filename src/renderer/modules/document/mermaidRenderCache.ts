import { BoundedLruCache } from '../../../shared/bounded-lru'

const MERMAID_RENDER_CACHE_CAPACITY = 48
const MERMAID_THEME_KEY = 'base'

export type MermaidColorScheme = 'light' | 'dark'

const READY_MERMAID_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif"

/**
 * Ready 的 Mermaid 主题：白卡/墨字/暖 hairline，连线退到中灰，便签用唯一的品牌橘红描边。
 * 色值与文档 widget 令牌（document-widget-theme.ts）同源，图表与信息卡读作同一系统。
 */
const READY_MERMAID_THEME_VARIABLES: Record<MermaidColorScheme, Record<string, string>> = {
  light: {
    fontFamily: READY_MERMAID_FONT,
    fontSize: '13px',
    background: '#FFFFFF',
    mainBkg: '#FFFFFF',
    primaryColor: '#FFFFFF',
    primaryBorderColor: '#C9C6BE',
    primaryTextColor: '#1A1A1A',
    secondaryColor: '#F0EFED',
    secondaryBorderColor: '#C9C6BE',
    secondaryTextColor: '#1A1A1A',
    tertiaryColor: '#F6F5F1',
    tertiaryBorderColor: '#E8E5DE',
    tertiaryTextColor: '#333333',
    nodeBorder: '#C9C6BE',
    textColor: '#333333',
    lineColor: '#8A8A8A',
    clusterBkg: '#F6F5F1',
    clusterBorder: '#E8E5DE',
    edgeLabelBackground: '#FFFFFF',
    titleColor: '#1A1A1A',
    noteBkgColor: '#FFF6F4',
    noteBorderColor: '#FF4B2B',
    noteTextColor: '#1A1A1A',
    actorBkg: '#FFFFFF',
    actorBorder: '#C9C6BE',
    actorTextColor: '#1A1A1A',
    signalColor: '#666666',
    signalTextColor: '#333333',
    activationBkgColor: '#F0EFED',
    activationBorderColor: '#C9C6BE',
  },
  dark: {
    fontFamily: READY_MERMAID_FONT,
    fontSize: '13px',
    background: '#202124',
    mainBkg: '#202124',
    primaryColor: '#232427',
    primaryBorderColor: '#4A4D52',
    primaryTextColor: '#D9DBE1',
    secondaryColor: '#2A2B2E',
    secondaryBorderColor: '#4A4D52',
    secondaryTextColor: '#D9DBE1',
    tertiaryColor: '#1A1B1E',
    tertiaryBorderColor: '#333538',
    tertiaryTextColor: '#C4C7CF',
    nodeBorder: '#4A4D52',
    textColor: '#C4C7CF',
    lineColor: '#7E8796',
    clusterBkg: '#1A1B1E',
    clusterBorder: '#333538',
    edgeLabelBackground: '#202124',
    titleColor: '#D9DBE1',
    noteBkgColor: '#2B2220',
    noteBorderColor: '#FF6345',
    noteTextColor: '#D9DBE1',
    actorBkg: '#232427',
    actorBorder: '#4A4D52',
    actorTextColor: '#D9DBE1',
    signalColor: '#8F96A3',
    signalTextColor: '#C4C7CF',
    activationBkgColor: '#2A2B2E',
    activationBorderColor: '#4A4D52',
  },
}

const renderCache = new BoundedLruCache<string, Promise<string>>(MERMAID_RENDER_CACHE_CAPACITY)
let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null
let renderSequence = 0
let renderMissCount = 0

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function scopeMermaidSvgIds(svg: string, namespace: string): string {
  const safeNamespace = namespace.replace(/[^a-zA-Z0-9_-]/g, '') || 'ready-mermaid'
  const idMap = new Map<string, string>()
  let nextId = 0

  let scoped = svg.replace(/\bid=(["'])([^"'<>]+)\1/g, (_match, quote: string, id: string) => {
    const scopedId = `${safeNamespace}-${nextId}`
    nextId += 1
    idMap.set(id, scopedId)
    return `id=${quote}${scopedId}${quote}`
  })

  if (idMap.size === 0) return scoped

  scoped = scoped.replace(
    /\b(aria-labelledby|aria-describedby)=(["'])([^"']*)\2/g,
    (_match, attribute: string, quote: string, value: string) => {
      const nextValue = value
        .split(/\s+/)
        .map((token: string) => idMap.get(token) ?? token)
        .join(' ')
      return `${attribute}=${quote}${nextValue}${quote}`
    },
  )

  for (const [id, scopedId] of idMap) {
    const escapedId = escapeRegExp(id)
    scoped = scoped
      .replace(new RegExp(`url\\(\\s*#${escapedId}\\s*\\)`, 'g'), `url(#${scopedId})`)
      .replace(new RegExp(`((?:href|xlink:href)=["'])#${escapedId}(["'])`, 'g'), `$1#${scopedId}$2`)
      .replace(new RegExp(`((?:begin|end)=["'][^"']*)\\b${escapedId}(?=\\.)`, 'g'), `$1${scopedId}`)
  }

  scoped = scoped.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open: string, css: string, close: string) => {
    let scopedCss = css
    for (const [id, scopedId] of idMap) {
      scopedCss = scopedCss.replace(new RegExp(`#${escapeRegExp(id)}(?![a-zA-Z0-9_-])`, 'g'), `#${scopedId}`)
    }
    return `${open}${scopedCss}${close}`
  })

  return scoped
}

async function renderMermaidSource(code: string, scheme: MermaidColorScheme): Promise<string> {
  const key = `${MERMAID_THEME_KEY}:${scheme}\u0000${code}`
  const cached = renderCache.get(key)
  if (cached) return cached

  renderMissCount += 1
  const sourceRenderId = `ready-mermaid-cache-${renderSequence}`
  renderSequence += 1
  mermaidModulePromise ??= import('mermaid')

  const pending = mermaidModulePromise.then(async (module) => {
    const mermaid = module.default
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: MERMAID_THEME_KEY,
      themeVariables: READY_MERMAID_THEME_VARIABLES[scheme],
    })
    const result = await mermaid.render(sourceRenderId, code)
    return result.svg
  })

  renderCache.set(key, pending)
  try {
    return await pending
  } catch (error) {
    renderCache.delete(key)
    throw error
  }
}

export async function renderCachedMermaidSvg(
  code: string,
  namespace: string,
  scheme: MermaidColorScheme = 'light',
): Promise<string> {
  const svg = await renderMermaidSource(code, scheme)
  return scopeMermaidSvgIds(svg, namespace)
}

export function resetMermaidRenderCacheForTests(): void {
  renderCache.clear()
  mermaidModulePromise = null
  renderSequence = 0
  renderMissCount = 0
}

export function getMermaidRenderCacheStatsForTests(): { size: number; misses: number } {
  return { size: renderCache.size, misses: renderMissCount }
}
