import { BoundedLruCache } from '../../../shared/bounded-lru'

const MERMAID_RENDER_CACHE_CAPACITY = 48
const MERMAID_THEME_KEY = 'base'

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

async function renderMermaidSource(code: string): Promise<string> {
  const key = `${MERMAID_THEME_KEY}\u0000${code}`
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

export async function renderCachedMermaidSvg(code: string, namespace: string): Promise<string> {
  const svg = await renderMermaidSource(code)
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
