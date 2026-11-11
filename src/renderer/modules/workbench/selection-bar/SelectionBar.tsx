import { useState, type ReactNode } from 'react'
import { Highlighter, Inbox, MessageSquareQuote, Shapes, TextQuote } from 'lucide-react'
import { Button, Toolbar, ToolbarSeparator } from '../../../components/ui'
import type { CaptureSelection } from '../capture'
import { askAboutSelection, receiveToCanvas, receiveToDocument, receiveToFastCard, reportCaptureError } from '../capture-receipt'

export interface SelectionBarExtra {
  id: string
  label: string
  icon: ReactNode
  run: () => void | Promise<void>
  /** An extra that opens something inside the scene (书房's 批注) leaves the bar where it is. */
  keepsOpen?: boolean
}
export interface SelectionBarProps {
  /** The selection as a capture (reference, title, words), read when an action runs. */
  read: () => CaptureSelection | null
  /** 划线: the scene's own highlight; its source page and marks stay what they were. */
  highlight: () => Promise<void>
  /** 问 AI, when the scene hands its passage to the assistant its own way (书房), or names it (资讯's “· 选区”). */
  ask?: () => Promise<void>
  /** The scene's own actions, after the shared ones (翻译, 批注 …). */
  extras?: SelectionBarExtra[]
  /** After an action ran: the scene closes the bar or clears its selection. */
  onDone?: () => void
}

/**
 * The one selection bar of the four reading scenes (W6 §3.2): web page, 资讯, 书房 and PDF. Fixed order and names —
 * 划线, 存入 FastCard, 引用到文档, 问 AI — then 保存到画板 and the scene's own extras. Pressing a button keeps the
 * selection (no focus change), so every action reads the words that are still selected.
 */
export function SelectionBar({ read, highlight, ask, extras = [], onDone }: SelectionBarProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const selected = () => {
    const selection = read()
    if (!selection) throw new Error('选区已经变了，请重新选择文字')
    return selection
  }
  const run = (id: string, work: () => void | Promise<unknown>, keepsOpen = false) => async () => {
    if (busy) return
    setBusy(id)
    try { await work(); if (!keepsOpen) onDone?.() }
    catch (error) { reportCaptureError(error) }
    finally { setBusy(null) }
  }
  const actions: Array<{ id: string; label: string; icon: ReactNode; run: () => Promise<void> }> = [
    { id: 'highlight', label: '划线', icon: <Highlighter />, run: run('highlight', highlight) },
    { id: 'fastcard', label: '存入 FastCard', icon: <Inbox />, run: run('fastcard', () => receiveToFastCard(selected())) },
    { id: 'document', label: '引用到文档', icon: <TextQuote />, run: run('document', () => receiveToDocument(selected())) },
    { id: 'ask', label: '问 AI', icon: <MessageSquareQuote />, run: run('ask', () => ask ? ask() : askAboutSelection(selected())) },
  ]
  const more = [
    { id: 'canvas', label: '保存到画板', icon: <Shapes />, run: run('canvas', () => receiveToCanvas(selected())) },
    ...extras.map(extra => ({ id: extra.id, label: extra.label, icon: extra.icon, run: run(extra.id, extra.run, extra.keepsOpen) })),
  ]
  const button = (action: (typeof actions)[number]) => (
    <Button key={action.id} size="sm" variant="ghost" icon={action.icon} data-selection-action={action.id} disabled={busy !== null}
      onMouseDown={event => event.preventDefault()} onClick={() => { void action.run() }}>{action.label}</Button>
  )
  return <div className="rn-ui rn-float rn-selection-bar" data-ready-selection-bar="">
    <Toolbar label="选中的文字">{actions.map(button)}<ToolbarSeparator />{more.map(button)}</Toolbar>
  </div>
}
