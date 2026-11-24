import { useCallback, useEffect, useRef, useState } from 'react'
import { UserStateSchema, resolveInlineView, type DatabaseField, type DatabaseView } from '../../../../shared/document-database'
import { databaseAPI, request, SnapshotSchema, QuerySchema, WriteSchema, CreatedSchema, savePersonal, observeDatabase, publishDatabase, type DatabaseAPI, type Snapshot, type Query, type PersonalState, type ViewRow, type PendingBuffer } from './access'
import { ArrowUpDown, FileText, ListFilter, Search, Settings2, Sparkles } from 'lucide-react'
import { Button, IconButton, tooltip } from '../../../components/ui'
import { CellEditor } from './CellEditor'
import { cellText } from './cell-text'
import { CellValue, ViewIcon } from './cells'
import { subscribeDocumentDirectoryChanges } from '../directoryChangeBridge'
import { releaseDirectoryWatch, watchDirectoriesFor } from '../directoryWatchRegistry'
import { ViewSettings } from './ViewSettings'
import { TableView, CardViews, TimeViews, Calculations, type ViewProps } from './Views'
import { addDatabaseRowsToAgentInput } from '../../agent/chat-input-bridge'

// Each row is sent as its own page; keep a view's hand-off to a readable size.
const ASK_ROWS = 25

interface DatabaseProps {
  databaseId: string
  api?: DatabaseAPI
  initialViewId?: string
  viewName?: string
  inline?: boolean
  ancestors?: { databaseId: string; viewId: string }[]
}
const noAncestors: NonNullable<DatabaseProps['ancestors']> = []
const buffers = new WeakMap<DatabaseAPI, Map<string, Map<string, PendingBuffer>>>()
function pendingFor(api: DatabaseAPI, id: string) {
  let databases = buffers.get(api)
  if (!databases) { databases = new Map(); buffers.set(api, databases) }
  let rows = databases.get(id)
  if (!rows) { rows = new Map(); databases.set(id, rows) }
  return rows
}
type Loaded = { snapshot: Snapshot; query: Query; view: DatabaseView; personal: PersonalState }
export function Database(props: DatabaseProps) {
  return <DatabaseContent key={`${props.databaseId}:${props.viewName ?? ''}:${props.initialViewId ?? ''}`} {...props} />
}
function DatabaseContent({ databaseId, api = databaseAPI, initialViewId, viewName, inline = false, ancestors = noAncestors }: DatabaseProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [settings, setSettings] = useState<false | 'all' | 'filters' | 'sorts'>(false)
  const [search, setSearch] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ row: ViewRow; field: DatabaseField } | null>(null)
  const [creating, setCreating] = useState<{ operationId: string; title: string; submitted: boolean } | null>(null)
  const origin = useRef(Symbol('database-view'))
  const selected = useRef(initialViewId)
  const generation = useRef(0), active = useRef(true), writing = useRef(false)
  const personalTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const personalPatch = useRef<PersonalState>({})
  const pending = pendingFor(api, databaseId)
  const fail = useCallback((reason: unknown) => {
    if (!active.current) return
    const message = String(reason)
    setError(message)
    if (/conflict|冲突/.test(message)) setConflict(true)
  }, [])
  const load = useCallback(async () => {
    const turn = ++generation.current
    const [snapshot, personal] = await Promise.all([
      request(api, { type: 'read', databaseId }, SnapshotSchema),
      request(api, { type: 'getState', databaseId }, UserStateSchema),
    ])
    const view = viewName !== undefined ? resolveInlineView(databaseId, snapshot.definition, viewName, ancestors)
      : snapshot.definition.views.find(v => v.id === (selected.current ?? personal.currentViewId)) ?? snapshot.definition.views[0]
    const query = await request(api, { type: 'query', databaseId, viewId: view.id, offset: 0, limit: 1000 }, QuerySchema)
    if (query.version !== snapshot.version) throw new Error('version_conflict: 库定义已被修改，请刷新')
    // Query paging is capped at 1000 by Main; never silently discard additional rows.
    while (query.rows.length < query.total) {
      const page = await request(api, { type: 'query', databaseId, viewId: view.id, offset: query.rows.length, limit: 1000 }, QuerySchema)
      if (page.version !== query.version || page.total !== query.total || !page.rows.length) throw new Error('version_conflict: 查询期间数据库已变动，请刷新')
      query.rows.push(...page.rows)
    }
    if (!active.current || turn !== generation.current) return
    for (const [id, buffer] of pending) if (snapshot.rows.find(r => r.id === id)?.version === buffer.version) pending.delete(id)
    selected.current = view.id
    setLoaded({ snapshot, query, view, personal })
  }, [api, databaseId, viewName, ancestors, pending])
  useEffect(() => {
    active.current = true; setLoaded(null); selected.current = initialViewId
    void load().catch(fail)
    const stop = observeDatabase((source, change) => {
      if (source !== api || change.databaseId !== databaseId || change.origin === origin.current) return
      void load().catch(fail)
    })
    return () => { active.current = false; stop() }
  }, [api, databaseId, initialViewId, load, fail, pending])
  const flushPersonal = useCallback(async () => {
    if (personalTimer.current) clearTimeout(personalTimer.current)
    personalTimer.current = null
    const patch = personalPatch.current; personalPatch.current = {}
    if (!Object.keys(patch).length) return
    const personal = await savePersonal(api, databaseId, patch)
    if (active.current) setLoaded(current => current ? { ...current, personal } : current)
  }, [api, databaseId])
  useEffect(() => () => { void flushPersonal().catch(reason => console.error('Database personal state save failed', reason)) }, [flushPersonal])
  // The view follows the disk (W3 §4.4: no 刷新 button): a change inside its row folder or to a file named like it
  // reloads it, debounced; a write of its own is already reloaded by mutate().
  const source = loaded?.snapshot.definition.source, sourcePath = loaded?.snapshot.sourcePath?.replace(/\\/g, '/')
  useEffect(() => {
    if (!sourcePath) return
    const owner = Symbol('database-rows')
    watchDirectoriesFor(owner, [sourcePath])
    return () => releaseDirectoryWatch(owner)
  }, [sourcePath])
  useEffect(() => {
    if (!source) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const touches = (path: string) => {
      const file = path.replace(/\\/g, '/')
      return sourcePath ? file === sourcePath || file.startsWith(`${sourcePath}/`) : file.split('/').some(part => part === source)
    }
    const stop = subscribeDocumentDirectoryChanges(event => {
      if (!event.paths.some(touches)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void refresh() }, 250)
    })
    return () => { stop(); if (timer) clearTimeout(timer) }
  }, [source, sourcePath]) // eslint-disable-line react-hooks/exhaustive-deps
  const updatePersonal = (patch: PersonalState) => {
    personalPatch.current = { ...personalPatch.current, ...patch, ...(patch.widths ? { widths: { ...personalPatch.current.widths, ...patch.widths } } : {}) }
    setLoaded(current => current ? { ...current, personal: { ...current.personal, ...patch, ...(patch.widths ? { widths: { ...current.personal.widths, ...patch.widths } } : {}) } } : current)
    if (personalTimer.current) clearTimeout(personalTimer.current)
    personalTimer.current = setTimeout(() => { void flushPersonal().catch(fail) }, 150)
  }
  const mutate = async (work: () => Promise<void>): Promise<boolean> => {
    if (writing.current || pending.size || conflict) return false
    writing.current = true; setBusy(true); setError('')
    try { await work(); await load(); publishDatabase(api, { databaseId, origin: origin.current }); return true }
    catch (reason) { console.error('[Database] write database view failed:', reason instanceof Error ? reason.message : String(reason)); fail(reason); return false }
    finally { writing.current = false; if (active.current) setBusy(false) }
  }
  const setField = async (row: ViewRow, fieldId: string, value: unknown) => mutate(async () => {
    const set = { [fieldId]: value }
    const receipt = await request(api, { type: 'setFields', databaseId, rowId: row.id, expectedVersion: row.version, set }, WriteSchema)
    if (receipt.state === 'unsaved') {
      const buffer = { rowId: row.id, version: receipt.afterVersion, set }
      pending.set(row.id, buffer)
    }
  })
  const refresh = async () => { if (writing.current) return; setError(''); try { await load(); setConflict(false); setEditing(null) } catch (reason) { console.error('[Database] refresh database view failed:', reason instanceof Error ? reason.message : String(reason)); fail(reason) } }
  const open = (row: ViewRow) => { void api.openRow(row.id).catch(fail) }
  if (!loaded) return <div className="ready-database" aria-busy={!error}>{error ? <><p role="alert">{error}</p><button onClick={() => { void refresh() }}>重试</button></> : <p role="status">正在读取数据库…</p>}</div>
  const { snapshot, query, view, personal } = loaded
  const disabled = busy || pending.size > 0 || conflict
  const fields = new Map(Object.values(snapshot.definition.fields).map(field => [field.id, field]))
  const cell = (row: ViewRow, id: string) => {
    if (id === '$title') return <button className="rdb-title" onClick={() => open(row)}><FileText className="rdb-title-icon" aria-hidden /><span className="rdb-title-text">{row.title || '未命名'}</span></button>
    const field = fields.get(id), buffer = pending.get(row.id)
    const value = buffer && Object.hasOwn(buffer.set, id) ? { status: 'value' as const, value: buffer.set[id] } : row.cells[id]
    if (!field || field.type === 'formula' || field.type === 'rollup') return <span data-field-id={id} aria-readonly="true">{buffer && field ? '待保存后计算' : cellText(value)}</span>
    return <button className={`rdb-cell rdb-cell-${field.type}`} data-field-id={id} disabled={disabled} title={cellText(value)} aria-label={`${field.name}：${cellText(value)}`} onClick={() => setEditing({ row, field })}><CellValue field={field} cell={value} /></button>
  }
  // 搜索 narrows what this view shows (title and cell text); it never changes the saved view.
  const needle = search?.trim().toLocaleLowerCase()
  const kept = needle ? new Set(query.rows.filter(row => [row.title, ...Object.values(row.cells).map(cellText)].some(text => text.toLocaleLowerCase().includes(needle))).map(row => row.id)) : null
  const shown = kept ? { ...query, rows: query.rows.filter(row => kept.has(row.id)), groups: query.groups.map(group => ({ ...group, rowIds: group.rowIds.filter(id => kept.has(id)) })), total: kept.size } : query
  const props: ViewProps = { definition: snapshot.definition, query: shown, view, personal, disabled, cell, open, setField: (row, field, value) => { void setField(row, field, value) }, savePersonal: updatePersonal }
  const reread = <button type="button" className="rdb-reread" aria-label="重新读取数据库" disabled={busy} onClick={() => { void refresh() }}>重新读取</button>
  const saveView = async (next: DatabaseView) => mutate(async () => {
    await request(api, { type: 'setDefinition', databaseId, expectedVersion: snapshot.version, definition: { ...snapshot.definition, views: snapshot.definition.views.map(v => v.id === next.id ? next : v) } }, WriteSchema)
  })
  const editingCell = editing?.row.cells[editing.field.id]
  return <section className={`ready-database ${inline ? 'is-inline' : 'is-page'}`} data-own-drops data-database-id={databaseId} data-view-type={view.type} aria-label={inline ? `内联数据库 ${view.name}` : '数据库'}>
    <header className="rdb-toolbar">
      <div className="rdb-tabs" role="tablist" aria-label="数据库视图">{(viewName !== undefined ? [view] : snapshot.definition.views).map(v => <button role="tab" aria-selected={v.id === view.id} data-view-id={v.id} key={v.id} className="rdb-tab" disabled={busy} onClick={() => {
        if (v.id === view.id) return
        selected.current = v.id; setEditing(null); setSettings(false)
        void (async () => { await flushPersonal(); await savePersonal(api, databaseId, { currentViewId: v.id, scroll: { x: 0, y: 0 } }); await load() })().catch(fail)
      }}><ViewIcon type={v.type} />{v.name}</button>)}</div>
      <div className="rdb-tools">
        <IconButton title="筛选" active={!!view.filters?.length} disabled={disabled} icon={<ListFilter aria-hidden />} onClick={() => setSettings(current => current === 'filters' ? false : 'filters')} />
        <IconButton title="排序" active={!!view.sorts?.length} disabled={disabled} icon={<ArrowUpDown aria-hidden />} onClick={() => setSettings(current => current === 'sorts' ? false : 'sorts')} />
        <IconButton title="搜索" active={search !== null} icon={<Search aria-hidden />} onClick={() => setSearch(current => current === null ? '' : null)} />
        {search !== null && <input className="rn-field rdb-search" aria-label="搜索行" placeholder="搜索标题与内容" autoFocus value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearch(null) }} />}
        <IconButton title="视图设置" disabled={disabled} icon={<Settings2 aria-hidden />} onClick={() => setSettings(current => current === 'all' ? false : 'all')} />
        <IconButton title="把当前视图发给 AI" {...tooltip(query.total > ASK_ROWS ? `问 AI：发送前 ${ASK_ROWS} 行` : '问 AI')} disabled={busy || !query.rows.length} icon={<Sparkles aria-hidden />} onClick={() => {
          void addDatabaseRowsToAgentInput({ title: snapshot.definition.source || '数据库', objectId: databaseId }, query.rows.slice(0, ASK_ROWS).map(row => ({ title: row.title, objectId: row.id }))).catch(fail)
        }} />
        <Button size="sm" variant="primary" className="rdb-new" aria-label="新建行" disabled={disabled} onClick={() => setCreating({ operationId: crypto.randomUUID(), title: '', submitted: false })}>新建</Button>
      </div>
    </header>
    <div className="rdb-status" role="status">{busy ? '正在保存…' : conflict ? '有冲突' : pending.size ? '有改动待保存' : '已保存'}<span>{query.total} 行</span></div>
    {error && <p role="alert" className="rdb-notice">{error}{conflict && reread}</p>}
    {!!pending.size && <p className="rdb-notice">请先保存原页面；当前修改尚未写入磁盘。保存后会自动更新。{reread}</p>}
    {!!query.issues.length && <details className="rdb-issues"><summary>{query.issues.length} 个字段需要处理</summary>{query.issues.map((issue, i) => <p key={i}>{issue.rowId} / {issue.fieldId}：{cellText(issue.cell)}</p>)}</details>}
    {settings && <ViewSettings key={`settings:${view.id}`} definition={snapshot.definition} view={view} busy={busy} section={settings === 'all' ? undefined : settings} onSave={saveView} onClose={() => setSettings(false)} />}
    {view.type === 'table' ? <TableView key={view.id} {...props} /> : view.type === 'calendar' || view.type === 'timeline' ? <TimeViews key={view.id} {...props} /> : <CardViews {...props} />}
    {view.type === 'table' && <button type="button" className="rdb-add-row" disabled={disabled} onClick={() => setCreating({ operationId: crypto.randomUUID(), title: '', submitted: false })}>＋ 新页面</button>}
    {shown.total === 0 && <p className="rdb-empty">{kept ? '没有匹配搜索的页面。' : '没有符合条件的页面。'}</p>}
    {!pending.size && <Calculations query={query} definition={snapshot.definition} />}
    {editing && <CellEditor key={`${editing.row.id}:${editing.field.id}`} field={editing.field} value={editingCell?.status === 'value' ? editingCell.value : undefined} api={api} busy={disabled} onSave={value => setField(editing.row, editing.field.id, value)} onClose={() => setEditing(null)} />}
    {creating && <form className="rdb-editor" role="dialog" aria-label="新建页面" onSubmit={e => {
      e.preventDefault()
      if (!creating.title.trim()) return
      setCreating({ ...creating, submitted: true })
      void mutate(async () => {
        await request(api, { type: 'createRow', databaseId, operationId: creating.operationId, title: creating.title, values: {}, body: '' }, CreatedSchema)
        setCreating(null)
      })
    }}><strong>新建页面</strong><input aria-label="页面标题" autoFocus required value={creating.title} disabled={creating.submitted} onChange={e => setCreating({ ...creating, title: e.target.value })} /><div className="rdb-actions"><Button size="sm" disabled={busy} onClick={() => setCreating(null)}>关闭</Button><Button size="sm" variant="primary" type="submit" aria-label="确认新建" disabled={disabled}>{creating.submitted ? '重试同一次新建' : '创建'}</Button></div></form>}
  </section>
}
