export function getUrlHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function getRegistrableDomain(url: string): string {
  const hostname = getUrlHostname(url)
  if (!hostname) return ''

  const parts = hostname.split('.')
  if (parts.length >= 2) return parts.slice(-2).join('.')
  return hostname
}
