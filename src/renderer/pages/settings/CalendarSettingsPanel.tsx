import { useEffect } from 'react'
import { Settings as CalendarSettings } from '../../modules/calendar/workbench/components/Settings'
import { getState, init, isDark, useStore } from '../../modules/calendar/workbench/store'
import '../../modules/calendar/workbench/styles/tokens.css'
import '../../modules/calendar/workbench/styles/app.css'

// 设置 › 日历 (W2 §3.2): the calendar's own preferences, moved here from its modal. They are the same
// pages (general, profile, notifications, menu bar, conferencing, calendars) read from the calendar's
// store, rendered inside a .ready-calendar scope so the calendar's stylesheet applies. If the calendar
// has not been opened yet, its store loads here first.
export function CalendarSettingsPanel() {
  const ready = useStore(state => state.ready)
  const dark = useStore(state => isDark(state))
  const error = useStore(state => state.error)
  useEffect(() => { if (!getState().ready) void init() }, [])
  return (
    <div className={`ready-calendar calendar-settings-embed${dark ? ' dark' : ''}`}>
      {ready ? <CalendarSettings variant="page" /> : <div className="calendar-load-state">{error || '正在读取日历…'}</div>}
    </div>
  )
}
