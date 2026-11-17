import { isReadyBrowserBlankUrl } from '../../../shared/browser-defaults'

export interface PopupRequestContext {
  url: string
  frameName?: string
  features?: string
  disposition?: string
  referrer?: string
  /** True for navigations and opens that happen inside an already open sign-in popup. */
  insidePopup?: boolean
}

export interface PopupPolicyDecision {
  mode: 'allow-popup' | 'open-tab' | 'external'
  reason:
    | 'auth-bootstrap'
    | 'auth-host'
    | 'oauth-path'
    | 'popup-disposition'
    | 'regular-http'
    | 'regular-local-html'
    | 'external-protocol'
  authLike: boolean
}

interface BrowserUrlAllowanceOptions {
  allowLocalHtml?: boolean
}

// Hosts that only ever serve sign-in. A site that also has ordinary pages (x.com, github.com, …) is not listed:
// its sign-in pages are recognised by their path, and everything else on it opens as a tab.
const AUTH_HOST_PATTERNS = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
]

// Words are matched as whole path words, so an article called "/blog/verifying-claims" is not a sign-in page.
// A third-party authorization page needs its opener to hand the result back, however it was opened.
const AUTHORIZATION_PATH_PATTERN = /(^|[^a-z])(oauth2?|authorize|authorization|qrconnect|sso|saml2?)([^a-z]|$)/i
// A sign-in page counts only when the site itself asked for a small window, or the flow is already in one.
const SIGN_IN_PATH_PATTERN =
  /(^|[^a-z])(auth|callback|sign[-_]?in|sign[-_]?up|log[-_]?in|passkey|challenge|2fa|verify|verification)([^a-z]|$)/i

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

function isLocalHtmlBrowserURL(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' && parsed.protocol !== 'local-file:') return false
    const path = decodeURIComponent(`${parsed.host || ''}${parsed.pathname || ''}`)
    return /\.(?:html|htm)$/i.test(path)
  } catch {
    return false
  }
}

function isLocalHtmlPopupContext(context: PopupRequestContext): boolean {
  if (!isLocalHtmlBrowserURL(context.url)) return false
  return isLocalHtmlBrowserURL(String(context.referrer || ''))
}

export function isAllowedBrowserURL(url: string, options: BrowserUrlAllowanceOptions = {}): boolean {
  if (isReadyBrowserBlankUrl(url)) return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true
    return Boolean(options.allowLocalHtml && isLocalHtmlBrowserURL(url))
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

  if (isLocalHtmlPopupContext({ ...context, url })) {
    return { mode: 'open-tab', reason: 'regular-local-html', authLike: false }
  }

  if (!isAllowedBrowserURL(url)) {
    return { mode: 'external', reason: 'external-protocol', authLike: false }
  }

  const parsed = new URL(url)
  const pathname = parsed.pathname || ''
  const features = parseWindowFeatures(context.features)
  const askedForWindow = looksPopupSized(features) || String(context.disposition || '').toLowerCase() === 'new-window'
  const signInShaped = askedForWindow || context.insidePopup === true

  if (isAuthHost(parsed.hostname)) {
    return { mode: 'allow-popup', reason: 'auth-host', authLike: true }
  }
  if (AUTHORIZATION_PATH_PATTERN.test(pathname)) {
    return { mode: 'allow-popup', reason: 'oauth-path', authLike: true }
  }
  if (signInShaped && (
    SIGN_IN_PATH_PATTERN.test(pathname) || String(context.frameName || '').toLowerCase().includes('auth')
  )) {
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
