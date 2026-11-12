import { useEffect, useState, type ReactNode } from 'react'
import { Download, Pencil, Plus, Trash2, Upload, X } from 'lucide-react'
import { colorFamily, PALETTE } from '../../../shared/calendar'
import { Button, IconButton, Input, Kbd, Select, Switch, Tabs, confirmDialog } from '../../components/ui'
import { addCalendar, exportCalendar, getState, importIcsFile, init, isDark, reload, removeCalendar, setPrefs, setState, updateCalendar, useStore } from '../../modules/calendar/workbench/store'
import { t, type Locale } from '../../modules/calendar/workbench/i18n'
import { gmtLabel, reminderLabel, REMINDER_OPTS, timeOfFull } from '../../modules/calendar/workbench/fmt'
import { api, unwrap } from '../../modules/calendar/workbench/platform'
import { SettingsCard, SettingsRow } from './settings-shared'
import '../../modules/calendar/workbench/styles/app.css'

// 设置 › 日历 (W2 §3.2): the calendar's preferences, read from and written to the calendar's store. They use the
// settings page's own cards and rows with the shared controls (W1 §5), one tab per former page; the theme follows
// Ready's 外观 and is not repeated here. If the calendar has not been opened yet, its store loads here first.
const ZONES = (() => {
  try { return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone') }
  catch { /* silent-catch: Intl time-zone enumeration may be unavailable; the built-in zone list keeps the picker usable. */ return ['UTC', 'Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'America/New_York', 'America/Los_Angeles'] }
})()
const zoneOptions = ZONES.map(zone => ({ value: zone, label: `${gmtLabel(zone)} ${zone.split('/').pop()!.replace(/_/g, ' ')}` }))
const PAGES = ['general', 'profile', 'notifications', 'menubar', 'conferencing', 'calendars'] as const
type Page = typeof PAGES[number]
const options = <T extends string | number>(list: [T, string][]) => list.map(([value, label]) => ({ value: String(value), label }))
const noColon = (text: string) => text.replace(/[：:]\s*$/, '')

export function CalendarSettingsPanel() {
  const ready = useStore(state => state.ready)
  const error = useStore(state => state.error)
  const page = useStore(state => (PAGES as readonly string[]).includes(state.settingsPage) ? state.settingsPage as Page : 'general')
  useEffect(() => { if (!getState().ready) void init() }, [])
  if (!ready) return <div className="calendar-settings" role="status">{error || '正在读取日历…'}</div>
  return (
    <div className="calendar-settings" data-testid="calendar-settings">
      <Tabs label="日历设置" value={page} onChange={id => setState({ settingsPage: id })} items={[
        { id: 'general', label: t('general') }, { id: 'profile', label: t('profile') }, { id: 'notifications', label: t('notifications') },
        { id: 'menubar', label: t('menuBar') }, { id: 'conferencing', label: t('conferencingPage') }, { id: 'calendars', label: t('calendarList') },
      ]} />
      {page === 'general' && <General />}
      {page === 'profile' && <Profile />}
      {page === 'notifications' && <Notifications />}
      {page === 'menubar' && <MenuBar />}
      {page === 'conferencing' && <Conferencing />}
      {page === 'calendars' && <><Calendars /><StandaloneImport /></>}
    </div>
  )
}

function SwitchRow({ label, description, checked, onChange }: { label: string; description?: ReactNode; checked: boolean; onChange: (value: boolean) => void }) {
  return <SettingsRow label={label} description={description}><Switch label={label} checked={checked} onChange={onChange} /></SettingsRow>
}
function SelectRow({ label, description, value, choices, onChange, wide }: { label: ReactNode; description?: ReactNode; value: string | number; choices: { value: string; label: string }[]; onChange: (value: string) => void; wide?: boolean }) {
  return <SettingsRow label={label} description={description}>
    <Select className={wide ? 'cal-set-select is-wide' : 'cal-set-select'} aria-label={typeof label === 'string' ? label : undefined} value={String(value)} options={choices} onChange={event => onChange(event.target.value)} />
  </SettingsRow>
}
/** A text preference saved when the field loses focus (or on Enter). */
function TextRow({ label, description, value, placeholder, type, onSave }: { label: string; description?: ReactNode; value: string; placeholder?: string; type?: string; onSave: (value: string) => void }) {
  return <SettingsRow label={label} description={description}>
    <Input className="cal-set-field" aria-label={label} type={type} defaultValue={value} placeholder={placeholder} onBlur={event => onSave(event.target.value.trim())}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
  </SettingsRow>
}

function General() {
  const p = useStore(state => state.prefs), now = useStore(state => state.now)
  return <>
    <SettingsCard title={t('calendarView')} description={t('viewHint')}>
      <SwitchRow label={t('showWeekends')} checked={p.showWeekends} onChange={value => void setPrefs({ showWeekends: value })} />
      <SwitchRow label={t('showDeclined')} checked={p.showDeclined} onChange={value => void setPrefs({ showDeclined: value })} />
      <SwitchRow label={t('showWeekNumbers')} checked={p.showWeekNumbers} onChange={value => void setPrefs({ showWeekNumbers: value })} />
      <SelectRow label={t('weekStartsOn')} value={p.weekStartsOn} choices={options<number>([[0, t('sun')], [1, t('mon')], [6, t('sat')]])} onChange={value => void setPrefs({ weekStartsOn: Number(value) })} />
    </SettingsCard>
    <SettingsCard title={t('calNav')}>
      <SelectRow label={<>{t('press')} <Kbd>T</Kbd> {noColon(t('toDo'))}</>} description={t('alignHint', { k: '⌥T' })} value={p.todayKey}
        choices={options([['today', t('goToday')], ['alignToday', t('alignToday')]])} onChange={value => void setPrefs({ todayKey: value as typeof p.todayKey })} />
      <SelectRow label={noColon(t('showUpcoming'))} description={t('meetingsHint')} value={p.upcomingHours}
        choices={options<number>([1, 2, 4, 8, 12, 24].map(n => [n, `${t('hoursN', { n })} ${t('before')}`]))} onChange={value => void setPrefs({ upcomingHours: Number(value) })} />
    </SettingsCard>
    <SettingsCard>
      <SelectRow label={t('language')} description={t('languageHint')} value={p.locale} choices={options<Locale>([['en', 'English'], ['zh-TW', '中文（繁體）'], ['zh-CN', '中文（简体）']])}
        onChange={value => void setPrefs({ locale: value as Locale, localeChosen: true })} />
      <SelectRow label={t('timeFormat')} value={p.format24HourTime ? 1 : 0}
        choices={options<number>([[0, `${t('h12')}  ${timeOfFull(now, p.primaryTimeZone, false)}`], [1, `${t('h24')}  ${timeOfFull(now, p.primaryTimeZone, true)}`]])}
        onChange={value => void setPrefs({ format24HourTime: value === '1' })} />
      <SelectRow label={t('defaultDuration')} value={p.defaultEventDuration} choices={options<number>([15, 30, 45, 60, 90, 120].map(n => [n, t('minutes', { n })]))}
        onChange={value => void setPrefs({ defaultEventDuration: Number(value) })} />
      <SelectRow label={noColon(t('openLocIn'))} value={p.mapsProvider} choices={options([['google', 'Google Maps'], ['apple', 'Apple Maps'], ['osm', 'OpenStreetMap']])}
        onChange={value => void setPrefs({ mapsProvider: value as typeof p.mapsProvider })} />
    </SettingsCard>
    <SettingsCard title={t('timeZones')} description={<>{t('tzHint')} {t('tzTip', { k: 'Z' })}</>}
      actions={p.additionalTimeZones.length < 3 && <Button size="sm" icon={<Plus />} onClick={() => void setPrefs({ additionalTimeZones: [...p.additionalTimeZones, 'UTC'], showAdditionalTz: true })}>{t('addTz')}</Button>}>
      <SelectRow wide label={t('primaryTz')} value={p.primaryTimeZone} choices={zoneOptions} onChange={value => void setPrefs({ primaryTimeZone: value })} />
      {p.additionalTimeZones.map((zone, index) => <SettingsRow key={zone + index} label={`${t('otherTz')} ${index + 1}`}>
        <span className="cal-set-inline">
          <Select className="cal-set-select is-wide" aria-label={`${t('otherTz')} ${index + 1}`} value={zone} options={zoneOptions}
            onChange={event => void setPrefs({ additionalTimeZones: p.additionalTimeZones.map((other, j) => (j === index ? event.target.value : other)) })} />
          <IconButton icon={<X />} title={t('del')} onClick={() => void setPrefs({ additionalTimeZones: p.additionalTimeZones.filter((_, j) => j !== index) })} />
        </span>
      </SettingsRow>)}
    </SettingsCard>
    <SettingsCard title={t('startup')}>
      <SwitchRow label={t('openAtLogin')} checked={p.openAtLogin} onChange={value => void setPrefs({ openAtLogin: value })} />
    </SettingsCard>
  </>
}

function Profile() {
  const p = useStore(state => state.prefs)
  return <SettingsCard title={t('profile')} description={t('profileHint')}>
    <TextRow label={t('displayName')} value={p.displayName} placeholder={t('displayName')} onSave={value => void setPrefs({ displayName: value })} />
    <TextRow label={t('emailL')} type="email" value={p.email} placeholder="you@example.com" onSave={value => void setPrefs({ email: value })} />
  </SettingsCard>
}

function Conferencing() {
  const p = useStore(state => state.prefs)
  const placeholder = p.videoProvider === 'zoom' ? 'https://zoom.us/j/…' : p.videoProvider === 'meet' ? 'https://meet.google.com/…' : 'https://…'
  return <SettingsCard title={t('conferencingPage')} description={t('confHint')}>
    <SelectRow label={t('defaultVideo')} value={p.videoProvider}
      choices={options([['none', t('none')], ['meet', 'Google Meet'], ['zoom', 'Zoom'], ['teams', 'Microsoft Teams'], ['custom', t('customLink')]])}
      onChange={value => void setPrefs({ videoProvider: value as typeof p.videoProvider })} />
    {p.videoProvider !== 'none' && <TextRow key={p.videoProvider} label={t('personalLink')} value={p.videoUrl} placeholder={placeholder} onSave={value => void setPrefs({ videoUrl: value })} />}
    <SwitchRow label={t('autoAddVideo')} checked={p.autoAddVideo} onChange={value => void setPrefs({ autoAddVideo: value })} />
  </SettingsCard>
}

function Notifications() {
  const p = useStore(state => state.prefs)
  return <SettingsCard title={t('notifications')}>
    <SwitchRow label={t('notifyOn')} description={t('notifyHint')} checked={p.notifications} onChange={value => void setPrefs({ notifications: value })} />
    <SwitchRow label={t('sound')} checked={p.notifySound} onChange={value => void setPrefs({ notifySound: value })} />
    <SelectRow label={t('defReminder')} value={p.defaultReminder} choices={options<number>([[-1, t('none')], ...REMINDER_OPTS.map((m): [number, string] => [m, reminderLabel(m)])])}
      onChange={value => void setPrefs({ defaultReminder: Number(value) })} />
    <SelectRow label={t('defAllDayReminder')} value={p.defaultAllDayReminder} choices={options<number>([[-1, t('none')], [0, reminderLabel(0)], [1440, reminderLabel(1440)], [2880, reminderLabel(2880)]])}
      onChange={value => void setPrefs({ defaultAllDayReminder: Number(value) })} />
  </SettingsCard>
}

function MenuBar() {
  const p = useStore(state => state.prefs)
  return <SettingsCard title={t('menuBar')}>
    <SwitchRow label={t('menuNext')} checked={p.menuBarNext} onChange={value => void setPrefs({ menuBarNext: value })} />
    <SelectRow label={t('menuLen')} value={p.menuBarMaxLen} choices={options<number>([16, 24, 32, 48].map(n => [n, String(n)]))} onChange={value => void setPrefs({ menuBarMaxLen: Number(value) })} />
  </SettingsCard>
}

function Calendars() {
  const calendars = useStore(state => state.calendars), dark = useStore(state => isDark(state))
  const [editing, setEditing] = useState<string | null>(null)
  const colorChoices = (current: string) => [...PALETTE.map(color => ({ value: color.hex, label: color.name })), ...(PALETTE.some(color => color.hex === current) ? [] : [{ value: current, label: current }])]
  return <SettingsCard title={t('onThisMac')} description={t('calsHint')} actions={<>
    <Button size="sm" icon={<Plus />} onClick={() => void addCalendar(t('newCalendar'), PALETTE[(calendars.length * 5) % PALETTE.length].hex)}>{t('addCalendarAcc')}</Button>
    <Button size="sm" variant="ghost" icon={<Download />} onClick={() => void importIcsFile()}>{t('importIcs')}</Button>
    <Button size="sm" variant="ghost" icon={<Upload />} onClick={() => void exportCalendar()}>{t('exportIcs')}</Button>
  </>}>
    {calendars.map(calendar => <SettingsRow key={calendar.id} data-testid="set-cal" label={<span className="cal-set-name">
      <span className="cal-swatch" style={{ ['--sw' as string]: colorFamily(calendar.color, dark).backgroundPrimary }} />
      {editing === calendar.id
        ? <Input autoFocus className="cal-set-field" aria-label={t('rename')} defaultValue={calendar.name}
          onBlur={event => { if (event.target.value.trim()) void updateCalendar(calendar.id, { name: event.target.value.trim() }); setEditing(null) }}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditing(null) }} />
        : <span onDoubleClick={() => setEditing(calendar.id)}>{calendar.name}{calendar.primary ? <span className="cal-set-dim"> · {t('defaultTag')}</span> : null}</span>}
    </span>}>
      <span className="cal-set-inline">
        <Select className="cal-set-select is-narrow" aria-label={`${calendar.name} ${t('colorL')}`} value={calendar.color} options={colorChoices(calendar.color)} onChange={event => void updateCalendar(calendar.id, { color: event.target.value })} />
        <IconButton icon={<Pencil />} title={t('rename')} onClick={() => setEditing(calendar.id)} />
        <IconButton icon={<Upload />} title={t('exportIcs')} onClick={() => void exportCalendar(calendar.id)} />
        {!calendar.primary && <IconButton icon={<Trash2 />} title={t('deleteCalendar')}
          onClick={() => void confirmDialog({ title: `${t('deleteCalendar')}：${calendar.name}`, confirmLabel: t('del'), danger: true }).then(ok => { if (ok) void removeCalendar(calendar.id) })} />}
      </span>
    </SettingsRow>)}
  </SettingsCard>
}

// 迁入 (W4 §4): the one-time move from the standalone calendar app. The original data file is only read; events already
// moved in are neither repeated nor overwritten.
type Preview = { ticket: string; fileName: string; calendars: number; events: number; possibleExamples: number }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

function StandaloneImport() {
  const [preview, setPreview] = useState<Preview | null>(null), [skipExamples, setSkipExamples] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('')
  const choose = async () => {
    setError(''); setDone('')
    try { const next = await unwrap(api().prepareStandaloneImport()); setPreview(next ?? null); setSkipExamples(false) }
    catch (cause) { setError(message(cause)) }
  }
  const apply = async () => {
    if (!preview || busy) return
    setBusy(true); setError('')
    try {
      const result = await unwrap(api().applyStandaloneImport(preview.ticket, skipExamples))
      await reload(); setPreview(null)
      setDone(`已迁入 ${result.created} 条日程，跳过 ${result.skipped} 条已存在的记录。`)
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <SettingsCard title="迁移" aria-label="从独立日历迁入">
    <SettingsRow label="从独立日历迁入" description="把独立日历应用的数据文件迁入 Ready 本地日程。只读取原文件；已经迁入的日程不会重复，也不会被覆盖。">
      {!preview && <Button size="sm" onClick={() => void choose()}>选择数据文件…</Button>}
    </SettingsRow>
    {preview && <SettingsRow label={preview.fileName} description={`${preview.calendars} 个分类，${preview.events} 条日程。`}>
      <span className="cal-set-inline">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>取消</Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void apply()}>确认迁入</Button>
      </span>
    </SettingsRow>}
    {preview && preview.possibleExamples > 0 && <SwitchRow label={`跳过与内置示例同名且未修改的 ${preview.possibleExamples} 条日程`} checked={skipExamples} onChange={setSkipExamples} />}
    {done && <p className="cal-set-note" role="status">{done}</p>}
    {error && <p className="cal-set-note is-bad" role="alert">{error}</p>}
  </SettingsCard>
}
