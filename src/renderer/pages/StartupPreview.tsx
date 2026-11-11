import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import ReadyStartupSplash from '../components/startup/ReadyStartupSplash'

export default function StartupPreview() {
  const [searchParams] = useSearchParams()
  const isSplashWindow = searchParams.get('mode') === 'splash-window'
  const [ready, setReady] = useState(false)

  useEffect(() => {
    document.documentElement.classList.add('ready-startup-preview-root')
    return () => document.documentElement.classList.remove('ready-startup-preview-root')
  }, [])

  useEffect(() => {
    if (!isSplashWindow) return
    const finish = () => setReady(true)
    window.addEventListener('ready-startup-finish', finish)
    return () => window.removeEventListener('ready-startup-finish', finish)
  }, [isSplashWindow])

  return (
    <ReadyStartupSplash
      demo={!isSplashWindow}
      ready={ready}
      onExitComplete={isSplashWindow ? () => window.close() : undefined}
    />
  )
}
