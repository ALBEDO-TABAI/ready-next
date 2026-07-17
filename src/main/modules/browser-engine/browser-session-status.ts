export interface BrowserSessionStatusInput {
  tabId: string
  profile: string | null
  currentUrl: string
  requestedOrigin?: string
  getCookieCount(origin: string): Promise<number>
  readStorageCounts(): Promise<{
    localStorageKeys: number
    sessionStorageKeys: number
    hasIndexedDb: boolean
  }>
}

export async function readBrowserSessionStatus(input: BrowserSessionStatusInput): Promise<Record<string, unknown>> {
  const origin = input.requestedOrigin || (() => {
    try { return new URL(input.currentUrl).origin } catch { return '' }
  })()
  const cookieCount = origin ? await input.getCookieCount(origin) : 0
  const storage = await input.readStorageCounts().catch(() => ({
    localStorageKeys: 0,
    sessionStorageKeys: 0,
    hasIndexedDb: false,
  }))
  return {
    tabId: input.tabId,
    profile: input.profile || 'default',
    profileScope: input.profile ? 'isolated_named_profile' : 'shared_default_profile',
    origin,
    authenticatedLikely: cookieCount > 0,
    cookieCount,
    storage,
    rawSecretsExposed: false,
  }
}
