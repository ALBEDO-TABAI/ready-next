import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, AlertCircle, Compass } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { Input } from '../ui/Field'
import { closeFloat, openFloat } from '../ui/float/float-store'

interface AddSourceModalProps {
  open: boolean
  onClose: () => void
  onSuccess: (source?: AddSourceSuccessInfo) => void
  browserPresetUrl?: string
  browserPresetName?: string
  browserPresetLabel?: string | null
}

export interface AddSourceSuccessInfo {
  id?: string
  name?: string
  itemCount?: number
  warning?: string
}

function detectPlatformHint(url: string): string | null {
  const lower = url.toLowerCase()
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'YouTube'
  if (lower.includes('bilibili.com') || lower.includes('b23.tv') || lower.includes('bili2233.cn')) return 'Bilibili (需要 RSSHub)'
  if (lower.includes('weibo.com')) return '微博 (需要应用内浏览器登录态)'
  if (lower.includes('douyin.com')) return '抖音 (需要应用内浏览器登录态)'
  if (lower.includes('xiaohongshu.com') || lower.includes('xhslink.com') || lower.includes('xhsurl.cn')) {
    return '小红书 (需要 RSSHub)'
  }
  if (lower.includes('x.com') || lower.includes('twitter.com')) return 'Twitter/X'
  if (lower.includes('vimeo.com')) return 'Vimeo'
  if (lower.includes('behance.net')) return 'Behance'
  if (lower.includes('zsxq.com')) return '知识星球'
  return null
}

// 添加 RSS 源：共享浮层宿主里的一个对话框（W1 §5 Dialog）。Esc、点击外面或“取消”都会关闭；open 由 RSSMode 掌握。
export default function AddSourceModal({
  open,
  onClose,
  onSuccess,
  browserPresetUrl = '',
  browserPresetName = '',
  browserPresetLabel = null,
}: AddSourceModalProps) {
  const latest = useRef({ onClose, onSuccess })
  latest.current = { onClose, onSuccess }
  useEffect(() => {
    if (!open) return
    const id = openFloat({
      anchor: { left: 0, top: 0, right: 0, bottom: 0 },
      placement: 'center',
      modal: true,
      role: 'dialog',
      label: '添加 RSS 源',
      className: 'rn-dialog rss-add-source-modal',
      onClose: () => latest.current.onClose(),
      render: (close) => <AddSourceForm close={close} onSuccess={(source) => latest.current.onSuccess(source)}
        browserPresetUrl={browserPresetUrl} browserPresetName={browserPresetName} browserPresetLabel={browserPresetLabel} />,
    })
    return () => closeFloat(id, true)
  }, [open, browserPresetUrl, browserPresetName, browserPresetLabel])
  return null
}

function AddSourceForm({ close, onSuccess, browserPresetUrl, browserPresetName, browserPresetLabel }: {
  close: () => void
  onSuccess: (source?: AddSourceSuccessInfo) => void
  browserPresetUrl: string
  browserPresetName: string
  browserPresetLabel: string | null
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const platformHint = useMemo(() => detectPlatformHint(url), [url])
  const hasBrowserPreset = Boolean(browserPresetUrl)
  const presetApplied = hasBrowserPreset && url === browserPresetUrl

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
        onSuccess(result?.data as AddSourceSuccessInfo | undefined)
        close()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法解析该 RSS 地址')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) void handleSubmit()
  }

  const handleUseBrowserPreset = () => {
    if (!browserPresetUrl) return
    setUrl(browserPresetUrl)
    setName(browserPresetName)
    setError(null)
  }

  return (
    <div className="rss-add-source">
      <div className="rss-add-source__header">
        <h2 className="rn-dialog__title">添加 RSS 源</h2>
        <IconButton size="sm" icon={<X />} title="关闭" onClick={close} />
      </div>

      <button
        type="button"
        onClick={handleUseBrowserPreset}
        disabled={!hasBrowserPreset}
        className="rss-add-source__preset"
        aria-pressed={presetApplied}
      >
        <span className="rss-add-source__preset-icon" data-ready={hasBrowserPreset || undefined}><Compass /></span>
        <span className="rss-add-source__preset-text">
          <strong>从当前页面带入</strong>
          <small>
            {hasBrowserPreset
              ? browserPresetLabel || '直接把当前浏览页面的地址和标题带进来。'
              : '先去浏览模式打开目标主页，这里就能直接带入当前页面。'}
          </small>
          {presetApplied ? <em>当前页面信息已带入</em> : null}
        </span>
      </button>

      <div className="rss-add-source__fields">
        <div className="rss-add-source__label">或者手动填写</div>
        <label className="rss-add-source__field">
          <span>RSS / Atom 订阅地址 或 平台主页链接</span>
          <Input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (error) setError(null)
            }}
            onKeyDown={handleKeyDown}
            placeholder="https://example.com/feed.xml"
            data-autofocus
            disabled={loading}
            aria-invalid={error ? true : undefined}
          />
          {platformHint && <small className="rss-add-source__hint">检测到平台：{platformHint}</small>}
        </label>
        <label className="rss-add-source__field">
          <span>名称（可选，留空自动获取）</span>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="例如：阮一峰的博客"
            disabled={loading}
          />
        </label>
        {error && (
          <p className="rss-note rss-note--danger rss-add-source__error" role="alert">
            <AlertCircle />
            <span>{error}</span>
          </p>
        )}
      </div>

      <div className="rn-dialog__actions">
        <Button variant="ghost" onClick={close} disabled={loading}>取消</Button>
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={loading || !url.trim()}
          icon={loading ? <Loader2 className="animate-spin" /> : undefined}>
          {loading ? '验证中' : '验证并添加'}
        </Button>
      </div>
    </div>
  )
}
