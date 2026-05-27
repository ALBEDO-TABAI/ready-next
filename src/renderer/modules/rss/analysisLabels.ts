export function compactAnalysisDetail(detail: string | null | undefined): string {
  const normalized = (detail || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (/NotOpenSSLWarning|urllib3 v2 only supports OpenSSL/i.test(normalized)) {
    return 'Python 网络环境不兼容，下载失败'
  }
  if (/下载失败/.test(normalized)) return '下载失败'
  if (normalized.length <= 96) return normalized
  return `${normalized.slice(0, 95)}…`
}
