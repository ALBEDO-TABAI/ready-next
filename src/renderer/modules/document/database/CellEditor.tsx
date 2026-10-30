import { useEffect, useState } from 'react'
import { fieldValue, type DatabaseField } from '../../../../shared/document-database'
import { dateRange } from './moves'
import type { DatabaseAPI, PageChoice } from './access'

export function CellEditor({ field, value, api, busy, onSave, onClose }: {
  field: DatabaseField; value: unknown; api: DatabaseAPI; busy: boolean
  onSave(value: unknown): Promise<boolean>; onClose(): void
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  const [selected, setSelected] = useState<string[]>(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState(value === true)
  const range = field.type === 'date' ? dateRange(value) : null
  const [start, setStart] = useState(range?.start ?? '')
  const [end, setEnd] = useState(typeof value === 'object' && value ? range?.end ?? '' : '')
  const [pages, setPages] = useState<PageChoice[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (field.type !== 'relation') return
    let live = true
    api.pages().then(result => { if (live) setPages(result) }, reason => { if (live) setError(String(reason)) })
    return () => { live = false }
  }, [api, field.type])
  const save = async () => {
    try {
      const next = field.type === 'number' ? text.trim() === '' ? null : Number(text)
        : field.type === 'checkbox' ? checked
          : field.type === 'multi_select' || field.type === 'relation' ? selected
            : field.type === 'date' ? start ? end ? { start, end } : start : null
              : field.type === 'select' && !text ? null : text
      fieldValue(field, next)
      if (await onSave(next)) onClose()
    } catch (reason) { setError(String(reason)) }
  }
  const toggle = (option: string) => setSelected(current => current.includes(option) ? current.filter(v => v !== option) : [...current, option])
  return <form className="rdb-editor" role="dialog" aria-label={`编辑${field.name}`} onSubmit={e => { e.preventDefault(); void save() }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
    <strong>{field.name}</strong>
    {field.type === 'checkbox' ? <label><input aria-label="字段值" type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />已勾选</label>
      : field.type === 'select' && field.options ? <select aria-label="字段值" value={text} onChange={e => setText(e.target.value)}><option value="">未填写</option>{field.options.map(option => <option key={option}>{option}</option>)}</select>
        : field.type === 'multi_select' || field.type === 'relation' ? <>
          {field.type === 'relation' && <input aria-label="搜索页面" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索页面" />}
          <div className="rdb-options">{(field.type === 'relation' ? pages.filter(page => page.title.includes(search) || page.reference.includes(search)).map(page => ({ value: page.reference, label: `${page.title} · ${page.reference}` })) : (field.options ?? selected).map(option => ({ value: option, label: option }))).map(option => <label key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)} />{option.label}</label>)}</div>
          {field.type === 'multi_select' && !field.options && <input aria-label="新增选项" placeholder="输入选项后回车" onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); const v = e.currentTarget.value.trim(); if (v) setSelected(current => [...new Set([...current, v])]); e.currentTarget.value = '' } }} />}
          {!!selected.length && <button type="button" onClick={() => setSelected([])}>清空选择</button>}
        </> : field.type === 'date' ? <><label>开始<input aria-label="开始日期" value={start} onChange={e => setStart(e.target.value)} placeholder="YYYY-MM-DD 或含时区时间" /></label><label>结束<input aria-label="结束日期" value={end} onChange={e => setEnd(e.target.value)} placeholder="可留空" /></label></>
          : <input autoFocus aria-label="字段值" type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'} step="any" value={text} onChange={e => setText(e.target.value)} />}
    {error && <p role="alert">{error}</p>}
    <div className="rdb-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button aria-label="保存单元格" disabled={busy} type="submit">保存</button></div>
  </form>
}
