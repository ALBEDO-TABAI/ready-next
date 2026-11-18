import { useEffect, useState } from 'react'
import { describeRSSMedia } from '../../../shared/rss-media'

// The cover at the top of an article in the reading page, shown whole. The pictures in lists, the sieve and the
// daily are RSSPicture.
export default function RSSCoverImage({ link, coverImage }: { link: string; coverImage?: string | null }) {
  const url = describeRSSMedia(link, coverImage).cover.url
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (!url) return null
  return <figure className="rss-cover-image" style={{ margin: '8px 0', maxWidth: '100%', width: '100%' }}>
    {failed ? <figcaption style={{ color: 'var(--rn-ink-3)', fontSize: 12 }}>封面暂不可用，可打开原文查看。</figcaption>
      : <img src={url} alt="来源封面" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}
        style={{ display: 'block', width: '100%', maxHeight: 400, objectFit: 'contain', borderRadius: 'var(--rn-r-card)' }} />}
  </figure>
}
