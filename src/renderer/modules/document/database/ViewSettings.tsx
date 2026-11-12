import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui'
import { DatabaseDefinitionSchema, fieldValue, type DatabaseDefinition, type DatabaseView, type Calculation } from '../../../../shared/document-database'

const viewTypes: { type: DatabaseView['type']; label: string }[] = [{ type: 'table', label: '表格' }, { type: 'board', label: '看板' }, { type: 'calendar', label: '日历' }, { type: 'timeline', label: '时间线' }, { type: 'gallery', label: '画廊' }, { type: 'list', label: '列表' }, { type: 'bookshelf', label: '书架' }]
const operations: Calculation[] = ['count', 'sum', 'average', 'min', 'max', 'unique']
const operators = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty'] as const
export function ViewSettings({ definition, view, busy, section, onSave, onClose }: {
  definition: DatabaseDefinition; view: DatabaseView; busy: boolean
  /** The toolbar's 筛选 and 排序 open the panel at their section. */
  section?: 'filters' | 'sorts'
  onSave(view: DatabaseView): Promise<boolean>; onClose(): void
}) {
  const [draft, setDraft] = useState(view)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!section) return
    const target = form.current?.querySelector<HTMLElement>(`[data-settings-section="${section}"]`)
    target?.scrollIntoView?.({ block: 'nearest' })
    target?.querySelector<HTMLElement>('select, input, button')?.focus()
  }, [section])
  const [error, setError] = useState('')
  const [filterText, setFilterText] = useState<Record<number, string>>({})
  const fields = [{ id: '$title', name: '标题', type: 'text' }, { id: '$id', name: '身份', type: 'text' }, ...Object.values(definition.fields)]
  const options = fields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)
  const first = fields[0].id
  const setFilter = (index: number, patch: Partial<NonNullable<DatabaseView['filters']>[number]>) => setDraft({ ...draft, filters: draft.filters?.map((f, i) => i === index ? { ...f, ...patch } : f) })
  const toggleField = (key: 'visibleFields' | 'cardFields', id: string) => {
    const current = draft[key] ?? (key === 'visibleFields' ? fields.map(f => f.id) : [])
    setDraft({ ...draft, [key]: current.includes(id) ? current.filter(f => f !== id) : [...current, id] })
  }
  return <form ref={form} role="dialog" aria-label="视图设置" className="rdb-settings" onSubmit={e => {
    e.preventDefault()
    try {
      const filters = draft.filters?.map((filter, i) => {
        if (['empty', 'not_empty'].includes(filter.operator) || filterText[i] === undefined) return filter
        const raw = filterText[i], field = Object.values(definition.fields).find(f => f.id === filter.field)
        let value: unknown = raw
        if (field?.type === 'number') value = raw.trim() === '' ? null : Number(raw)
        else if (field?.type === 'checkbox' || ['relation', 'multi_select'].includes(field?.type ?? '') && filter.operator !== 'contains' || field?.type === 'date' && raw.startsWith('{')) value = JSON.parse(raw)
        else if (['formula', 'rollup'].includes(field?.type ?? '') && /^(?:-?\d|true$|false$|null$|\[)/.test(raw)) value = JSON.parse(raw)
        if (field && !['formula', 'rollup'].includes(field.type)) fieldValue(field, ['relation', 'multi_select'].includes(field.type) && filter.operator === 'contains' ? [value] : value)
        return { ...filter, value }
      })
      const next = { ...draft, ...(filters ? { filters } : {}) }
      const checked = DatabaseDefinitionSchema.parse({ ...definition, views: definition.views.map(v => v.id === view.id ? next : v) })
      void onSave(checked.views.find(v => v.id === view.id)!).then(ok => { if (ok) onClose() })
    } catch (reason) { setError(String(reason)) }
  }}>
    <strong>{view.name} · 视图设置</strong>
    <label>视图类型<select aria-label="视图类型" value={draft.type} onChange={e => { const next = viewTypes.find(v => v.type === e.target.value); if (next) setDraft({ ...draft, type: next.type }) }}>{viewTypes.map(v => <option key={v.type} value={v.type}>{v.label}</option>)}</select></label>
    <fieldset data-settings-section="filters"><legend>筛选 · 全部满足</legend>{draft.filters?.map((filter, i) => <div className="rdb-rule" key={i}>
      <select aria-label={`筛选字段 ${i + 1}`} value={filter.field} onChange={e => { setFilter(i, { field: e.target.value, value: undefined }); setFilterText({ ...filterText, [i]: '' }) }}>{options}</select>
      <select aria-label={`筛选条件 ${i + 1}`} value={filter.operator} onChange={e => { const operator = operators.find(op => op === e.target.value); if (operator) setFilter(i, { operator }) }}>{operators.map(op => <option key={op}>{op}</option>)}</select>
      {!['empty', 'not_empty'].includes(filter.operator) && <input aria-label={`筛选值 ${i + 1}`} value={filterText[i] ?? (filter.value == null ? '' : typeof filter.value === 'object' ? JSON.stringify(filter.value) : String(filter.value))} onChange={e => setFilterText({ ...filterText, [i]: e.target.value })} />}
      <button type="button" aria-label={`删除筛选 ${i + 1}`} onClick={() => { setDraft({ ...draft, filters: draft.filters?.filter((_, index) => index !== i) }); setFilterText(Object.fromEntries(Object.entries(filterText).filter(([index]) => Number(index) !== i).map(([index, value]) => [Number(index) > i ? Number(index) - 1 : Number(index), value]))) }}>移除</button>
    </div>)}<button type="button" aria-label="添加筛选" onClick={() => setDraft({ ...draft, filters: [...draft.filters ?? [], { field: first, operator: 'contains', value: '' }] })}>＋ 筛选</button></fieldset>
    <fieldset data-settings-section="sorts"><legend>排序 · 从上到下</legend>{draft.sorts?.map((sort, i) => <div className="rdb-rule" key={i}>
      <select aria-label={`排序字段 ${i + 1}`} value={sort.field} onChange={e => setDraft({ ...draft, sorts: draft.sorts?.map((s, index) => index === i ? { ...s, field: e.target.value } : s) })}>{options}</select>
      <select aria-label={`排序方向 ${i + 1}`} value={sort.direction} onChange={e => setDraft({ ...draft, sorts: draft.sorts?.map((s, index) => index === i ? { ...s, direction: e.target.value === 'desc' ? 'desc' : 'asc' } : s) })}><option value="asc">升序</option><option value="desc">降序</option></select>
      <button type="button" onClick={() => setDraft({ ...draft, sorts: draft.sorts?.filter((_, index) => index !== i) })}>移除</button>
    </div>)}<button type="button" aria-label="添加排序" onClick={() => setDraft({ ...draft, sorts: [...draft.sorts ?? [], { field: first, direction: 'asc' }] })}>＋ 排序</button></fieldset>
    <label>分组<select aria-label="分组字段" value={draft.groupBy ?? ''} onChange={e => setDraft({ ...draft, groupBy: e.target.value || undefined })}><option value="">不分组</option>{options}</select></label>
    {['calendar', 'timeline'].includes(draft.type) && <label>日期字段<select aria-label="日期字段" value={draft.dateField ?? ''} onChange={e => setDraft({ ...draft, dateField: e.target.value || undefined })}><option value="">请选择</option>{fields.filter(f => f.type === 'date').map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
    <fieldset><legend>列计算</legend>{draft.calculations?.map((calc, i) => <div className="rdb-rule" key={i}>
      <select aria-label={`计算字段 ${i + 1}`} value={calc.field} onChange={e => setDraft({ ...draft, calculations: draft.calculations?.map((c, index) => index === i ? { ...c, field: e.target.value } : c) })}>{options}</select>
      <select aria-label={`计算方式 ${i + 1}`} value={calc.operation} onChange={e => { const operation = operations.find(op => op === e.target.value); if (operation) setDraft({ ...draft, calculations: draft.calculations?.map((c, index) => index === i ? { ...c, operation } : c) }) }}>{operations.map(op => <option key={op}>{op}</option>)}</select>
      <button type="button" onClick={() => setDraft({ ...draft, calculations: draft.calculations?.filter((_, index) => index !== i) })}>移除</button>
    </div>)}<button type="button" aria-label="添加列计算" onClick={() => setDraft({ ...draft, calculations: [...draft.calculations ?? [], { field: first, operation: 'count' }] })}>＋ 列计算</button></fieldset>
    {(['visibleFields', 'cardFields'] as const).map(key => <fieldset key={key}><legend>{key === 'visibleFields' ? '可见列' : '卡片字段'}</legend><div className="rdb-options">{fields.map(f => <label key={f.id}><input type="checkbox" checked={(draft[key] ?? (key === 'visibleFields' ? fields.map(field => field.id) : [])).includes(f.id)} onChange={() => toggleField(key, f.id)} />{f.name}</label>)}</div></fieldset>)}
    {error && <p role="alert">{error}</p>}
    <div className="rdb-actions"><Button size="sm" onClick={onClose}>取消</Button><Button size="sm" variant="primary" type="submit" aria-label="保存视图设置" disabled={busy}>保存设置</Button></div>
  </form>
}
