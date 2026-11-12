import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { RSSDefinition, RSSDefinitionWrite } from '../../../shared/rss-organization'
import { RSS_DEFINITION_ICONS, RSS_ICON_LABELS } from './organization-icons'
import RSSTopbarTools from './RSSTopbarTools'
import { Button, IconButton } from '../ui/Button'
import { Input, Textarea } from '../ui/Field'
import { Switch } from '../ui/Toggle'
import { Chip } from '../ui/Display'
import { ListRow } from '../ui/Structure'

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
      <ListRow className="rss-definition-new" icon={<Plus />} label="新建主题" current={!draft.id} disabled={busy} onClick={() => choose(null)} />
      <p>全部栏目</p>
      {definitions.map((definition) => {
        const Icon = RSS_DEFINITION_ICONS[definition.icon]
        return <ListRow key={definition.id} icon={<Icon />} label={<>{definition.name}{!definition.visible && <small className="rss-definition-hidden">已隐藏</small>}</>}
          current={draft.id === definition.id} disabled={busy} onClick={() => choose(definition)} />
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
          <Button variant="ghost" size="sm" aria-label="关闭栏目设置" onClick={onClose}>完成</Button>
        </header>
        <fieldset disabled={busy} className="grid gap-[22px] border-0 p-0 m-0">
          <label className="rss-definition-field"><span>名称</span>
            <Input aria-label="名称" required maxLength={80} value={draft.name} placeholder="例如：AI 视频制作" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="rss-definition-field"><span>描述与归类标准</span>
            <Textarea aria-label="描述与归类标准" required={semantic} disabled={!semantic} maxLength={2000} value={draft.description}
              placeholder="关注什么、排除什么。例如：关注模型更新、实际制作流程和可复用案例，排除单纯融资消息。"
              onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </label>
          <div className="rss-definition-field">
            <span id="rss-definition-icon-label">图标</span>
            <div className="rss-definition-icons" role="radiogroup" aria-labelledby="rss-definition-icon-label">
              {Object.entries(RSS_ICON_LABELS).map(([value, label]) => {
                const Icon = RSS_DEFINITION_ICONS[value as keyof typeof RSS_DEFINITION_ICONS]
                return <IconButton size="lg" role="radio" key={value} title={label} aria-checked={draft.icon === value} icon={<Icon />}
                  onClick={() => setDraft({ ...draft, icon: value as RSSDefinitionWrite['icon'] })} />
              })}
            </div>
          </div>
          <div className="rss-definition-field rss-definition-field--inline">
            <div><span>在左侧显示</span><small>隐藏不会删除栏目或其中的资讯。</small></div>
            <Switch label="在左侧显示" checked={Boolean(draft.visible)} disabled={selected?.kind === 'all'} onChange={(visible) => setDraft({ ...draft, visible })} />
          </div>
          <label className="rss-definition-field rss-definition-field--inline">
            <div><span>顺序</span><small>数字越小越靠前。</small></div>
            <Input aria-label="顺序" type="number" min={0} value={draft.position} onChange={(event) => setDraft({ ...draft, position: Number(event.target.value) })} />
          </label>
          <div className="rss-definition-field">
            <span>此栏顶部的分类筛选</span>
            <div className="rss-definition-filters">
              {topics.map((topic) => {
                const on = draft.filterIds?.includes(topic.id) || false
                return <Chip key={topic.id} aria-pressed={on} onClick={() => setDraft({ ...draft, filterIds: on ? draft.filterIds?.filter((id) => id !== topic.id) : [...(draft.filterIds || []), topic.id] })}>{topic.name}</Chip>
              })}
              {topics.length === 0 && <p>还没有自定义主题。新建主题后可在这里选择。</p>}
            </div>
          </div>
        </fieldset>
        <div className="rss-definition-actions">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? '正在保存' : '保存栏目'}</Button>
          {selected && <Button variant="ghost" disabled={busy} onClick={() => setDraft(edit(selected))}>重新载入</Button>}
          {selected?.kind === 'topic' && <Button variant="danger" disabled={busy} onClick={() => void save(true)}>删除分类</Button>}
          {message && <p role="status">{message}</p>}
        </div>
      </form>
    </div>
  </section>
}
