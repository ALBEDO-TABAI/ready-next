import { useEffect, useState } from 'react'
import { Button, Input, Select, Switch } from '../../components/ui'
import {
  DEFAULT_SEARCH_SETTINGS,
  SEARCH_ENGINES,
  SEARCH_ENGINE_KEY,
  SEARCH_SUGGESTIONS_KEY,
  resolveSearchEngine,
} from '../../../shared/search-engines'
import { SettingsCard, SettingsRow } from './settings-shared'

type SettingsAPI = Pick<Window['electronAPI']['settings'], 'getAll' | 'set'>
const CUSTOM = 'custom'
const BUILT_IN = Object.entries(SEARCH_ENGINES).map(([value, engine]) => ({ value, label: engine.name }))

const validTemplate = (value: string) => {
  try { resolveSearchEngine(value); return true } catch { /* silent-catch: an invalid template is the answer itself. */ return false }
}

/**
 * 设置 › 浏览器 (W7 §4.10): the engine the address bar searches with, and whether typing there asks that engine for
 * suggestions. Suggestions are off until turned on, and the switch says what turning it on sends.
 */
export function BrowserSearchSettingsPanel({ api = window.electronAPI?.settings }: { api?: SettingsAPI }) {
  const [engine, setEngine] = useState<string>(DEFAULT_SEARCH_SETTINGS.searchEngine)
  const [suggestions, setSuggestions] = useState(DEFAULT_SEARCH_SETTINGS.searchSuggestions)
  const [custom, setCustom] = useState('')
  const [choice, setChoice] = useState<string>(DEFAULT_SEARCH_SETTINGS.searchEngine)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api?.getAll().then(result => {
      if (cancelled || !result?.success) return
      const stored = result.data?.[SEARCH_ENGINE_KEY] ?? DEFAULT_SEARCH_SETTINGS.searchEngine
      setEngine(stored)
      setChoice(Object.hasOwn(SEARCH_ENGINES, stored) ? stored : CUSTOM)
      if (!Object.hasOwn(SEARCH_ENGINES, stored)) setCustom(stored)
      setSuggestions(result.data?.[SEARCH_SUGGESTIONS_KEY] === 'true')
      setLoaded(true)
    }).catch(reason => { if (!cancelled) setError(`读取失败：${reason instanceof Error ? reason.message : String(reason)}`) })
    return () => { cancelled = true }
  }, [api])

  const save = async (key: string, value: string) => {
    const result = await api?.set(key, value)
    if (!result?.success) throw new Error(result?.error || '保存失败')
  }
  const chooseEngine = async (value: string) => {
    setChoice(value)
    setError('')
    if (value === CUSTOM) return
    try { await save(SEARCH_ENGINE_KEY, value); setEngine(value) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const saveCustom = async () => {
    const value = custom.trim()
    if (!validTemplate(value)) { setError('要一个完整的 http 或 https 网址，并用 %s 代表搜索词。'); return }
    try { await save(SEARCH_ENGINE_KEY, value); setEngine(value); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const toggleSuggestions = async (next: boolean) => {
    setSuggestions(next)
    try { await save(SEARCH_SUGGESTIONS_KEY, next ? 'true' : 'false') } catch (reason) {
      setSuggestions(!next)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const engineName = Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine as keyof typeof SEARCH_ENGINES].name : null
  const suggestionsDescription = engineName
    ? `打开后，你在地址栏里输入的文字会随打随发给 ${engineName}，换回搜索建议；不带你的登录信息。关闭时，建议只来自本机的历史、收藏和已打开的标签，不发给任何人。`
    : '自定义的搜索地址没有建议服务，所以打开也不会发送任何内容；建议只来自本机的历史、收藏和已打开的标签。'

  return (
    <div className="flex flex-col gap-4" data-browser-search-settings="">
      <SettingsCard title="搜索">
        <SettingsRow label="搜索引擎" description="地址栏里输入的不是网址时，用它来搜索。">
          <Select
            aria-label="搜索引擎"
            value={choice}
            disabled={!loaded}
            onChange={event => { void chooseEngine(event.target.value) }}
            options={[...BUILT_IN, { value: CUSTOM, label: '自定义…' }]}
          />
        </SettingsRow>
        {choice === CUSTOM && (
          <SettingsRow label="自定义搜索地址" description="完整的网址，用 %s 代表搜索词，例如 https://example.com/search?q=%s" stack>
            <div className="flex w-full items-center gap-2">
              <Input
                aria-label="自定义搜索地址"
                className="min-w-0 flex-1"
                value={custom}
                placeholder="https://example.com/search?q=%s"
                spellCheck={false}
                aria-invalid={Boolean(error) || undefined}
                onChange={event => setCustom(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void saveCustom() }}
              />
              <Button size="sm" variant="secondary" disabled={custom.trim() === engine} onClick={() => void saveCustom()}>保存</Button>
            </div>
          </SettingsRow>
        )}
        <SettingsRow label="搜索建议" description={suggestionsDescription}>
          <Switch label="搜索建议" checked={suggestions} disabled={!loaded} onChange={next => { void toggleSuggestions(next) }} />
        </SettingsRow>
        {error && <p role="alert" className="px-4 pb-3" style={{ color: 'var(--rn-bad)', fontSize: 'var(--rn-fs-sm)' }}>{error}</p>}
      </SettingsCard>
    </div>
  )
}
