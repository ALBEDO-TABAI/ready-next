import { useEffect, useState } from 'react'
import { describeRSSMedia } from '../../../shared/rss-media'

// thumb：资讯卡右侧的固定比例缩略图；full：阅读页里完整显示的封面。
export default function RSSCoverImage({ link, coverImage, variant = 'full' }: { link: string; coverImage?: string | null; variant?: 'full' | 'thumb' }) {
  const url = describeRSSMedia(link, coverImage).cover.url
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (!url) return null
  if (variant === 'thumb') {
    if (failed) return null
    return <figure className="rss-cover-image rss-card-thumb">
      <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </figure>
  }
  return <figure className="rss-cover-image" style={{ margin: '8px 0', maxWidth: '100%', width: '100%' }}>
    {failed ? <figcaption style={{ color: 'var(--text-light)', fontSize: 12 }}>封面暂不可用，可打开原文查看。</figcaption>
      : <img src={url} alt="来源封面" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}
        style={{ display: 'block', width: '100%', maxHeight: 400, objectFit: 'contain', borderRadius: 14 }} />}
  </figure>
}
