import { stampName } from './media-intake'

// Recording on the board: the microphone is asked for the way 快记 asks (getUserMedia on the first press, the same
// two Opus containers), and the result is an ordinary audio file for the board's file intake. Nothing is kept here.

export interface Recording {
  /** Ends the recording and returns it with its length (MediaRecorder's WebM carries no duration of its own). */
  stop(): Promise<{ file: File; durationMs: number }>
  /** Ends the recording and discards it. */
  cancel(): void
}
type Devices = Pick<MediaDevices, 'getUserMedia'>

export async function startRecording(devices: Devices | undefined = globalThis.navigator?.mediaDevices, clock: () => number = () => performance.now()): Promise<Recording> {
  if (!devices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('此环境不支持录音')
  let stream: MediaStream
  try { stream = await devices.getUserMedia({ audio: true }) }
  catch (cause) { throw new Error(cause instanceof DOMException && cause.name === 'NotAllowedError' ? '没有麦克风权限：请在系统设置的“隐私与安全性 › 麦克风”里允许 Ready Next' : '麦克风不可用', { cause }) }
  const release = () => stream.getTracks().forEach(track => track.stop())
  const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
  if (!mimeType) { release(); throw new Error('此环境不支持录音格式') }
  const recorder = new MediaRecorder(stream, { mimeType }), chunks: Blob[] = [], started = clock()
  let discarded = false
  const finished = new Promise<{ file: File; durationMs: number }>((resolve, reject) => {
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    // An interrupted recording keeps what was recorded so far, as 快记 does.
    recorder.onerror = () => { if (recorder.state !== 'inactive') recorder.stop() }
    recorder.onstop = () => {
      const durationMs = clock() - started
      release()
      if (discarded) return
      const type = mimeType.split(';')[0]
      if (!chunks.length) { reject(new Error('没有录到声音')); return }
      resolve({ file: new File(chunks, `录音 ${stampName(new Date())}.${type === 'audio/ogg' ? 'ogg' : 'webm'}`, { type }), durationMs })
    }
  })
  finished.catch(() => undefined)
  recorder.start(1000)
  return {
    stop() { if (recorder.state !== 'inactive') recorder.stop(); return finished },
    cancel() { discarded = true; if (recorder.state !== 'inactive') recorder.stop(); else release() },
  }
}
