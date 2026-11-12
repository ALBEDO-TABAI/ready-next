import { useEffect } from 'react'
import { useVault } from '../../stores/useVault'
import { useMode } from '../../stores/useMode'
import { Button } from '../ui'

export default function VaultSetupBanner() {
  const { view, load, createDefault, chooseFolder } = useVault()
  const documentVisible = useMode(state => state.workbenchMode === 'document' || state.splitMode === 'document')
  useEffect(() => { void load() }, [load])
  if (!documentVisible) return null
  if (view.phase === 'loaded' && view.data.status === 'ready') return null
  const busy = view.phase === 'idle' || view.phase === 'loading' || view.phase === 'saving'
  return (
    <div aria-label="资料库设置" className="shrink-0 border-b px-3 py-2 text-xs" style={{ borderColor: 'var(--rn-hair)', color: 'var(--rn-ink-2)' }}>
      {view.phase === 'idle' || view.phase === 'loading' ? <span role="status">正在读取资料库…</span> : (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <span>{view.data?.status === 'missing' ? '找不到资料库' : '设置资料库'} · </span>
            <Button variant="ghost" size="sm" disabled={busy} title={view.data?.defaultSuggestion} onClick={() => void createDefault()}>新建默认位置</Button>
            <span> / </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void chooseFolder()}>选择已有文件夹…</Button>
          </div>
          {view.phase === 'error' && <div role="alert" className="flex flex-wrap items-center gap-1">{view.message} <Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button></div>}
          {view.data?.status === 'missing' && <div className="break-all">{view.data.root}</div>}
        </>
      )}
    </div>
  )
}
