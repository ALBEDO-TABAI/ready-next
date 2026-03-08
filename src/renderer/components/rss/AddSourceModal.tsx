import { useState, useMemo } from 'react'
import { X, Loader2, AlertCircle, Rss } from 'lucide-react'

interface AddSourceModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

/** Detect platform from URL for user hint */
function detectPlatformHint(url: string): string | null {
  const lower = url.toLowerCase()
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'YouTube'
  if (lower.includes('bilibili.com') || lower.includes('b23.tv') || lower.includes('bili2233.cn')) return 'Bilibili (需要 RSSHub)'
  if (lower.includes('weibo.com')) return '微博 (需要 RSSHub)'
  if (lower.includes('douyin.com')) return '抖音 (需要 RSSHub)'
  if (lower.includes('xiaohongshu.com') || lower.includes('xhslink.com')) return '小红书 (需要 RSSHub)'
  if (lower.includes('x.com') || lower.includes('twitter.com')) return 'Twitter/X'
  if (lower.includes('vimeo.com')) return 'Vimeo'
  if (lower.includes('behance.net')) return 'Behance'
  if (lower.includes('zsxq.com')) return '知识星球'
  return null
}

export default function AddSourceModal({ open, onClose, onSuccess }: AddSourceModalProps) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const platformHint = useMemo(() => detectPlatformHint(url), [url])

  if (!open) return null

  const handleSubmit = async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      setError('请输入 RSS 地址')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const result = await window.electronAPI?.rss?.addSource({
        url: trimmedUrl,
        name: name.trim() || undefined,
      })
      if (result?.success === false) {
        setError(result.error || '无法解析该 RSS 地址')
      } else {
        // Success
        setUrl('')
        setName('')
        setError(null)
        onSuccess()
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法解析该 RSS 地址')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onClose()
    }
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fadeIn"
      style={{ background: 'rgba(0, 0, 0, 0.4)' }}
      onClick={handleBackdropClick}
    >
      <div
        className="w-[420px] rounded-xl shadow-2xl"
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-blue-light)' }}
            >
              <Rss className="w-4 h-4 text-[var(--color-blue)]" />
            </div>
            <h3 className="text-[14px] font-semibold text-[var(--text-title)]">添加 RSS 源</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 transition-colors"
          >
            <X className="w-4 h-4 text-[var(--text-muted)]" strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          {/* URL field */}
          <div>
            <label className="block text-[12px] text-[var(--text-muted)] mb-2">
              RSS / Atom 订阅地址 或 平台主页链接
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={handleKeyDown}
              placeholder="https://example.com/feed.xml"
              autoFocus
              disabled={loading}
              className="w-full px-3 py-2.5 rounded-lg border text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)] focus:border-transparent"
              style={{
                background: 'var(--bg-content)',
                borderColor: error ? 'var(--color-red)' : 'var(--border-input)',
                color: 'var(--text-body)',
              }}
            />
            {/* Platform detection hint */}
            {platformHint && (
              <p className="mt-1.5 text-[11px] text-[var(--color-blue)]">
                检测到平台：{platformHint}
              </p>
            )}
          </div>

          {/* Name field */}
          <div>
            <label className="block text-[12px] text-[var(--text-muted)] mb-2">
              名称（可选，留空自动获取）
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="例如：阮一峰的博客"
              disabled={loading}
              className="w-full px-3 py-2.5 rounded-lg border text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)] focus:border-transparent"
              style={{
                background: 'var(--bg-content)',
                borderColor: 'var(--border-input)',
                color: 'var(--text-body)',
              }}
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--color-red-light)' }}>
              <AlertCircle className="w-3.5 h-3.5 text-[var(--color-red)] flex-shrink-0" />
              <span className="text-[12px] text-[var(--color-red)]">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-4"
          style={{ borderTop: '1px solid var(--border-default)' }}
        >
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 rounded-lg border text-[13px] hover:bg-black/5 transition-colors"
            style={{ borderColor: 'var(--border-input)', color: 'var(--text-body)' }}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !url.trim()}
            className="px-4 py-2 rounded-lg text-[13px] text-white transition-all flex items-center gap-2 disabled:opacity-50"
            style={{ background: 'var(--color-blue)' }}
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                验证中...
              </>
            ) : (
              '验证并添加'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
