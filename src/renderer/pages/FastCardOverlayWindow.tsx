import { useEffect, useState } from 'react'
import FastCardPanel from '../components/browser/FastCardPanel'
import FastCardResultPanel from '../components/browser/FastCardResultPanel'
import type { FastCardOverlayCommand, FastCardOverlaySnapshot } from '../../shared/fastcard'

function send(command: FastCardOverlayCommand): void {
  void window.electronAPI?.browser?.sendFastCardOverlayCommand?.(command)
}

export default function FastCardOverlayWindow() {
  const [snapshot, setSnapshot] = useState<FastCardOverlaySnapshot | null>(null)

  useEffect(() => {
    document.documentElement.dataset.fastcardOverlayWindow = 'true'
    return () => {
      delete document.documentElement.dataset.fastcardOverlayWindow
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const browser = window.electronAPI?.browser
    const cleanup = browser?.onFastCardOverlaySnapshot?.((next) => {
      setSnapshot(next)
    }) ?? (() => undefined)

    void browser?.getFastCardOverlaySnapshot?.().then((result) => {
      if (cancelled) return
      if (result?.success && result.data) {
        setSnapshot(result.data)
        return
      }
      void browser?.hideFastCardOverlay?.()
    })

    return () => {
      cancelled = true
      cleanup()
    }
  }, [])

  if (!snapshot) return <div className="browser-fastcard-overlay-root" />

  return (
    <div className="browser-fastcard-overlay-root">
      {snapshot.mode === 'result' && snapshot.resultPanel ? (
        <FastCardResultPanel
          state={snapshot.resultPanel}
          onClose={() => send({ type: 'close-result' })}
          onAddToFastCard={() => send({ type: 'add-result' })}
          onTargetLanguageChange={(targetLanguage) => send({ type: 'target-language-change', targetLanguage })}
        />
      ) : (
        <FastCardPanel
          items={snapshot.items}
          onCollapse={() => send({ type: 'collapse' })}
          onClear={() => send({ type: 'clear' })}
          onSaveMarkdown={() => send({ type: 'save-markdown' })}
          onInsertToChat={() => send({ type: 'insert-chat' })}
          onRemoveItem={(id) => send({ type: 'remove-item', id })}
        />
      )}
    </div>
  )
}
