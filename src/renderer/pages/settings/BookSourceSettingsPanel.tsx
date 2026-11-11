import { Suspense, useEffect, useState } from 'react'
import type { BookSourcesAPI, SourceSettings, SourceStatus } from '../../../shared/library-sources'
import { confirmed } from '../../modules/library/access'
import { ExtraSourceSettings } from '../../modules/library/find/build-feature'
import { sourceFormats } from '../../modules/library/find/source-ui'
import { SettingsCard, SettingsNotice, SettingsRow, SettingsStatus, settingsButtonClass, type SettingsTone } from './settings-shared'

const STATUS: Record<SourceStatus['state'], { text: string; tone: SettingsTone }> = {
  missing: { text: '未安装', tone: 'muted' },
  logged_out: { text: '未登录', tone: 'warning' },
  available: { text: '可用', tone: 'accent' },
  error: { text: '连接失败', tone: 'danger' },
}

export function BookSourceSettingsPanel({ api = window.electronAPI.bookSources }: { api?: BookSourcesAPI }) {
  const [value, setValue] = useState<SourceSettings | null>(null)
  const [extra, setExtra] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<SourceStatus | null>(null)
  useEffect(() => {
    let live = true
    api.settings().then(confirmed).then(data => { if (live) { setValue(data.settings); setExtra(data.extraSources) } }).catch(error => { if (live) setError(String(error)) })
    api.status().then(confirmed).then(data => { if (live) setStatus(data) }).catch(error => { if (live) setError(String(error)) })
    return () => { live = false }
  }, [api])
  const save = async () => {
    if (!value) return
    setBusy(true); setError('')
    try { setValue(confirmed(await api.configure(value))); setStatus(confirmed(await api.status())) }
    catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  return <SettingsCard title="书源" description="在书房找书时使用。Ready 不保存账号密码。">
    <SettingsRow label="Z-Library" description="请在终端安装并登录 zlib">
      <SettingsStatus tone={status ? STATUS[status.state].tone : 'muted'}>{status ? STATUS[status.state].text : '正在检查连接…'}</SettingsStatus>
    </SettingsRow>
    {status?.error && <SettingsNotice tone="warning">{status.error}</SettingsNotice>}
    {value && <>
      <SettingsRow label="可执行文件路径" description="留空则在 PATH 中查找 zlib">
        <input className="sx-input sx-input--mono" aria-label="zlib 路径" placeholder="zlib" value={value.executable} onChange={e => setValue({ ...value, executable: e.target.value })} />
      </SettingsRow>
      <SettingsRow label="默认格式">
        <select className="sx-select" aria-label="默认格式" value={value.format} onChange={e => { const format = sourceFormats.find(format => format === e.target.value); if (format) setValue({ ...value, format }) }}>
          {sourceFormats.map(format => <option key={format}>{format}</option>)}
        </select>
      </SettingsRow>
      {extra && ExtraSourceSettings && <Suspense fallback={<SettingsStatus tone="muted">加载中…</SettingsStatus>}><ExtraSourceSettings value={value} onChange={setValue} /></Suspense>}
      <div className="sx-card__footer">
        <button type="button" className={settingsButtonClass('primary')} disabled={busy} onClick={() => void save()}>{busy ? '保存并检查中…' : '保存并检查连接'}</button>
      </div>
    </>}
    {error && <SettingsNotice tone="danger">{error}</SettingsNotice>}
  </SettingsCard>
}
