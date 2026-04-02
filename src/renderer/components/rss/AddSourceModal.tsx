import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, Compass } from 'lucide-react'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
} from '../settings/settings-theme'

interface AddSourceModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  browserPresetUrl?: string
  browserPresetName?: string
  browserPresetLabel?: string | null
}

function detectPlatformHint(url: string): string | null {
  const lower = url.toLowerCase()
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'YouTube'
  if (lower.includes('bilibili.com') || lower.includes('b23.tv') || lower.includes('bili2233.cn')) return 'Bilibili (需要 RSSHub)'
  if (lower.includes('weibo.com')) return '微博 (需要应用内浏览器登录态)'
  if (lower.includes('douyin.com')) return '抖音 (需要应用内浏览器登录态)'
  if (lower.includes('xiaohongshu.com') || lower.includes('xhslink.com')) return '小红书 (需要应用内浏览器登录态)'
  if (lower.includes('x.com') || lower.includes('twitter.com')) return 'Twitter/X'
  if (lower.includes('vimeo.com')) return 'Vimeo'
  if (lower.includes('behance.net')) return 'Behance'
  if (lower.includes('zsxq.com')) return '知识星球'
  return null
}

export default function AddSourceModal({
  open,
  onClose,
  onSuccess,
  browserPresetUrl = '',
  browserPresetName = '',
  browserPresetLabel = null,
}: AddSourceModalProps) {
  const CONTENT_INSET = 18
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const platformHint = useMemo(() => detectPlatformHint(url), [url])
  const hasBrowserPreset = Boolean(browserPresetUrl)

  useEffect(() => {
    if (!open) return
    setUrl('')
    setName('')
    setError(null)
  }, [open])

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
    if (e.key === 'Enter' && !loading) handleSubmit()
    if (e.key === 'Escape') onClose()
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleUseBrowserPreset = () => {
    if (!browserPresetUrl) return
    setUrl(browserPresetUrl)
    setName(browserPresetName)
    setError(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center animate-fadeIn"
      style={{ background: 'transparent' }}
      onClick={handleBackdropClick}
    >
      <div
        className="w-[408px] rounded-[22px]"
        style={{
          ...SETTINGS_CARD_STYLE,
          background: 'color-mix(in srgb, var(--bg-primary) 97%, white 3%)',
          boxShadow: '0 18px 42px rgba(15,23,42,0.12), 0 6px 14px rgba(15,23,42,0.06)',
        }}
      >
        <div
          className="flex items-center justify-between"
          style={{
            padding: '14px 16px 10px',
            borderBottom: '1px solid color-mix(in srgb, var(--border-default) 70%, rgba(255,255,255,0.58))',
          }}
        >
          <h3
            className="text-[14px] font-semibold text-[var(--text-title)]"
            style={{ paddingLeft: CONTENT_INSET }}
          >
            添加 RSS 源
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--bg-hover)]"
            title="关闭"
          >
            <X className="h-4 w-4 text-[var(--text-muted)]" strokeWidth={2} />
          </button>
        </div>

        <div style={{ padding: '12px 16px 14px' }}>
          <div style={{ paddingLeft: CONTENT_INSET, paddingRight: 10 }}>
            <button
              type="button"
              onClick={handleUseBrowserPreset}
              disabled={!hasBrowserPreset}
              className="w-full rounded-[14px] text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                marginBottom: 10,
                padding: '8px 10px',
                border: hasBrowserPreset && url === browserPresetUrl
                  ? '1px solid color-mix(in srgb, var(--color-blue) 24%, var(--border-default) 76%)'
                  : '1px solid color-mix(in srgb, var(--border-default) 72%, rgba(255,255,255,0.6))',
                background: hasBrowserPreset && url === browserPresetUrl
                  ? 'color-mix(in srgb, var(--surface-panel-bg) 88%, rgba(255,255,255,0.96))'
                  : 'color-mix(in srgb, var(--surface-panel-bg) 76%, rgba(255,255,255,0.92))',
              }}
            >
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full"
                  style={{
                    border: '1px solid color-mix(in srgb, var(--border-default) 74%, rgba(255,255,255,0.65))',
                    background: 'rgba(255,255,255,0.84)',
                  }}
                >
                  <Compass
                    className="h-3 w-3"
                    style={{ color: hasBrowserPreset ? 'var(--color-blue)' : 'var(--text-light)' }}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold" style={{ color: 'var(--text-title)' }}>
                    从当前页面带入
                  </div>
                  <div className="mt-0.5 text-[11px] leading-5" style={{ color: 'var(--text-light)' }}>
                    {hasBrowserPreset
                      ? browserPresetLabel || '直接把当前浏览页面的地址和标题带进来。'
                      : '先去浏览模式打开目标主页，这里就能直接带入当前页面。'}
                  </div>
                  {hasBrowserPreset && url === browserPresetUrl ? (
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--color-blue)' }}>
                      当前页面信息已带入
                    </div>
                  ) : null}
                </div>
              </div>
            </button>
          </div>

          <div
            className="space-y-2.5"
            style={{ paddingTop: 2, paddingLeft: CONTENT_INSET, paddingRight: 10 }}
          >
            <div
              className="text-[12px] font-semibold"
              style={{ color: 'var(--text-title)' }}
            >
              或者手动填写
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] text-[var(--text-muted)]">
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
                className="w-full rounded-[14px] border text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)] focus:border-transparent"
                style={{
                  ...SETTINGS_INPUT_STYLE,
                  padding: '9px 12px',
                  borderRadius: 14,
                  background: 'rgba(255,255,255,0.9)',
                  borderColor: error ? 'var(--color-red)' : 'var(--input-slot-border)',
                }}
              />
              {platformHint && (
                <p className="mt-1 text-[11px] text-[var(--color-blue)]">
                  检测到平台：{platformHint}
                </p>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] text-[var(--text-muted)]">
                名称（可选，留空自动获取）
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="例如：阮一峰的博客"
                disabled={loading}
                className="w-full rounded-[14px] border text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)] focus:border-transparent"
                style={{
                  ...SETTINGS_INPUT_STYLE,
                  padding: '9px 12px',
                  borderRadius: 14,
                  background: 'rgba(255,255,255,0.9)',
                  borderColor: 'var(--input-slot-border)',
                }}
              />
            </div>

            {error && (
              <div
                className="flex items-center gap-2 rounded-[12px] px-3 py-2"
                style={{ background: 'color-mix(in srgb, var(--color-red) 12%, white)' }}
              >
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-red)]" />
                <span className="text-[12px] text-[var(--color-red)]">{error}</span>
              </div>
            )}
          </div>

          <div
            className="flex items-center justify-end gap-2"
            style={{ paddingTop: 10, paddingRight: 10 }}
          >
            <button
              onClick={onClose}
              disabled={loading}
              className="text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
              style={{
                ...SETTINGS_SECONDARY_BUTTON_STYLE,
                minWidth: 70,
                padding: '8px 12px',
                borderRadius: 14,
                fontSize: 12,
                lineHeight: 1.2,
              }}
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || !url.trim()}
              className="flex items-center justify-center gap-1.5 text-[12px] text-white transition-all disabled:opacity-50"
              style={{
                ...SETTINGS_PRIMARY_BUTTON_STYLE,
                minWidth: 96,
                padding: '8px 14px',
                borderRadius: 14,
                fontSize: 12,
                lineHeight: 1.2,
              }}
            >
              {loading ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  验证中
                </>
              ) : (
                '验证并添加'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
