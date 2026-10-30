import { useEffect, useState } from 'react'
import { Database } from './Database'
import { databaseAPI, type DatabaseAPI } from './access'

export function InlineDatabase({ target, viewName, api = databaseAPI, ancestors }: {
  target: string; viewName: string; api?: DatabaseAPI; ancestors?: { databaseId: string; viewId: string }[]
}) {
  const [result, setResult] = useState<{ id: string } | { error: string } | null>(null)
  useEffect(() => {
    let live = true; setResult(null)
    api.pages().then(pages => {
      const name = target.replace(/\.md$/i, '')
      const matches = pages.filter(page => page.reference.slice(2, -2) === name || !name.includes('/') && (page.title === name || page.reference.slice(2, -2).split('/').at(-1) === name))
      if (matches.length !== 1) throw new Error(matches.length ? `数据库名称有歧义：${target}` : `数据库不存在：${target}`)
      if (live) setResult({ id: matches[0].id })
    }).catch(error => { if (live) setResult({ error: String(error) }) })
    return () => { live = false }
  }, [target, api])
  if (!result) return <span className="ready-database" role="status">正在定位数据库…</span>
  if ('error' in result) return <span className="ready-database" role="alert">{result.error}</span>
  return <Database key={`${result.id}:${viewName}`} databaseId={result.id} viewName={viewName} inline api={api} ancestors={ancestors} />
}
