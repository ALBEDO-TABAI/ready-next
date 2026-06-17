import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import ReadyStartupSplash, {
  type ReadyStartupVariant
} from '../components/startup/ReadyStartupSplash'

function resolvePreviewVariant(value: string | null): ReadyStartupVariant {
  return value === 'pink' ? 'pink' : 'orange'
}

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
      variant={resolvePreviewVariant(searchParams.get('variant'))}
      onExitComplete={isSplashWindow ? () => window.close() : undefined}
    />
  )
}
