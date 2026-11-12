import { readReadyRefTransfer, writeReadyRefTransfer, toReadyUri, type ReadyRef } from '../../../../../shared/ready-ref'
import type { LayerEntry, LayerReply, TodoEntry, TodoWriteReceipt } from '../../../../../shared/calendar-layers'
import { openDialog } from '../../../../components/ui'
import { getState, setPrefs } from '../store'

// To-dos are Markdown checkboxes in library pages (W4 §5, D14). These helpers write through Main's to-do
// service, which changes only the checkbox or the date in that one line.

/** A to-do dragged from the sidebar list or the tasks layer onto a day. */
let draggedTodo: { handle: TodoHandle; uri: string } | null = null
export function writeTodoTransfer(data: Pick<DataTransfer, 'setData'>, handle: TodoHandle, ref: ReadyRef) {
  draggedTodo = { handle, uri: toReadyUri(ref) }
  writeReadyRefTransfer(data, ref, handle.title)
}
export function endTodoTransfer() { draggedTodo = null }

export interface TodoHandle { id: string; version: string; title: string; obsidian: boolean }

export function todoFromList(todo: TodoEntry): TodoHandle {
  return { id: todo.id, version: todo.version, title: todo.title, obsidian: todo.dateSource === 'obsidian' }
}

export function todoFromLayer(entry: LayerEntry): TodoHandle | null {
  if (entry.layer !== 'tasks' || !entry.version) return null
  return { id: entry.id, version: entry.version, title: entry.title.replace(/^[☐☑]\s*/, ''), obsidian: entry.readOnlyReason === 'obsidian_date_needs_consent' }
}

export function readDraggedTodo(data: DataTransfer): TodoHandle | null {
  const dropped = readReadyRefTransfer(data)
  return dropped && draggedTodo?.uri === toReadyUri(dropped.ref) ? draggedTodo.handle : null
}

function failure(reply: Extract<LayerReply<unknown>, { ok: false }>): Error {
  const message = reply.code === 'version_conflict' ? '这一项刚刚在别处改过，列表已重新读取，请再试一次'
    : reply.code === 'dirty_conflict' ? '这一页有未保存的修改改动了这一项，请先保存那一页'
      : reply.message
  return new Error(message)
}

export type RewriteChoice = 'once' | 'always' | null

/** Asks once before an Obsidian 📅 date is rewritten as a Ready date link; the caller remembers "always". */
export function askRewrite(title: string): Promise<RewriteChoice> {
  return new Promise(resolve => {
    let decided = false
    const decide = (choice: RewriteChoice) => () => { decided = true; resolve(choice) }
    openDialog({
      title: '改写这一项的日期？',
      body: <p>“{title}”用的是 Obsidian 的日期写法（📅）。改期会把它改写成 Ready 的日期链接，Obsidian 的任务插件之后不再把它算作那一天的任务。</p>,
      onClose: () => { if (!decided) resolve(null) },
      actions: [
        { label: '取消', variant: 'ghost', onClick: decide(null) },
        { label: '只改这一次', onClick: decide('once') },
        { label: '改写，以后不再问', variant: 'primary', autoFocus: true, onClick: decide('always') },
      ],
    })
  })
}

/** Gives the to-do a date (or moves it). Resolves null when the person declined the Obsidian rewrite. */
export async function scheduleTodo(handle: TodoHandle, date: string, ask: (title: string) => Promise<RewriteChoice> = askRewrite): Promise<TodoWriteReceipt['state'] | null> {
  const api = window.electronAPI.calendarLayers
  const allowed = getState().prefs.rewriteObsidianDates === true
  let reply = await api.scheduleTodo({ id: handle.id, expectedVersion: handle.version, date, ...(allowed ? { rewriteObsidianDate: true as const } : {}) })
  if (!reply.ok && reply.code === 'obsidian_date_needs_consent') {
    const choice = await ask(handle.title)
    if (!choice) return null
    if (choice === 'always') setPrefs({ rewriteObsidianDates: true })
    reply = await api.scheduleTodo({ id: handle.id, expectedVersion: handle.version, date, rewriteObsidianDate: true })
  }
  if (!reply.ok) throw failure(reply)
  return reply.value.state
}

export async function toggleTodo(handle: TodoHandle, checked: boolean): Promise<TodoWriteReceipt['state']> {
  const reply = await window.electronAPI.calendarLayers.toggleTodo({ id: handle.id, expectedVersion: handle.version, checked })
  if (!reply.ok) throw failure(reply)
  return reply.value.state
}
