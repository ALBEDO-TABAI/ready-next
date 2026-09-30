import { useEffect, useRef, useState } from 'react'
import type { RSSArticleSummary } from '../../../shared/rss-workspace'
import type { RSSReadEventsResult, RSSEventMembership, RSSEventSummary } from '../../../shared/rss-events'
import { toRSSItem } from '../../modules/rss/workspace-query'
import type { RSSItem } from './RSSFeed'
import Modal from '../ui/Modal'
import { useModal } from '../ui/useModal'

export default function RSSEventPanel({ article, active, onSelect }: { article: RSSArticleSummary; active: boolean; onSelect?(item: RSSItem): void }) {
  const [open, setOpen] = useState(false), [membership, setMembership] = useState<RSSEventMembership | undefined>(article.event)
  const [members, setMembers] = useState<Extract<RSSReadEventsResult, { view: 'members' }> | null>(null)
  const [facts, setFacts] = useState<Extract<RSSReadEventsResult, { view: 'facts' }> | null>(null)
  const [targets, setTargets] = useState<(Extract<RSSReadEventsResult, { view: 'list' }> & { search: string }) | null>(null), [search, setSearch] = useState(''), [target, setTarget] = useState<RSSEventSummary | null>(null)
  const [targetFacts, setTargetFacts] = useState<Extract<RSSReadEventsResult, { view: 'facts' }> | null>(null), [targetFactId, setTargetFactId] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [fresh, setFresh] = useState(false)
  const [quote, setQuote] = useState(article.event?.quote && !article.event.stale ? article.event.quote : article.title.slice(0, 600))
  const quoteDirty = useRef(false)
  const identity = useRef(''), generation = useRef(0), targetGeneration = useRef(0), navigationGeneration = useRef(0)
  const acknowledged = useRef(new Set<string>())
  identity.current = `${article.id}:${article.revision}:${active}:${open}`
  const { modalProps, showConfirm } = useModal()
  const refresh = async () => {
    const key = identity.current, ticket = ++generation.current
    const result = await window.electronAPI.rss.readArticle({ itemId: article.id, expectedRevision: article.revision, length: 1 })
    if (key !== identity.current || ticket !== generation.current) return
    if (!result.success || !result.data) { setFresh(false); throw new Error('文章已变化，请重新读取文章后调整。') }
    setMembership(result.data.article.event); setFresh(true)
    if (!quoteDirty.current) setQuote(result.data.article.event?.quote && !result.data.article.event.stale ? result.data.article.event.quote : article.title.slice(0, 600))
    const eventId = result.data.article.event?.eventId
    if (!open || !eventId) { setMembers(null); setFacts(null); return }
    const [rows, evidence] = await Promise.all([window.electronAPI.rss.readEvents({ view: 'members', eventId }), window.electronAPI.rss.readEvents({ view: 'facts', eventId })])
    if (key !== identity.current || ticket !== generation.current) return
    if (!rows.success || rows.data?.view !== 'members' || !evidence.success || evidence.data?.view !== 'facts' || rows.data.revision !== evidence.data.revision) throw new Error('事件资料已变化，请重新读取。')
    setMembers(rows.data); setFacts(evidence.data)
  }
  useEffect(() => {
    let live = true
    setError(''); setBusy(false); setFresh(!open)
    if (!active) return
    const read = () => { void refresh().catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) }) }
    if (open) read()
    const off = window.electronAPI.rss.onOrganizationChanged(read)
    return () => { live = false; ++generation.current; ++targetGeneration.current; ++navigationGeneration.current; off() }
  }, [article.id, article.revision, active, open])
  useEffect(() => { setMembership(article.event); setTarget(null); setTargetFacts(null); setTargets(null); setTargetFactId(''); setSearch(''); quoteDirty.current = false; setQuote(article.event?.quote && !article.event.stale ? article.event.quote : article.title.slice(0, 600)) }, [article.id, article.revision])
  useEffect(() => {
    if (!active) return
    const ids = [...new Set([
      ...(!membership?.stale && membership?.articleRevision === article.revision && membership.factId ? [membership.factId] : []),
      ...(open ? facts?.facts.filter((fact) => !fact.seen).map((fact) => fact.id) || [] : []),
    ])].filter((id) => !acknowledged.current.has(id)).slice(0, 100)
    if (!ids.length) return
    const key = identity.current
    ids.forEach((id) => acknowledged.current.add(id))
    void window.electronAPI.rss.markEventFactsSeen({ factIds: ids }).then((result) => {
      if (!result.success || !result.data) throw new Error(result.error || '查看进展的状态未保存')
      const saved = result.data.seenIds
      if (ids.some((id) => !saved.includes(id))) { if (key === identity.current) setError('部分事实已变化，请重新读取事件。'); return }
      if (key === identity.current) setFacts((current) => current ? { ...current, facts: current.facts.map((fact) => saved.includes(fact.id) ? { ...fact, seen: true } : fact) } : null)
    }).catch((reason) => {
      ids.forEach((id) => acknowledged.current.delete(id))
      if (key === identity.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [active, article.revision, membership, open, facts])
  const action = async (run: () => Promise<{ success: boolean; error?: string }>) => {
    const key = identity.current; setBusy(true); setError('')
    try { const response = await run(); if (!response.success) throw new Error(response.error || '调整未保存'); if (key === identity.current) await refresh() }
    catch (reason) { if (key === identity.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (key === identity.current) setBusy(false) }
  }
  const selectTarget = async (value: RSSEventSummary | null) => {
    const key = identity.current, ticket = ++targetGeneration.current
    setTarget(value); setTargetFacts(null); setTargetFactId(''); setError('')
    if (!value) return
    const result = await window.electronAPI.rss.readEvents({ view: 'facts', eventId: value.id, expectedRevision: value.revision, limit: 100 })
    if (key !== identity.current || ticket !== targetGeneration.current) return
    if (!result.success || result.data?.view !== 'facts') { setTarget(null); setError('目标事件已变化，请重新搜索。'); return }
    setTargetFacts(result.data)
  }
  const findTargets = async (more = false) => {
    const key = identity.current, ticket = ++targetGeneration.current
    setError('')
    const appliedSearch = more ? targets?.search || '' : search
    const result = await window.electronAPI.rss.readEvents({ view: 'list', search: appliedSearch, limit: 100, offset: more ? targets?.nextOffset || 0 : 0, expectedRevision: more ? targets?.revision : undefined })
    if (key !== identity.current || ticket !== targetGeneration.current) return
    if (!result.success || result.data?.view !== 'list') throw new Error(result.error || '事件目录读取失败')
    const data = result.data
    setTargets((previous) => ({ ...data, search: appliedSearch, events: more && previous ? [...previous.events, ...data.events] : data.events }))
    if (!more) { setTarget(null); setTargetFacts(null); setTargetFactId('') }
  }
  const moreTargetFacts = async () => {
    const current = targetFacts, key = identity.current, ticket = ++targetGeneration.current
    if (!current?.nextOffset) return
    const response = await window.electronAPI.rss.readEvents({ view: 'facts', eventId: current.summary.id, expectedRevision: current.revision, offset: current.nextOffset, limit: 100 })
    if (key !== identity.current || ticket !== targetGeneration.current) return
    if (!response.success || response.data?.view !== 'facts') throw new Error('目标事实已变化，请重新选择事件。')
    const data = response.data
    setTargetFacts((previous) => ({ ...data, facts: [...(previous?.facts || []), ...data.facts] }))
  }
  const move = (destination: RSSEventSummary | null) => action(async () => {
    const response = await window.electronAPI.rss.moveEventMember({ itemId: article.id, expectedArticleRevision: article.revision, quote,
      expectedMembershipRevision: membership?.revision || 0, targetEventId: destination?.id || null, expectedEventRevision: destination?.revision,
      targetFactId: destination && targetFactId ? targetFactId : undefined })
    if (response.success) quoteDirty.current = false
    return response
  })
  const merge = async () => {
    const from = members?.summary, into = target, key = identity.current
    if (!from || !into || from.id === into.id) return
    if (!await showConfirm(`将当前事件的 ${from.memberCount} 篇报道、${from.factCount} 个事实并入“${into.title}”。保留不同事实和原文，不批量标记已读。`, '合并整个事件') || key !== identity.current) return
    await action(() => window.electronAPI.rss.mergeEvents({ fromEventId: from.id, expectedFromRevision: from.revision, intoEventId: into.id, expectedIntoRevision: into.revision }))
  }
  const more = async (view: 'members' | 'facts') => {
    const current = view === 'members' ? members : facts, key = identity.current, ticket = ++generation.current
    if (!current?.nextOffset) return
    const result = await window.electronAPI.rss.readEvents({ view, eventId: current.summary.id, expectedRevision: current.revision, offset: current.nextOffset })
    if (key !== identity.current || ticket !== generation.current) return
    if (!result.success || !result.data) throw new Error('事件已变化，请重新读取。')
    if (result.data.view === 'members') { const next = result.data; setMembers((old) => ({ ...next, members: [...(old?.members || []), ...next.members] })) }
    if (result.data.view === 'facts') { const next = result.data; setFacts((old) => ({ ...next, facts: [...(old?.facts || []), ...next.facts] })) }
  }
  const showArticle = async (id: string, expectedRevision?: string) => {
    const key = identity.current, ticket = ++navigationGeneration.current
    try {
      const response = await window.electronAPI.rss.readArticle({ itemId: id, expectedRevision, length: 1 })
      if (key !== identity.current || ticket !== navigationGeneration.current) return
      if (!response.success || !response.data) throw new Error('该版本全文已变化；保留的历史摘句仍可在事件中读取。')
      onSelect?.(toRSSItem(response.data.article))
    } catch (reason) { if (key === identity.current && ticket === navigationGeneration.current) throw reason }
  }
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))
  const read = (run: () => Promise<unknown>) => {
    const key = identity.current
    void run().catch((reason) => { if (key === identity.current) report(reason) })
  }
  return <section className="rss-event-panel">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>事件与进展 · {membership ? membership.eventId ? membership.manual ? '手工归组' : '已归组' : '证据不足，保持独立' : '尚未判断'} {open ? '收起' : '展开'}</button>
    {open && <>
      {membership && <p>{membership.reason}{membership.stale ? ' · 原文已变化，旧依据不是当前版本。' : ''}</p>}
      {facts && <><h4>事实与进展（{facts.total}）</h4><ul>{facts.facts.map((fact) => <li key={fact.id}>
        <blockquote>{fact.quote}</blockquote><small>{fact.source} · {fact.historical ? '历史版本摘句；全文已更新' : '当前版本依据'}{fact.sourceRole === 'direct' ? ' · 发布方（模型判断）' : ''}</small>
        {!fact.historical && onSelect && <button onClick={() => read(() => showArticle(fact.itemId, fact.articleRevision))}>读取依据文章</button>}
      </li>)}</ul>{facts.nextOffset !== null && <button onClick={() => read(() => more('facts'))}>更多事实与进展</button>}</>}
      {members && <><h4>全部关联报道（{members.total}，包含待更新关联）</h4><ul>{members.members.map((member) => <li key={member.itemId}>
        <button disabled={!onSelect} onClick={() => read(() => showArticle(member.itemId))}>{member.title}</button><small>{member.read ? '已读' : '未读'}{member.stale ? ' · 关联依据需更新' : ''}</small>
      </li>)}</ul>{members.nextOffset !== null && <button onClick={() => read(() => more('members'))}>更多报道</button>}</>}
      <div className="rss-event-actions">
        <label>归组依据摘句<textarea aria-label="归组依据摘句" maxLength={600} value={quote} onChange={(event) => { quoteDirty.current = true; setQuote(event.target.value) }} /></label>
        <button disabled={busy || !fresh || !quote.trim()} onClick={() => void move(null)}>拆为独立事件</button>
        <input aria-label="搜索目标事件" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="标题或事实关键词" />
        <button disabled={busy} onClick={() => read(() => findTargets())}>搜索事件</button>
        <select aria-label="目标事件" value={target?.id || ''} onChange={(event) => { const id = event.target.value; read(() => selectTarget(targets?.events.find((entry) => entry.id === id) || null)) }}>
          <option value="">选择目标事件</option>{targets?.events.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}（{entry.memberCount}篇 / {entry.factCount}事实）</option>)}
        </select>
        {targets?.nextOffset != null && <button onClick={() => read(() => findTargets(true))}>更多目标事件</button>}
        {targetFacts && <select aria-label="并入事实方式" value={targetFactId} onChange={(event) => setTargetFactId(event.target.value)}><option value="">保留为独立事实</option>{targetFacts.facts.map((fact) => <option key={fact.id} value={fact.id}>同一事实：{fact.quote}</option>)}</select>}
        {targetFacts?.nextOffset != null && <button onClick={() => read(moreTargetFacts)}>更多目标事实</button>}
        <button disabled={busy || !fresh || !quote.trim() || !target || !targetFacts} onClick={() => void move(target)}>并入所选事件</button>
        <button disabled={busy || !fresh || !target || !members || target.id === members.summary.id} onClick={() => read(merge)}>合并当前整个事件</button>
      </div>
    </>}
    {error && <p role="alert">{error}<button onClick={() => read(refresh)}>重新读取事件</button></p>}
    <Modal {...modalProps} />
  </section>
}
