import { useEffect, useRef, useState } from 'react'
import RSSProcessingPanel from './RSSProcessingPanel'
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
  return <details className="rss-membership-editor">
    <summary>分类与精选</summary>
    {definitions.filter((definition) => ['topic', 'curated'].includes(definition.kind)).map((definition) => {
      const decision = memberships.find((entry) => entry.definitionId === definition.id)
      return <label key={definition.id} title={definition.description}>{definition.name}
        <select aria-label={`${definition.name}归属`} disabled={busy} value={decision?.origin === 'manual' ? decision.included ? 'yes' : 'no' : ''} onChange={(event) => void set(definition, event.target.value)}>
          <option value="">使用自动结果</option><option value="yes">属于</option><option value="no">不属于</option>
        </select>
        <small>{decision ? `${decision.included === null ? '证据不足' : decision.included ? '已归入' : '未归入'} · ${decision.reason}${decision.stale ? ' · 标准或内容已变化，需要更新' : ''}` : '尚未归类'}</small>
      </label>
    })}
    {error && <p role="alert">{error}</p>}
    <RSSProcessingPanel active={active} article={article} />
  </details>
}
