import { useEffect, useRef, useMemo } from 'react'
import Artplayer from 'artplayer'
import { Film } from 'lucide-react'
import { type DocTab } from '../../stores/useDocTabs'

interface ArtVideoPlayerProps {
  tab: DocTab
  fileUrl: string
  currentExt: string
}

export default function ArtVideoPlayer({ tab, fileUrl, currentExt }: ArtVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<Artplayer | null>(null)

  // Memoize to avoid re-creating on every render
  const url = useMemo(() => fileUrl, [fileUrl])

  useEffect(() => {
    if (!containerRef.current) return

    const art = new Artplayer({
      container: containerRef.current,
      url,
      volume: 0.8,
      autoSize: true,
      fullscreen: true,
      fullscreenWeb: true,
      playbackRate: true,
      setting: true,
      hotkey: true,
      pip: true,
      mutex: true,
      flip: true,
      aspectRatio: true,
      screenshot: true,
      theme: '#5B8DEF',
      // Highlight markers — empty for now, AI can push entries later
      highlight: [],
    })

    artRef.current = art

    return () => {
      art.destroy()
      artRef.current = null
    }
  }, [url])

  return (
    <div className="flex flex-col h-full">
      {/* ArtPlayer container */}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ background: '#0F0F0F' }}
      />

      {/* Video info bar */}
      <div
        style={{
          height: 28,
          background: '#1A1A1A',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          fontSize: 11,
          color: '#777',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Film size={12} />
          <span>{tab.title}</span>
        </div>
        <span
          style={{
            fontSize: 9,
            background: 'rgba(255,255,255,0.1)',
            borderRadius: 4,
            padding: '1px 5px',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {currentExt}
        </span>
      </div>
    </div>
  )
}
