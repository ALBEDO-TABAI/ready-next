// The real shape of a sound: peaks read from the decoded audio, once per file and session. Long files are not
// decoded (the whole sound would sit in memory); their card draws a plain progress line instead.

const MAX_BYTES = 12 * 1024 * 1024
const cache = new Map<string, Promise<number[] | null>>()

/** `bars` peaks in 0–1, loudest bar 1. */
export function peaksOf(samples: Float32Array, bars: number): number[] {
  const size = Math.max(1, Math.floor(samples.length / bars)), peaks: number[] = []
  for (let bar = 0; bar < bars; bar++) {
    let peak = 0
    for (let i = bar * size, end = Math.min(samples.length, i + size); i < end; i++) { const value = Math.abs(samples[i]); if (value > peak) peak = value }
    peaks.push(peak)
  }
  const loudest = Math.max(...peaks)
  return loudest > 0 ? peaks.map(peak => peak / loudest) : peaks
}

export function loadPeaks(src: string, bars: number): Promise<number[] | null> {
  const key = `${bars}:${src}`, known = cache.get(key)
  if (known) return known
  const work = (async () => {
    if (typeof AudioContext === 'undefined') return null
    const response = await fetch(src)
    if (!response.ok) return null
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_BYTES) return null
    const context = new AudioContext()
    try { return peaksOf((await context.decodeAudioData(bytes)).getChannelData(0), bars) } finally { void context.close() }
  })().catch(() => null)
  cache.set(key, work)
  return work
}
