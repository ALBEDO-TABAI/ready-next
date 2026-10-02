// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
const MB = 1024 * 1024

let cacheStats = {
  codeCacheBytes: 48 * MB + 312 * 1024,
  cacheBytes: 212 * MB + 96 * 1024,
  puppeteerCacheBytes: 389 * MB + 640 * 1024,
  sharedCacheBytes: 3 * MB + 208 * 1024,
}

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  app: {
    getCacheStats: async () => ({ success: true, data: cacheStats }),
    clearCache: async (opts?: { includePuppeteer?: boolean }) => {
      const clearedBytes = cacheStats.codeCacheBytes + cacheStats.cacheBytes + cacheStats.sharedCacheBytes
        + (opts?.includePuppeteer ? cacheStats.puppeteerCacheBytes : 0)
      cacheStats = {
        codeCacheBytes: 0,
        cacheBytes: 0,
        sharedCacheBytes: 0,
        puppeteerCacheBytes: opts?.includePuppeteer ? 0 : cacheStats.puppeteerCacheBytes,
      }
      return { success: true, data: { clearedBytes, errors: [] } }
    },
    exportDiagnosticPack: async () => ({
      success: true,
      data: {
        path: '/Users/ready/Desktop/Ready-diagnostics-20261002.zip',
        fileName: 'Ready-diagnostics-20261002.zip',
        bytes: 1.6 * MB,
        includedLogs: ['ready-directchat.log', 'ready-tools.log', 'ready-browser.log'],
        skippedLogs: [],
      },
    }),
  },
}
