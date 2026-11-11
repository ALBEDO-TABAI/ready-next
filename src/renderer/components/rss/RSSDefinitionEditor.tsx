import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { RSSDefinition, RSSDefinitionWrite } from '../../../shared/rss-organization'
import { RSS_DEFINITION_ICONS, RSS_ICON_LABELS } from './organization-icons'
import RSSTopbarTools from './RSSTopbarTools'

const blank = (): RSSDefinitionWrite => ({ name: '', description: '', icon: 'tag', visible: true, position: 100, filterIds: [] })
const edit = (definition: RSSDefinition): RSSDefinitionWrite => ({ id: definition.id, expectedRevision: definition.revision,
  name: definition.name, description: definition.description, icon: definition.icon, visible: definition.visible, position: definition.position, filterIds: definition.filterIds })

// 栏目管理：内容框里的独立视图。左列是全部栏目，右侧是当前栏目的表单。
export default function RSSDefinitionEditor({ definitions, initialId, onSaved, onClose, active = true }: {
  definitions: RSSDefinition[]; initialId?: string; onSaved(deletedId?: string): void; onClose(): void; active?: boolean
}) {
  const [draft, setDraft] = useState<RSSDefinitionWrite>(() => {
    const initial = definitions.find((definition) => definition.id === initialId)
    return initial ? edit(initial) : blank()
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const selected = definitions.find((definition) => definition.id === draft.id)
  const semantic = !selected || selected.kind === 'topic' || selected.kind === 'curated'
  const topics = definitions.filter((entry) => entry.kind === 'topic')
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
  const choose = (definition: RSSDefinition | null) => { setDraft(definition ? edit(definition) : blank()); setMessage('') }
  return <section className="rss-definition-editor" aria-label="栏目设置">
    <RSSTopbarTools slot="lead" show={active}><span>筛子设置 · 主题</span></RSSTopbarTools>
    <nav className="rss-definition-list" aria-label="选择编辑栏目">
      <button type="button" className="rss-definition-new" aria-current={!draft.id ? 'true' : undefined} disabled={busy} onClick={() => choose(null)}>
        <Plus size={15} strokeWidth={1.9} /><span>新建主题</span>
      </button>
      <p>全部栏目</p>
      {definitions.map((definition) => {
        const Icon = RSS_DEFINITION_ICONS[definition.icon]
        return <button type="button" key={definition.id} aria-current={draft.id === definition.id ? 'true' : undefined} disabled={busy} onClick={() => choose(definition)}>
          <Icon size={15} strokeWidth={1.8} /><span>{definition.name}</span>{!definition.visible && <small>已隐藏</small>}
        </button>
      })}
    </nav>
    <div className="rss-definition-main">
      <form className="rss-definition-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1>{selected ? selected.name : '新建主题'}</h1>
            <p>{selected
              ? semantic ? '描述是模型判断资讯是否属于这个栏目的标准；只改名称、图标或顺序不会重新整理。' : '内置栏目可以改名、调整顺序和图标，其含义保持不变。'
              : `新主题会同时加入“${definitions.find((entry) => entry.kind === 'all')?.name || '全部动态'}”的顶部筛选，之后可调整。`}</p>
          </div>
          <button type="button" className="sx-btn sx-btn--ghost sx-btn--sm" aria-label="关闭栏目设置" onClick={onClose}>完成</button>
        </header>
        <fieldset disabled={busy} className="grid gap-[22px] border-0 p-0 m-0">
          <label className="rss-definition-field"><span>名称</span>
            <input className="sx-input" aria-label="名称" required maxLength={80} value={draft.name} placeholder="例如：AI 视频制作" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="rss-definition-field"><span>描述与归类标准</span>
            <textarea className="sx-textarea" aria-label="描述与归类标准" required={semantic} disabled={!semantic} maxLength={2000} value={draft.description}
              placeholder="关注什么、排除什么。例如：关注模型更新、实际制作流程和可复用案例，排除单纯融资消息。"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </label>
          <div className="rss-definition-field">
            <span id="rss-definition-icon-label">图标</span>
            <div className="rss-definition-icons" role="radiogroup" aria-labelledby="rss-definition-icon-label">
              {Object.entries(RSS_ICON_LABELS).map(([value, label]) => {
                const Icon = RSS_DEFINITION_ICONS[value as keyof typeof RSS_DEFINITION_ICONS]
                return <button type="button" role="radio" key={value} aria-label={label} title={label} aria-checked={draft.icon === value}
                  onClick={() => setDraft({ ...draft, icon: value as RSSDefinitionWrite['icon'] })}><Icon size={16} strokeWidth={1.8} /></button>
              })}
            </div>
          </div>
          <div className="rss-definition-field rss-definition-field--inline">
            <div><span className="text-[12.5px] font-medium" style={{ color: 'var(--text-body)' }}>在左侧显示</span>
              <small className="block text-[12px]" style={{ color: 'var(--text-muted)', marginTop: 2 }}>隐藏不会删除栏目或其中的资讯。</small></div>
            <button type="button" role="switch" aria-label="在左侧显示" aria-checked={draft.visible} className="sx-switch" data-checked={draft.visible ? 'true' : 'false'}
              disabled={selected?.kind === 'all'} onClick={() => setDraft({ ...draft, visible: !draft.visible })} />
          </div>
          <label className="rss-definition-field rss-definition-field--inline">
            <div><span className="text-[12.5px] font-medium" style={{ color: 'var(--text-body)' }}>顺序</span>
              <small className="block text-[12px]" style={{ color: 'var(--text-muted)', marginTop: 2 }}>数字越小越靠前。</small></div>
            <input className="sx-input" aria-label="顺序" type="number" min={0} value={draft.position} onChange={(event) => setDraft({ ...draft, position: Number(event.target.value) })} />
          </label>
          <div className="rss-definition-field">
            <span>此栏顶部的分类筛选</span>
            <div className="rss-definition-filters">
              {topics.map((topic) => {
                const on = draft.filterIds?.includes(topic.id) || false
                return <button type="button" key={topic.id} aria-pressed={on} onClick={() => setDraft({ ...draft, filterIds: on ? draft.filterIds?.filter((id) => id !== topic.id) : [...(draft.filterIds || []), topic.id] })}>{topic.name}</button>
              })}
              {topics.length === 0 && <p>还没有自定义主题。新建主题后可在这里选择。</p>}
            </div>
          </div>
        </fieldset>
        <div className="rss-definition-actions">
          <button type="submit" className="sx-btn sx-btn--primary" disabled={busy}>{busy ? '正在保存' : '保存栏目'}</button>
          {selected && <button type="button" className="sx-btn sx-btn--ghost" disabled={busy} onClick={() => setDraft(edit(selected))}>重新载入</button>}
          {selected?.kind === 'topic' && <button type="button" className="sx-btn sx-btn--ghost sx-btn--quiet-danger" disabled={busy} onClick={() => void save(true)}>删除分类</button>}
          {message && <p role="status">{message}</p>}
        </div>
      </form>
    </div>
  </section>
}
