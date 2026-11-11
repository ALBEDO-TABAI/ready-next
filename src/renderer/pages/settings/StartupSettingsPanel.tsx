import { useEffect, useState } from 'react'
import { Check, History, Sun } from 'lucide-react'
import { readStartupView, STARTUP_VIEW_SETTING_KEY, type StartupView } from '../../modules/today/startup'
import { SettingsGroup } from './settings-shared'

const OPTIONS: Array<{ value: StartupView; label: string; description: string; icon: typeof Sun }> = [
  { value: 'today', label: '启动时打开今日页', description: '先看今天的日程与待办、为你筛过的资讯和接着要做的事。', icon: Sun },
  { value: 'last', label: '回到上次的位置', description: '回到上次关闭时所在的模式和页面。', icon: History },
]

/** 设置 › 启动 (W6 §5.1): where Ready opens. Main keeps the choice; it takes effect at the next launch. */
export function StartupSettingsPanel() {
  const [view, setView] = useState<StartupView | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void readStartupView().then(value => { if (alive) setView(value) }, cause => { if (alive) setError(String(cause)) })
    return () => { alive = false }
  }, [])
  const choose = async (next: StartupView) => {
    const result = await window.electronAPI.settings.set(STARTUP_VIEW_SETTING_KEY, next)
    if (result.success) { setView(next); setError('') } else setError(result.error || '设置保存失败')
  }
  return <SettingsGroup>
    <div role="radiogroup" aria-label="打开 Ready 时" className="grid grid-cols-2 gap-3">
      {OPTIONS.map(option => {
        const Icon = option.icon, checked = view === option.value
        return <button key={option.value} type="button" role="radio" aria-checked={checked} aria-label={option.label} disabled={view === null}
          className="sx-option flex-col" style={{ gap: 6 }} onClick={() => { void choose(option.value) }}>
          <span className="flex items-center gap-2">
            <Icon className="h-[15px] w-[15px]" strokeWidth={1.75} style={{ color: checked ? 'var(--sx-accent)' : 'var(--sx-muted)' }} />
            <span className="text-[13px]" style={{ color: 'var(--sx-title)', fontWeight: checked ? 600 : 500 }}>{option.label}</span>
          </span>
          <span className="text-[12px] leading-5" style={{ color: 'var(--sx-muted)' }}>{option.description}</span>
          <span className="sx-option__tick" aria-hidden><Check /></span>
        </button>
      })}
    </div>
    {error && <p role="alert" className="sx-text-danger mt-2 text-[12px]">{error}</p>}
  </SettingsGroup>
}
