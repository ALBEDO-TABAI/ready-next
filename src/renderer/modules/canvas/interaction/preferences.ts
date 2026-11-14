import { useSyncExternalStore } from 'react'
import type { Camera } from './geometry'

// Board view preferences and each board's camera are this machine's state (M4 §2.8, §10.1): kept in the profile's
// localStorage, never written into a .canvas.

export interface BoardViewPrefs { smartGuides: boolean; magneticSnap: boolean; gap: number; adaptiveScale: boolean; roundedMedia: boolean }
export const DEFAULT_BOARD_VIEW: BoardViewPrefs = { smartGuides: true, magneticSnap: true, gap: 12, adaptiveScale: true, roundedMedia: true }
/** Snap reach in screen pixels (Stillroom's default); the world distance follows the zoom. */
export const SNAP_RADIUS = 26
export const MAX_GAP = 24
const VIEW_KEY = 'ready-next.canvas.view', CAMERA_KEY = 'ready-next.canvas.camera', CAMERA_LIMIT = 200

function storage(): Storage | null {
  try { return (globalThis as { window?: Window }).window?.localStorage ?? null } catch { /* silent-catch: storage can be denied; preferences then live for the session */ return null }
}
function readJson(key: string): unknown {
  try { return JSON.parse(storage()?.getItem(key) || 'null') } catch { /* silent-catch: unreadable preferences fall back to defaults */ return null }
}
function writeJson(key: string, value: unknown): void {
  try { storage()?.setItem(key, JSON.stringify(value)) } catch { /* silent-catch: a full or denied store only loses a preference */ }
}
function parseView(raw: unknown): BoardViewPrefs {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof BoardViewPrefs, unknown>>
  const flag = (key: 'smartGuides' | 'magneticSnap' | 'adaptiveScale' | 'roundedMedia') => typeof value[key] === 'boolean' ? value[key] as boolean : DEFAULT_BOARD_VIEW[key]
  const gap = typeof value.gap === 'number' && Number.isFinite(value.gap) ? Math.min(MAX_GAP, Math.max(0, Math.round(value.gap))) : DEFAULT_BOARD_VIEW.gap
  return { smartGuides: flag('smartGuides'), magneticSnap: flag('magneticSnap'), gap, adaptiveScale: flag('adaptiveScale'), roundedMedia: flag('roundedMedia') }
}
let cached: { source: Storage | null; value: BoardViewPrefs } | null = null
const listeners = new Set<() => void>()
export function boardView(): BoardViewPrefs {
  const source = storage()
  if (!cached || cached.source !== source) cached = { source, value: parseView(readJson(VIEW_KEY)) }
  return cached.value
}
export function setBoardView(patch: Partial<BoardViewPrefs>): void {
  cached = { source: storage(), value: parseView({ ...boardView(), ...patch }) }
  writeJson(VIEW_KEY, cached.value)
  listeners.forEach(listener => listener())
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useBoardView(): BoardViewPrefs { return useSyncExternalStore(subscribe, boardView, boardView) }

type CameraMemory = Record<string, Camera & { at: number }>
const validCamera = (c: unknown): c is Camera => !!c && typeof c === 'object' && (['x', 'y', 'zoom'] as const).every(key => Number.isFinite((c as Camera)[key])) && (c as Camera).zoom > 0
export function rememberedCamera(boardId: string): Camera | undefined {
  const entry = (readJson(CAMERA_KEY) as CameraMemory | null)?.[boardId]
  return validCamera(entry) ? { x: entry.x, y: entry.y, zoom: entry.zoom } : undefined
}
export function rememberCamera(boardId: string, camera: Camera): void {
  const memory = { ...(readJson(CAMERA_KEY) as CameraMemory | null), [boardId]: { x: Math.round(camera.x), y: Math.round(camera.y), zoom: camera.zoom, at: Date.now() } }
  const kept = Object.entries(memory).filter(([, entry]) => validCamera(entry)).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, CAMERA_LIMIT)
  writeJson(CAMERA_KEY, Object.fromEntries(kept))
}
