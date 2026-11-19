import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  renderStartupSplashMarkup,
  STARTUP_SPLASH_FINISH,
  STARTUP_SPLASH_FINISH_EVENT,
  STARTUP_SPLASH_SIZE,
  type StartupSplashTheme,
} from '../../shared/startup-splash-markup'
import { WIDGET_SCRIPT_NONCE } from '../components/document/widget-sanitizer'

// How long the demo pretends Ready takes to load before it sends the finish signal, and the pause before it replays.
const DEMO_READY_MS = 2200
const DEMO_RESTART_MS = 900

/**
 * #/startup-preview: the startup splash exactly as the splash window shows it (the same markup, in a frame of the same
 * size; the page is see-through, so the stage shows through the glass as the desktop does), replayed in a loop. ?theme=light|dark picks the look (default: the system's); ?loop=0 plays it once and never
 * sends the finish signal, so a check can drive the frame itself.
 */
export default function StartupPreview() {
  const [searchParams] = useSearchParams()
  const theme: StartupSplashTheme = searchParams.get('theme') === 'dark' || (searchParams.get('theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
  const loop = searchParams.get('loop') !== '0'
  // The frame inherits the window's content security policy, which runs inline scripts only with this nonce.
  const markup = useMemo(() => renderStartupSplashMarkup(theme, { scriptNonce: WIDGET_SCRIPT_NONCE }), [theme])
  const [round, setRound] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (!loop) return
    const finish = setTimeout(() => frame.current?.contentWindow?.dispatchEvent(new Event(STARTUP_SPLASH_FINISH_EVENT)), DEMO_READY_MS)
    const restart = setTimeout(() => setRound(value => value + 1), DEMO_READY_MS + STARTUP_SPLASH_FINISH.fadeDelayMs + STARTUP_SPLASH_FINISH.fadeMs + DEMO_RESTART_MS)
    return () => { clearTimeout(finish); clearTimeout(restart) }
  }, [loop, round])

  return (
    <div style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100vh', background: 'var(--rn-stage)' }}>
      <iframe
        key={round}
        ref={frame}
        title="Ready 启动动画"
        data-startup-splash-preview={theme}
        srcDoc={markup}
        width={STARTUP_SPLASH_SIZE.width}
        height={STARTUP_SPLASH_SIZE.height}
        style={{ border: 0, background: 'transparent' }}
      />
    </div>
  )
}
