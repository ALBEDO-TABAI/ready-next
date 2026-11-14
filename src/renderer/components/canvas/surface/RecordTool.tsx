import { useEffect, useRef, useState } from 'react'
import { Mic, RotateCw, Square } from 'lucide-react'
import { IconButton } from '../../ui'
import { startRecording, type Recording } from '../../../modules/canvas/recorder'
import { clock } from '../cards/AudioCard'

// The board's record tool (M4 2026-11-14), in the tool dock: one press starts recording, the button becomes the
// running time with a stop square (the signal colour here means "in progress", V5), a second press drops the voice
// card where you are looking. A recording that could not be saved stays in hand for another try.

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'recording'; since: number } | { kind: 'saving' } | { kind: 'failed'; file: File; durationMs: number }

export function RecordTool({ onRecorded, report, start = startRecording }: {
  /** Places the voice card; a rejection keeps the recording for a retry. */
  onRecorded(file: File, durationMs: number): Promise<void>
  report(cause: unknown): void
  start?: () => Promise<Recording>
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' }), [, tick] = useState(0)
  const recording = useRef<Recording | null>(null), mounted = useRef(true)
  // Leaving the board ends a running recording without keeping it: there is no board left to put it on.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; recording.current?.cancel(); recording.current = null } }, [])
  useEffect(() => {
    if (phase.kind !== 'recording') return
    const timer = setInterval(() => tick(value => value + 1), 500)
    return () => clearInterval(timer)
  }, [phase.kind])
  const save = async (file: File, durationMs: number) => {
    setPhase({ kind: 'saving' })
    try { await onRecorded(file, durationMs); if (mounted.current) setPhase({ kind: 'idle' }) }
    catch (cause) { /* silent-catch: reported to the person through the board's error line. */ report(cause); if (mounted.current) setPhase({ kind: 'failed', file, durationMs }) }
  }
  const begin = async () => {
    setPhase({ kind: 'starting' })
    try {
      const next = await start()
      if (!mounted.current) { next.cancel(); return }
      recording.current = next; setPhase({ kind: 'recording', since: Date.now() })
    } catch (cause) { /* silent-catch: reported to the person through the board's error line. */ report(cause); if (mounted.current) setPhase({ kind: 'idle' }) }
  }
  const stop = async () => {
    const current = recording.current
    recording.current = null
    if (!current) return
    setPhase({ kind: 'saving' })
    try { const { file, durationMs } = await current.stop(); if (mounted.current) await save(file, durationMs) }
    catch (cause) { /* silent-catch: reported to the person through the board's error line. */ report(cause); if (mounted.current) setPhase({ kind: 'idle' }) }
  }
  if (phase.kind === 'recording') return <button type="button" className="cv-record" data-recording aria-label="停止录音" aria-pressed title="停止录音并放到画板上" onClick={() => void stop()}>
    <span className="cv-record__dot" aria-hidden /><span className="cv-record__time" role="timer" aria-label="已录时长">{clock(Date.now() - phase.since)}</span><Square aria-hidden />
  </button>
  if (phase.kind === 'failed') return <IconButton size="lg" className="cv-record-retry" icon={<RotateCw aria-hidden />} title="重试保存录音" onClick={() => void save(phase.file, phase.durationMs)} />
  return <IconButton size="lg" icon={<Mic aria-hidden />} title="录音" aria-label="录音" disabled={phase.kind !== 'idle'} onClick={() => void begin()} />
}
