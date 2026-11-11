import { useCallback, useEffect, useState } from 'react'
import type { RSSCalibration } from '../../../shared/rss-sieve'
import { Button } from '../ui/Button'
import { unwrapRSS } from '../../modules/rss/unwrap'

// 筛子校准 (W5 §2.4, V3): once a week the model proposes a new wording for 我的关注 from what was read and skipped.
// Nothing changes until the person accepts it, rewrites it, or dismisses it for the week. A proposal written against
// an older 我的关注 cannot be accepted: Main checks the version, and the card says so instead of offering it.
export function RSSCalibrationCard({ active }: { active: boolean }) {
  const [proposal, setProposal] = useState<RSSCalibration | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setProposal(await unwrapRSS(window.electronAPI.rss.sieveCalibration())) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  useEffect(() => {
    if (!active) return
    void load()
    return window.electronAPI.rss.onOrganizationChanged(() => { void load() })
  }, [active, load])
  if (!proposal || proposal.status !== 'pending' || !proposal.text) return null
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await work(); setDraft(null); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const api = window.electronAPI.rss
  const accept = (text?: string) => act(() => unwrapRSS(api.sieveAcceptCalibration({ week: proposal.week, expectedVersion: proposal.baseVersion, ...(text !== undefined ? { text } : {}) })))
  const dismiss = () => act(() => unwrapRSS(api.sieveDismissCalibration({ week: proposal.week })))
  return <aside className="rss-calibration" aria-label="筛子校准">
    <h2>筛子校准</h2>
    {proposal.explanation && <p className="rss-calibration__why">{proposal.explanation}</p>}
    {proposal.stale
      ? <p className="rss-calibration__note">你在这之后改过“我的关注”，这条建议不再适用。</p>
      : draft === null
        ? <blockquote className="rss-calibration__text">{proposal.text}</blockquote>
        : <textarea className="rss-calibration__draft" aria-label="改写我的关注" value={draft} rows={5} onChange={event => setDraft(event.target.value)} />}
    {error && <p role="alert" className="rss-calibration__note">{error}</p>}
    <div className="rss-calibration__actions">
      <span className="rss-calibration__meta">不经你确认，“我的关注”不会变。</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss()}>{proposal.stale ? '知道了' : '本周不改'}</Button>
      {!proposal.stale && (draft === null
        ? <>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft(proposal.text ?? '')}>改写</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void accept()}>采用</Button>
        </>
        : <>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDraft(null)}>取消</Button>
          <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => void accept(draft)}>保存</Button>
        </>)}
    </div>
  </aside>
}
