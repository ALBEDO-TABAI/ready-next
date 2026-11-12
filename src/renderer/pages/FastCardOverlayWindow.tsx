import { useEffect, useRef, useState } from 'react'
import { getFastCardQuickNoteAPI } from '../stores/useFastCard'
import type { FastCardItem, FastCardIPCResult } from '../../shared/fastcard'
import FastCardPanel from '../components/browser/FastCardPanel'
import FastCardResultPanel from '../components/browser/FastCardResultPanel'
import { Button, Textarea } from '../components/ui'
import type { FastCardOverlayCommand, FastCardOverlaySnapshot } from '../../shared/fastcard'

function send(command: FastCardOverlayCommand): void {
  void window.electronAPI?.browser?.sendFastCardOverlayCommand?.(command)
}

export default function FastCardOverlayWindow() {
  const quickNoteWindow = new URLSearchParams(window.location.hash.split('?')[1]).get('quick-note') === '1'
  const [snapshot, setSnapshot] = useState<FastCardOverlaySnapshot | null>(null)

  useEffect(() => {
    document.documentElement.dataset.fastcardOverlayWindow = 'true'
    return () => {
      delete document.documentElement.dataset.fastcardOverlayWindow
    }
  }, [])

  useEffect(() => {
    if (quickNoteWindow) return
    let cancelled = false
    let receivedPush = false
    const browser = window.electronAPI?.browser
    const cleanup = browser?.onFastCardOverlaySnapshot?.((next) => {
      receivedPush = true
      setSnapshot(next)
    }) ?? (() => undefined)

    void browser?.getFastCardOverlaySnapshot?.().then((result) => {
      if (cancelled || receivedPush) return
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
  }, [quickNoteWindow])

  if (quickNoteWindow) return <FastCardQuickNoteEditor />
  if (!snapshot) return <div className="browser-fastcard-overlay-root" />

  return (
    <div className="browser-fastcard-overlay-root">
      {snapshot.mode === 'result' && snapshot.resultPanel ? (
        <FastCardResultPanel
          state={snapshot.resultPanel}
          syncState={snapshot.syncState}
          onClose={() => send({ type: 'close-result' })}
          onAddToFastCard={() => send({ type: 'add-result' })}
          onTargetLanguageChange={(targetLanguage) => send({ type: 'target-language-change', targetLanguage })}
        />
      ) : (
        <div className="fc-overlay rn-float"><FastCardPanel
          items={snapshot.items}
          revealTarget={snapshot.revealTarget}
          syncState={snapshot.syncState}
          onCollapse={() => send({ type: 'collapse' })}
          onClear={() => send({ type: 'clear' })}
          onSaveCanvas={itemIds => send({ type: 'save-canvas', itemIds })}
          onInsertToChat={itemIds => send({ type: 'insert-chat', itemIds })}
          onInsertToDocument={id => send({ type: 'insert-document', id })}
          onRemoveItem={(id) => send({ type: 'remove-item', id })}
        /></div>
      )}
    </div>
  )
}


export function FastCardQuickNoteEditor() {
  const [text, setText] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [shortcutError, setShortcutError] = useState('')
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const audioRetry = useRef<{ bytes: Uint8Array; mime: string; itemId: string } | null>(null)
  const textIntent = useRef<{ text: string; itemId: string } | null>(null)
  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => getFastCardQuickNoteAPI().quickStatus()).then(result => {
      if (active && (!result.success || !result.data?.registered)) setShortcutError(result.error || result.data?.error || '快记快捷键不可用')
    }).catch(failure => { if (active) setShortcutError(String(failure)) })
    return () => { active = false; if (recorder.current?.state === 'recording') recorder.current.stop() }
  }, [])
  const save = async (action: () => Promise<FastCardIPCResult<FastCardItem>>): Promise<boolean> => {
    setBusy(true); setError('')
    try {
      const result = await action()
      if (!result.success || !result.data) throw new Error(result.error || '未收到保存回执')
      setMessage(result.data.kind === 'audio' ? '录音已保存，可在 FastCard 播放' : '已收进 FastCard')
      return true
    } catch (failure) { setError(String(failure)); return false }
    finally { setBusy(false) }
  }
  const saveAudio = async () => {
    const input = audioRetry.current
    if (input && await save(() => getFastCardQuickNoteAPI().quickRecording(input))) audioRetry.current = null
  }
  const startRecording = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
      if (!mimeType) { stream.getTracks().forEach(track => track.stop()); throw new Error('此环境不支持录音格式') }
      const media = new MediaRecorder(stream, { mimeType }), chunks: Blob[] = []
      recorder.current = media
      media.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      media.onerror = () => { setError('录音中断，正在保存已录内容'); if (media.state !== 'inactive') media.stop() }
      media.onstop = () => {
        stream.getTracks().forEach(track => track.stop()); setRecording(false)
        void (async () => {
          audioRetry.current = { bytes: new Uint8Array(await new Blob(chunks).arrayBuffer()), mime: mimeType.split(';')[0], itemId: crypto.randomUUID() }
          await saveAudio()
        })().catch(failure => setError(String(failure)))
      }
      media.start(1000); setRecording(true)
    } catch (failure) { setError(String(failure)) }
  }
  return <section aria-label="全局快记" className="fastcard-quick-note rn-ui">
    <h2 className="fastcard-quick-note__title">快记</h2>
    {shortcutError && <p role="alert" className="fastcard-quick-note__status">{shortcutError}</p>}
    <Textarea aria-label="快记内容" className="fastcard-quick-note__text" value={text} disabled={busy} onChange={event => setText(event.target.value)} />
    <div className="fastcard-quick-note__actions"><Button variant="primary" disabled={busy || !text.trim()} onClick={() => {
      if (textIntent.current?.text !== text) textIntent.current = { text, itemId: crypto.randomUUID() }
      const input = textIntent.current
      void save(() => getFastCardQuickNoteAPI().quickText(input)).then(ok => { if (ok) { setText(''); textIntent.current = null } })
    }}>收进 FastCard</Button>
    <Button disabled={busy || recording} onClick={() => { const itemId = crypto.randomUUID(); void save(() => getFastCardQuickNoteAPI().quickClipboard(itemId)) }}>收进剪贴板内容</Button>
    <Button disabled={busy || !!audioRetry.current} onClick={() => { if (recording) recorder.current?.stop(); else void startRecording() }}>{recording ? '停止并保存录音' : '录音'}</Button>
    {audioRetry.current && <Button disabled={busy} onClick={() => void saveAudio()}>重试保存录音</Button>}</div>
    {message && <p role="status" className="fastcard-quick-note__status">{message}</p>}{error && <p role="alert" className="fastcard-quick-note__status">{error}</p>}
    <div className="fastcard-quick-note__footer"><Button variant="ghost" disabled={busy || recording || !!audioRetry.current} onClick={() => {
      void getFastCardQuickNoteAPI().quickClose().then(result => { if (!result.success) throw new Error(result.error || '无法关闭快记') }).catch(failure => setError(String(failure)))
    }}>关闭</Button></div>
  </section>
}
