import { useEffect, useState } from 'react'
import type { SyncedSnapshot } from '../../../../shared/document-comments'
import NotePreview from '../../../components/document/NotePreview'
import { openReadyRef } from '../../workbench/open-ready-ref'

export function SyncedBlock({ path, page, blockId }: { path?: string | null; page: string; blockId: string }) {
  const [value, setValue] = useState<SyncedSnapshot | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let live = true, request = 0
    setValue(null); setError('')
    if (!path) { setError('请保存页面后读取同步块'); return }
    const read = () => {
      const token = ++request
      window.electronAPI.documentAnnotations.synced({ path, raw: `![[${page}#^${blockId}]]` }).then(result => {
        if (!live || token !== request) return
        if (!result.ok) throw new Error(result.message)
        setValue(result.value); setError('')
      }).catch(cause => { if (live && token === request) { setValue(null); setError(String(cause)) } })
    }
    read()
    const unsubscribe = window.electronAPI.documentPages.onChanged(read)
    window.addEventListener('focus', read)
    return () => { live = false; unsubscribe(); window.removeEventListener('focus', read) }
  }, [path, page, blockId])
  return <section aria-label="同步块">
    {error ? <p role="alert">{error}</p> : value ? <>
      <NotePreview content={value.content} notePath={value.path} forceManualPreview />
      <button type="button" onClick={() => { void openReadyRef({ kind: 'page', id: value.objectId, anchor: '^' + value.blockId }, 'document').catch(cause => setError(String(cause))) }}>回到原处编辑</button>
    </> : <p role="status">正在读取同步块…</p>}
  </section>
}
