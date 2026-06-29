export const DEFAULT_BROWSER_PAGE_BACKGROUND = '#ffffff'
export const DARK_BROWSER_PAGE_BACKGROUND = '#000000'

const MIN_SOLID_ALPHA = 0.85

export interface BrowserPageBackgroundCandidate {
  color?: unknown
}

export interface BrowserPageBackgroundProbe {
  document?: BrowserPageBackgroundCandidate[]
  viewport?: BrowserPageBackgroundCandidate[]
  colorScheme?: unknown
  prefersDark?: unknown
}

function toByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

function toHexByte(value: number): string {
  return toByte(value).toString(16).padStart(2, '0')
}

function alphaFromHex(pair: string): number {
  return Number.parseInt(pair, 16) / 255
}

function normalizeHexColor(value: string): string | null {
  const raw = value.trim()
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return null
  const hex = raw.slice(1)
  if (hex.length === 3 || hex.length === 4) {
    const alpha = hex.length === 4 ? alphaFromHex(`${hex[3]}${hex[3]}`) : 1
    if (alpha < MIN_SOLID_ALPHA) return null
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase()
  }
  if (hex.length === 8 && alphaFromHex(hex.slice(6, 8)) < MIN_SOLID_ALPHA) return null
  return `#${hex.slice(0, 6)}`.toLowerCase()
}

function normalizeRgbColor(value: string): string | null {
  const match = value.trim().match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i)
  if (!match) return null
  const alpha = match[4] === undefined ? 1 : Number.parseFloat(match[4])
  if (!Number.isFinite(alpha) || alpha < MIN_SOLID_ALPHA) return null
  return `#${toHexByte(Number.parseFloat(match[1] || '0'))}${toHexByte(Number.parseFloat(match[2] || '0'))}${toHexByte(Number.parseFloat(match[3] || '0'))}`
}

export function normalizeBrowserPageBackgroundColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  if (!raw || raw === 'transparent' || raw === 'none') return null
  return normalizeHexColor(raw) || normalizeRgbColor(raw)
}

function normalizedCandidates(candidates: BrowserPageBackgroundCandidate[] | undefined): string[] {
  if (!Array.isArray(candidates)) return []
  return candidates
    .map((candidate) => normalizeBrowserPageBackgroundColor(candidate?.color))
    .filter((color): color is string => Boolean(color))
}

function chooseViewportBackground(candidates: string[]): string | null {
  const weights = new Map<string, number>()
  for (const color of candidates) {
    weights.set(color, (weights.get(color) || 0) + 1)
  }
  let best: { color: string; weight: number } | null = null
  for (const [color, weight] of weights.entries()) {
    if (!best || weight > best.weight) {
      best = { color, weight }
    }
  }
  return best?.color || null
}

function isDarkBackground(color: string): boolean {
  const match = color.match(/^#([0-9a-f]{6})$/i)
  if (!match) return false
  const hex = match[1] || ''
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luma < 96
}

function fallbackFromColorScheme(probe: BrowserPageBackgroundProbe): string {
  const scheme = typeof probe.colorScheme === 'string' ? probe.colorScheme.toLowerCase() : ''
  const prefersDark = probe.prefersDark === true
  if (prefersDark && /\bdark\b/.test(scheme)) return DARK_BROWSER_PAGE_BACKGROUND
  if (/^dark$|^only dark$/.test(scheme.trim())) return DARK_BROWSER_PAGE_BACKGROUND
  return DEFAULT_BROWSER_PAGE_BACKGROUND
}

export function resolveBrowserPageBackground(probe: unknown): string {
  if (!probe || typeof probe !== 'object') return DEFAULT_BROWSER_PAGE_BACKGROUND
  const data = probe as BrowserPageBackgroundProbe
  const documentBackground = normalizedCandidates(data.document)[0]
  if (documentBackground) return documentBackground
  const viewportBackground = chooseViewportBackground(normalizedCandidates(data.viewport))
  if (viewportBackground && isDarkBackground(viewportBackground)) return viewportBackground
  return fallbackFromColorScheme(data)
}
