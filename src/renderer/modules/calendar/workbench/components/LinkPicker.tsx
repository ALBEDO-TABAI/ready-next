import { useEffect, useState, type KeyboardEvent } from 'react'
import { CalendarLinkTargetSchema } from '../../../../../shared/calendar/event-links'
import type { ReadyRef } from '../../../../../shared/ready-ref'
import { Input } from '../../../../components/ui/Field'
import { findReferences } from '../../../document/block-editor/references'

// The event panel's "+": the same search as @ in a page (pages, documents, boards and other Ready references), with
// no address to paste (W4 §4, O9). Only targets an event can link to are offered.
type Choice = { id: string; label: string; detail: string; ref: ReadyRef }

export function LinkPicker({ choose, close }: { choose(ref: ReadyRef, label: string): void; close(): void }) {
  const [query, setQuery] = useState(''), [choices, setChoices] = useState<Choice[]>([])
  const [active, setActive] = useState(0), [pending, setPending] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let live = true
    if (!query.trim()) { setChoices([]); setPending(false); return }
    setPending(true)
    const timer = setTimeout(() => {
      findReferences(query, false).then(found => {
        if (!live) return
        setChoices(found.flatMap(item => item.reference.kind === 'ready' && CalendarLinkTargetSchema.safeParse(item.reference.ref).success
          ? [{ id: item.id, label: item.label, detail: item.detail, ref: item.reference.ref }] : []))
        setActive(0); setError('')
      }, cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)) })
        .finally(() => { if (live) setPending(false) })
    }, 120)
    return () => { live = false; clearTimeout(timer) }
  }, [query])
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, choices.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); const choice = choices[active]; if (choice) choose(choice.ref, choice.label) }
    else if (event.key === 'Escape') { event.preventDefault(); close() }
  }
  return <div className="rn-menu cal-link-picker">
    <Input data-autofocus aria-label="搜索关联" placeholder="搜索页面、文档或画板" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown}
      role="combobox" aria-expanded={choices.length > 0} aria-controls="cal-link-results" aria-activedescendant={choices[active] ? `cal-link-${active}` : undefined} />
    <div id="cal-link-results" role="listbox" aria-label="关联结果">
      {choices.map((choice, index) => <button key={choice.id} id={`cal-link-${index}`} type="button" role="option" aria-selected={index === active}
        className="rn-menu__item" data-highlighted={index === active || undefined} onMouseEnter={() => setActive(index)} onClick={() => choose(choice.ref, choice.label)}>
        <span className="rn-menu__label">{choice.label}</span><span className="rn-menu__hint">{choice.detail}</span>
      </button>)}
    </div>
    {error ? <p role="alert" className="cal-link-note">{error}</p>
      : !choices.length && <p className="cal-link-note">{pending ? '正在搜索…' : query.trim() ? '没有找到' : '输入名称搜索资料库'}</p>}
  </div>
}
