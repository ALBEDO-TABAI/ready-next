import { useState } from 'react'
import type { RSSDefinition, RSSDefinitionWrite } from '../../../shared/rss-organization'
import { RSS_ICON_LABELS } from './organization-icons'

const blank = (): RSSDefinitionWrite => ({ name: '', description: '', icon: 'tag', visible: true, position: 100, filterIds: [] })
const edit = (definition: RSSDefinition): RSSDefinitionWrite => ({ id: definition.id, expectedRevision: definition.revision,
  name: definition.name, description: definition.description, icon: definition.icon, visible: definition.visible, position: definition.position, filterIds: definition.filterIds })

export default function RSSDefinitionEditor({ definitions, onSaved, onClose }: {
  definitions: RSSDefinition[]; onSaved(deletedId?: string): void; onClose(): void
}) {
  const [draft, setDraft] = useState<RSSDefinitionWrite>(blank)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const selected = definitions.find((definition) => definition.id === draft.id)
  const semantic = !selected || selected.kind === 'topic' || selected.kind === 'curated'
  const save = async (remove = false) => {
    setBusy(true); setMessage('')
    try {
      if (remove && selected) {
        const result = await window.electronAPI.rss.removeDefinition({ id: selected.id, expectedRevision: draft.expectedRevision! })
        if (!result.success || !result.data) throw new Error(result.error || '删除失败')
        onSaved(result.data.id); setDraft(blank()); setMessage('已删除分类，原文和收藏保留。')
      } else {
        const result = await window.electronAPI.rss.saveDefinition(draft)
        if (!result.success || !result.data) throw new Error(result.error || '保存失败')
        onSaved(); setDraft(edit(result.data)); setMessage('已保存。修改标准不会自动重算历史资讯。')
      }
    } catch (error) { /* silent-catch: keep the draft and show the save failure inline. */ setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="rss-definition-editor glass-surface-floating" aria-label="栏目设置">
    <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="rss-definition-actions">
        <strong>栏目与分类</strong>
        <select aria-label="选择编辑栏目" disabled={busy} value={draft.id || ''} onChange={(event) => { setDraft(event.target.value ? edit(definitions.find((entry) => entry.id === event.target.value)!) : blank()); setMessage('') }}>
          <option value="">新建主题</option>{definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}{definition.visible ? '' : '（已隐藏）'}</option>)}
        </select>
        <button type="button" className="rss-reader-button" onClick={onClose}>关闭栏目设置</button>
      </div>
      {!draft.id && <p>新主题会同时加入“{definitions.find((entry) => entry.kind === 'all')?.name || '全部动态'}”的顶部筛选，之后可调整。</p>}
      <fieldset disabled={busy} className="rss-definition-grid">
        <label>名称<input aria-label="名称" required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>描述与归类标准<textarea aria-label="描述与归类标准" required={semantic} disabled={!semantic} maxLength={2000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label>图标<select aria-label="图标" value={draft.icon} onChange={(event) => setDraft({ ...draft, icon: event.target.value as RSSDefinitionWrite['icon'] })}>{Object.entries(RSS_ICON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>顺序<input aria-label="顺序" type="number" min={0} value={draft.position} onChange={(event) => setDraft({ ...draft, position: Number(event.target.value) })} /></label>
        <label className="rss-definition-check"><input type="checkbox" disabled={selected?.kind === 'all'} checked={draft.visible} onChange={(event) => setDraft({ ...draft, visible: event.target.checked })} />在左侧显示</label>
        <div><span>此栏顶部的分类筛选</span><div className="rss-definition-filters">{definitions.filter((entry) => entry.kind === 'topic').map((topic) => <label className="rss-definition-check" key={topic.id}>
          <input type="checkbox" checked={draft.filterIds?.includes(topic.id) || false} onChange={(event) => setDraft({ ...draft, filterIds: event.target.checked ? [...(draft.filterIds || []), topic.id] : draft.filterIds?.filter((id) => id !== topic.id) })} />{topic.name}
        </label>)}</div></div>
      </fieldset>
      <div className="rss-definition-actions">
        <button type="submit" className="rss-reader-button" disabled={busy}>{busy ? '正在保存' : '保存栏目'}</button>
        {selected && <button type="button" className="rss-reader-button" disabled={busy} onClick={() => setDraft(edit(selected))}>重新载入</button>}
        {selected?.kind === 'topic' && <button type="button" className="rss-reader-button" disabled={busy} onClick={() => void save(true)}>删除分类</button>}
        {message && <p role="status">{message}</p>}
      </div>
    </form>
  </section>
}
