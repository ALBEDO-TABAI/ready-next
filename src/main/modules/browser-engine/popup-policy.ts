import { isReadyBrowserBlankUrl } from '../../../shared/browser-defaults'

export interface PopupRequestContext {
  url: string
  frameName?: string
  features?: string
  disposition?: string
  referrer?: string
}

export interface PopupPolicyDecision {
  mode: 'allow-popup' | 'open-tab' | 'external'
  reason:
    | 'auth-bootstrap'
    | 'auth-host'
    | 'oauth-path'
    | 'popup-disposition'
    | 'regular-http'
    | 'external-protocol'
  authLike: boolean
}

const AUTH_HOST_PATTERNS = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)myaccount\.google\.com$/i,
  /(^|\.)pinterest\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
]

const AUTH_PATH_PATTERN =
  /(oauth|authorize|callback|signin|sign-in|signup|sign-up|login|log-in|passkey|challenge|2fa|verify|sso)/i

function parseWindowFeatures(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const token of raw.split(',')) {
    const [key, value = '1'] = token.split('=')
    const k = String(key || '').trim().toLowerCase()
    if (!k) continue
    out[k] = String(value || '').trim().toLowerCase()
  }
  return out
}

function looksPopupSized(features: Record<string, string>): boolean {
  const width = Number(features.width || '')
  const height = Number(features.height || '')
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  return width > 0 && width <= 1100 && height > 0 && height <= 900
}

export function isAllowedBrowserURL(url: string): boolean {
  if (isReadyBrowserBlankUrl(url)) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function isAuthPopupBootstrapURL(url: string): boolean {
  const normalized = String(url || '').trim().toLowerCase()
  return (
    normalized === 'about:blank' ||
    normalized.startsWith('about:blank?') ||
    normalized.startsWith('about:blank#')
  )
}

function isAuthHost(hostname: string): boolean {
  return AUTH_HOST_PATTERNS.some((pattern) => pattern.test(hostname))
}

export function decidePopupPolicy(context: PopupRequestContext): PopupPolicyDecision {
  const url = String(context.url || '').trim()
  if (isAuthPopupBootstrapURL(url)) {
    return { mode: 'allow-popup', reason: 'auth-bootstrap', authLike: true }
  }

  if (!isAllowedBrowserURL(url)) {
    return { mode: 'external', reason: 'external-protocol', authLike: false }
  }

  const parsed = new URL(url)
  const pathname = `${parsed.pathname || ''}${parsed.search || ''}`
  const features = parseWindowFeatures(context.features)
  const isPopup = looksPopupSized(features) || String(context.disposition || '').toLowerCase() === 'new-window'
  const authHost = isAuthHost(parsed.hostname)
  const authPath = AUTH_PATH_PATTERN.test(pathname)

  if (authHost) {
    return { mode: 'allow-popup', reason: 'auth-host', authLike: true }
  }
  if (authPath) {
    return { mode: 'allow-popup', reason: 'oauth-path', authLike: true }
  }
  if (isPopup && (authHost || authPath || String(context.frameName || '').toLowerCase().includes('auth'))) {
    return { mode: 'allow-popup', reason: 'popup-disposition', authLike: true }
  }
  return { mode: 'open-tab', reason: 'regular-http', authLike: false }
}

export function shouldAllowBrowserPermission(
  permission: string,
  requestingUrl?: string,
): boolean {
  const normalized = String(permission || '').toLowerCase()
  const supportedSet = new Set([
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
    'geolocation',
    'storage-access',
    'top-level-storage-access',
    'identity-credentials-get',
    'window-management',
    'fullscreen',
    'pointerLock',
    'midi',
    'hid',
    'serial',
    'camera',
    'microphone',
    'media',
  ])

  if (!supportedSet.has(normalized)) return false
  if (!requestingUrl || !isAllowedBrowserURL(requestingUrl)) return false

  const autoGrantSet = new Set([
    'clipboard-sanitized-write',
    'storage-access',
    'top-level-storage-access',
    'fullscreen',
    'pointerlock',
  ])
  if (!autoGrantSet.has(normalized)) return false

  try {
    const parsed = new URL(requestingUrl)
    return parsed.protocol === 'https:' || normalized === 'fullscreen' || normalized === 'pointerlock'
  } catch {
    return false
  }
}

export function supportsBrowserPermissionRequest(permission: string): boolean {
  return new Set([
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
    'geolocation',
    'storage-access',
    'top-level-storage-access',
    'identity-credentials-get',
    'window-management',
    'fullscreen',
    'pointerlock',
    'midi',
    'hid',
    'serial',
    'camera',
    'microphone',
    'media',
  ]).has(String(permission || '').toLowerCase())
}

export function requiresUserApprovalBrowserPermission(permission: string): boolean {
  return new Set([
    'clipboard-read',
    'notifications',
    'geolocation',
    'identity-credentials-get',
    'window-management',
    'midi',
    'hid',
    'serial',
    'camera',
    'microphone',
    'media',
  ]).has(String(permission || '').toLowerCase())
}

export function toOAuthCompatibleUserAgent(rawUserAgent: string): string {
  const raw = String(rawUserAgent || '').trim()
  if (!raw) return raw

  // Remove Electron product token to avoid providers treating the session as an embedded UA.
  const cleaned = raw
    .replace(/\sElectron\/[^\s)]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return cleaned
}
