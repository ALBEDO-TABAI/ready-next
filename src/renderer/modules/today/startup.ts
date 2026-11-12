import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { readJsonStorage, writeJsonStorage } from '../../utils/storage'
import { useInkLayout } from '../document/ink/layout-state'

// 设置 › 启动 (W6 §5.1): Ready opens on 今日 unless the person chose to come back to where they left off.
// Main holds the choice (one settings key); the place left behind is a window-state cache in this profile.
export const STARTUP_VIEW_SETTING_KEY = 'startup_view'
export type StartupView = 'today' | 'last'
export const parseStartupView = (value: unknown): StartupView => value === 'last' ? 'last' : 'today'

const PLACE_KEY = 'ready-last-place'
const MODES: readonly WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']
type Place = { mode: WorkbenchMode; today: boolean }

export async function readStartupView(): Promise<StartupView> {
  const result = await window.electronAPI?.settings?.get(STARTUP_VIEW_SETTING_KEY)
  if (result && !result.success) throw new Error(result.error || '启动设置读取失败')
  return parseStartupView(result?.data)
}

export function startupPlace(view: StartupView, last: Partial<Place> | null): Place {
  if (view === 'today') return { mode: 'document', today: true }
  return { mode: last?.mode && MODES.includes(last.mode) ? last.mode : 'browser', today: last?.today === true }
}

/** Runs once before the workbench first renders, so the window opens in place; from then on the place is remembered. */
export function applyStartupPlace(view: StartupView): void {
  const place = startupPlace(view, readJsonStorage<Partial<Place> | null>(PLACE_KEY, null))
  useMode.setState({ workbenchMode: place.mode, splitMode: null })
  useInkLayout.setState({ home: place.today })
  let written = ''
  const remember = () => {
    const next = { mode: useMode.getState().workbenchMode, today: useInkLayout.getState().home }
    const key = JSON.stringify(next)
    if (key !== written) { written = key; writeJsonStorage(PLACE_KEY, next) }
  }
  remember()
  useMode.subscribe(remember)
  useInkLayout.subscribe(remember)
}
