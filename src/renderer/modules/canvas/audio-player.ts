import { useSyncExternalStore } from 'react'

// One player for the whole board: starting a voice card stops the one before it. Only what a card needs to draw
// lives here (which card, playing or not, where in the sound); the cards keep no audio elements of their own.

export interface AudioPlayerState { id: string | null; playing: boolean; time: number; duration: number; error: string }
const idle: AudioPlayerState = { id: null, playing: false, time: 0, duration: 0, error: '' }
let state = idle, element: HTMLAudioElement | null = null
const listeners = new Set<() => void>()
const set = (patch: Partial<AudioPlayerState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) }

function player(): HTMLAudioElement {
  if (element) return element
  const audio = element = new Audio()
  audio.preload = 'metadata'
  audio.addEventListener('timeupdate', () => set({ time: audio.currentTime }))
  audio.addEventListener('durationchange', () => set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }))
  audio.addEventListener('play', () => set({ playing: true, error: '' }))
  audio.addEventListener('pause', () => set({ playing: false }))
  audio.addEventListener('ended', () => { audio.currentTime = 0; set({ playing: false, time: 0 }) })
  audio.addEventListener('error', () => set({ playing: false, error: '这段音频无法播放' }))
  return audio
}

export async function toggleAudio(id: string, src: string): Promise<void> {
  const audio = player()
  if (state.id === id && !audio.paused) { audio.pause(); return }
  if (state.id !== id) { audio.src = src; set({ id, time: 0, duration: 0, playing: false, error: '' }) }
  try { await audio.play() } catch (cause) { /* silent-catch: shown on the card; a play() interrupted by a pause is not an error. */ set({ playing: false, error: cause instanceof DOMException && cause.name === 'AbortError' ? '' : '这段音频无法播放' }) }
}
/** Jump within the card that is loaded (0–1 of its length); other cards ignore it. */
export function seekAudio(id: string, ratio: number, durationSeconds: number): void {
  if (state.id !== id || !element) return
  const length = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : durationSeconds
  if (length > 0) { element.currentTime = Math.max(0, Math.min(1, ratio)) * length; set({ time: element.currentTime }) }
}
/** The board closed: nothing keeps playing behind another page. */
export function stopAudio(): void {
  if (element) { element.pause(); element.removeAttribute('src'); element.load() }
  state = idle; listeners.forEach(listener => listener())
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const none: AudioPlayerState = idle
/** This card's view of the player: idle unless it is the card that is loaded. */
export function useAudioPlayer(id: string): AudioPlayerState {
  return useSyncExternalStore(subscribe, () => state.id === id ? state : none, () => none)
}
