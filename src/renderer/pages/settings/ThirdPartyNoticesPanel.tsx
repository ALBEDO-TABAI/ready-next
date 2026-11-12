import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ThirdPartyNotice } from '../../../shared/ipc-contracts/third-party-notices'
import { SettingsCard, SettingsGroup, SettingsRow, settingsButtonClass } from './settings-shared'

type Load =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; notices: ThirdPartyNotice[] }
  | { status: 'missing' }
  | { status: 'error'; message: string }

const SHOWN = 200

const keyOf = (notice: ThirdPartyNotice) => `${notice.kind}:${notice.name}@${notice.version ?? ''}`

/** “MIT 1,019 · Apache-2.0 185 · …”: the four most common licenses, the rest counted together. */
function summarizeLicenses(notices: ThirdPartyNotice[]): string {
  const counts = new Map<string, number>()
  for (const notice of notices) counts.set(notice.license || '未声明', (counts.get(notice.license || '未声明') ?? 0) + 1)
  const sorted = [...counts].sort((a, b) => b[1] - a[1])
  const head = sorted.slice(0, 4).map(([license, count]) => `${license} ${count.toLocaleString('zh-CN')}`)
  const rest = sorted.slice(4).reduce((sum, [, count]) => sum + count, 0)
  return [...head, ...(rest ? [`其他 ${rest.toLocaleString('zh-CN')}`] : [])].join(' · ')
}

/**
 * 设置 › 关于 › 开源许可 (M8): the third-party software, fonts and ported code that ship with Ready and their
 * license texts. The notices are generated at packaging time; Main reads them on demand.
 */
export function ThirdPartyNoticesPanel() {
  const [open, setOpen] = useState(false)
  const [load, setLoad] = useState<Load>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (!next || load.status === 'ready' || load.status === 'loading') return
    setLoad({ status: 'loading' })
    window.electronAPI.app.getThirdPartyNotices().then(
      result => setLoad(result.ok ? { status: 'ready', notices: result.notices } : { status: 'missing' }),
      /* silent-catch: the reason is shown in the panel */ error => setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }

  const notices = load.status === 'ready' ? load.notices : null
  const filtered = useMemo(() => {
    if (!notices) return []
    const needle = query.trim().toLowerCase()
    return needle ? notices.filter(notice => notice.name.toLowerCase().includes(needle) || (notice.license ?? '').toLowerCase().includes(needle)) : notices
  }, [notices, query])

  const description = notices
    ? `共 ${notices.length.toLocaleString('zh-CN')} 项：${summarizeLicenses(notices)}`
    : 'Ready 用到的第三方软件、字体和移植代码，以及它们的许可证全文。'

  return <SettingsGroup label="开源许可">
    <SettingsCard aria-label="开源许可">
      <SettingsRow label="第三方声明" description={description}>
        <button type="button" className={settingsButtonClass('secondary')} style={{ minWidth: 104 }} aria-expanded={open} onClick={toggle}>
          {open ? '收起' : '查看'}
        </button>
      </SettingsRow>
      {open && <div className="sx-card__body" style={{ paddingTop: 0 }}>
        {load.status === 'loading' && <p className="sx-meta m-0">正在读取…</p>}
        {load.status === 'missing' && <p className="sx-meta m-0">这份声明在打包时生成，开发版里还没有生成。</p>}
        {load.status === 'error' && <p role="alert" className="sx-text-danger m-0 text-[12px]">读不出声明：{load.message}</p>}
        {notices && <>
          <input className="sx-input w-full" type="search" aria-label="搜索开源许可" placeholder="按名称或许可证筛选"
            value={query} onChange={event => { setQuery(event.target.value); setExpanded(null) }} />
          <ul className="sx-inset m-0 mt-3 list-none p-1" aria-label="第三方声明列表">
            {filtered.slice(0, SHOWN).map(notice => {
              const key = keyOf(notice), isOpen = expanded === key
              return <li key={key}>
                <button type="button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : key)}
                  className="flex w-full items-center gap-2 rounded-[8px] px-3 py-[7px] text-left hover:bg-[var(--sx-raised-hover)]">
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--sx-muted)' }} />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--sx-muted)' }} />}
                  <span className="min-w-0 truncate text-[12.5px]" style={{ color: 'var(--sx-title)' }}>{notice.name}</span>
                  {notice.version && <span className="sx-mono shrink-0 text-[11px]" style={{ color: 'var(--sx-muted)' }}>{notice.version}</span>}
                  <span className="ml-auto shrink-0 text-[11.5px]" style={{ color: 'var(--sx-muted)' }}>
                    {notice.license || '未声明'}{notice.textMissing ? ' · 缺全文' : ''}
                  </span>
                </button>
                {isOpen && <div className="px-3 pb-3 pt-1">
                  {notice.repository && <p className="sx-mono m-0 mb-2 break-all text-[11px]" style={{ color: 'var(--sx-muted)' }}>{notice.repository}</p>}
                  {notice.notes.map(note => <p key={note} className="m-0 mb-2 text-[12px] leading-5" style={{ color: 'var(--sx-muted)' }}>{note}</p>)}
                  {notice.texts.map(text => <pre key={text.path} aria-label={text.path}
                    className="sx-mono m-0 mb-2 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-[8px] px-3 py-2 text-[11px] leading-5"
                    style={{ color: 'var(--sx-muted)', background: 'var(--sx-raised-hover)' }}>{text.content}</pre>)}
                  {!notice.texts.length && <p className="m-0 text-[12px]" style={{ color: 'var(--sx-muted)' }}>上游没有附许可证全文。</p>}
                </div>}
              </li>
            })}
          </ul>
          {filtered.length > SHOWN && <p className="sx-meta m-0 mt-2">还有 {(filtered.length - SHOWN).toLocaleString('zh-CN')} 项，输入名称筛选。</p>}
          {!filtered.length && <p className="sx-meta m-0 mt-2">没有匹配的项。</p>}
        </>}
      </div>}
    </SettingsCard>
  </SettingsGroup>
}
