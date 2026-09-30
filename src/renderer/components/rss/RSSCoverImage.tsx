import { useEffect, useState } from 'react'
import { describeRSSMedia } from '../../../shared/rss-media'

export default function RSSCoverImage({ link, coverImage, compact = false }: { link: string; coverImage?: string | null; compact?: boolean }) {
  const url = describeRSSMedia(link, coverImage).cover.url
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (!url) return null
  return <figure className="rss-cover-image" style={{ margin: '8px 0', maxWidth: '100%', width: compact ? 180 : '100%' }}>
    {failed ? <figcaption style={{ color: 'var(--text-muted)', fontSize: 12 }}>封面暂不可用，可打开原文查看。</figcaption>
      : <img src={url} alt="来源封面" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}
        style={{ display: 'block', width: '100%', maxHeight: compact ? 110 : 360, objectFit: 'contain', borderRadius: 10 }} />}
  </figure>
}
