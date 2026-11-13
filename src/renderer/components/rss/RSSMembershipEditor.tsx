import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import RSSProcessingPanel from './RSSProcessingPanel'
import { Select } from '../ui/Field'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import type { RSSDefinition, RSSMembership } from '../../../shared/rss-organization'

export default function RSSMembershipEditor({ article, definitions, active }: { article: RSSArticleExcerpt['article']; definitions: RSSDefinition[]; active: boolean }) {
  const [memberships, setMemberships] = useState<RSSMembership[]>(article.classifications)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const identity = useRef('')
  identity.current = `${article.id}:${article.revision}:${active}`
  const generation = useRef(0)
  useEffect(() => {
    let live = true
    setMemberships(article.classifications); setError(''); setBusy(false)
    if (!active) return
    const key = identity.current
    const refresh = async () => {
      const ticket = ++generation.current
      const result = await window.electronAPI.rss.readArticle({ itemId: article.id, expectedRevision: article.revision, length: 1 })
      if (!live || key !== identity.current || ticket !== generation.current) return
      if (result.success && result.data) setMemberships(result.data.article.classifications)
      else setError('归类信息已变化，请重新读取文章。')
    }
    void refresh().catch(() => { if (live) setError('归类信息读取失败') })
    const stop = window.electronAPI.rss.onOrganizationChanged(() => { void refresh().catch(() => { if (live) setError('归类信息读取失败') }) })
    return () => { live = false; stop() }
  }, [article.id, article.revision, article.classifications, active])
  const set = async (definition: RSSDefinition, value: string) => {
    const key = identity.current, ticket = ++generation.current
    setBusy(true); setError('')
    try {
      const result = await window.electronAPI.rss.setMembership({ itemId: article.id, expectedArticleRevision: article.revision,
        definitionId: definition.id, expectedRuleRevision: definition.ruleRevision, decision: value === '' ? null : value === 'yes' })
      if (!result.success || !result.data) throw new Error(result.error || '归类保存失败')
      if (key === identity.current && ticket === generation.current) setMemberships(result.data)
    } catch (error) { if (key === identity.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (key === identity.current) setBusy(false) }
  }
  const relevant = definitions.filter((definition) => ['topic', 'curated'].includes(definition.kind))
  const includedCount = relevant.filter((definition) => memberships.find((entry) => entry.definitionId === definition.id)?.included).length
  return <details className="rss-membership-editor">
    <summary>
      <span>分类与精选</span>
      <span className="flex items-center gap-2"><small>{includedCount ? `已归入 ${includedCount} 项` : '尚未归入'}</small><ChevronRight size={14} strokeWidth={1.5} /></span>
    </summary>
    <div className="rss-membership-editor__body">
      {relevant.map((definition) => {
        const decision = memberships.find((entry) => entry.definitionId === definition.id)
        return <div className="rss-membership-row" key={definition.id} title={definition.description}>
          <strong>{definition.name}</strong>
          <Select aria-label={`${definition.name}归属`} disabled={busy} value={decision?.origin === 'manual' ? decision.included ? 'yes' : 'no' : ''} onChange={(event) => void set(definition, event.target.value)}
            options={[{ value: '', label: '使用自动结果' }, { value: 'yes', label: '属于' }, { value: 'no', label: '不属于' }]} />
          <small>{decision ? `${decision.included === null ? '证据不足' : decision.included ? '已归入' : '未归入'} · ${decision.reason}${decision.stale ? ' · 标准或内容已变化，需要更新' : ''}` : '尚未归类'}</small>
        </div>
      })}
      {error && <p className="rss-note rss-note--danger" role="alert">{error}</p>}
      <RSSProcessingPanel active={active} article={article} />
    </div>
  </details>
}
