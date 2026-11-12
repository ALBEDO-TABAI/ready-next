import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Select, Switch } from '../../components/ui'
import {
  DEFAULT_SEARCH_SETTINGS,
  SEARCH_ENGINES,
  SEARCH_ENGINE_KEY,
  SEARCH_SUGGESTIONS_KEY,
  resolveSearchEngine,
} from '../../../shared/search-engines'
import { SettingsCard, SettingsRow } from './settings-shared'

type SettingsAPI = Pick<Window['electronAPI']['settings'], 'getAll' | 'get' | 'set'>
// The WebMCP experiment (W7 T12): Main reads the saved value at start, so a change waits for the next start; its
// read-only status key says whether it does.
const WEBMCP_KEY = 'browser.webmcpExperiment'
const WEBMCP_STATUS_KEY = 'browser.webmcpExperimentStatus'
type WebMCPStatus = { enabled: boolean; active: boolean; restartRequired: boolean }
const parseStatus = (raw: unknown): WebMCPStatus | null => {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    return value && typeof value === 'object' && typeof value.restartRequired === 'boolean' ? value as WebMCPStatus : null
  } catch { /* silent-catch: an unreadable status shows no restart note; the switch still shows the saved value. */ return null }
}
const CUSTOM = 'custom'
const BUILT_IN = Object.entries(SEARCH_ENGINES).map(([value, engine]) => ({ value, label: engine.name }))

const validTemplate = (value: string) => {
  try { resolveSearchEngine(value); return true } catch { /* silent-catch: an invalid template is the answer itself. */ return false }
}

/**
 * 设置 › 浏览器 (W7 §4.10): the engine the address bar searches with, and whether typing there asks that engine for
 * suggestions. Suggestions are off until turned on, and the switch says what turning it on sends. Below, the
 * page-provided tools experiment (W7 §4.11), off by default, with a note when it needs a restart.
 */
export function BrowserSearchSettingsPanel({ api = window.electronAPI?.settings }: { api?: SettingsAPI }) {
  const [engine, setEngine] = useState<string>(DEFAULT_SEARCH_SETTINGS.searchEngine)
  const [suggestions, setSuggestions] = useState(DEFAULT_SEARCH_SETTINGS.searchSuggestions)
  const [custom, setCustom] = useState('')
  const [choice, setChoice] = useState<string>(DEFAULT_SEARCH_SETTINGS.searchEngine)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [webmcp, setWebmcp] = useState(false)
  const [webmcpStatus, setWebmcpStatus] = useState<WebMCPStatus | null>(null)
  const readWebmcpStatus = useCallback(async () => {
    const result = await api?.get(WEBMCP_STATUS_KEY)
    setWebmcpStatus(result?.success ? parseStatus(result.data) : null)
  }, [api])

  useEffect(() => {
    let cancelled = false
    void api?.getAll().then(result => {
      if (cancelled || !result?.success) return
      const stored = result.data?.[SEARCH_ENGINE_KEY] ?? DEFAULT_SEARCH_SETTINGS.searchEngine
      setEngine(stored)
      setChoice(Object.hasOwn(SEARCH_ENGINES, stored) ? stored : CUSTOM)
      if (!Object.hasOwn(SEARCH_ENGINES, stored)) setCustom(stored)
      setSuggestions(result.data?.[SEARCH_SUGGESTIONS_KEY] === 'true')
      setWebmcp(result.data?.[WEBMCP_KEY] === 'true')
      setLoaded(true)
    }).catch(reason => { if (!cancelled) setError(`读取失败：${reason instanceof Error ? reason.message : String(reason)}`) })
    void readWebmcpStatus().catch(reason => console.warn('[settings] webmcp status unavailable:', reason instanceof Error ? reason.message : String(reason)))
    return () => { cancelled = true }
  }, [api, readWebmcpStatus])

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

  const toggleWebmcp = async (next: boolean) => {
    setWebmcp(next)
    try { await save(WEBMCP_KEY, next ? 'true' : 'false'); await readWebmcpStatus() } catch (reason) {
      setWebmcp(!next)
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
      <SettingsCard title="实验">
        <SettingsRow
          label="网页自带工具（实验）"
          description={<>
            网页可以提供自己的工具，助手能列出并调用；工具返回的内容只当作网页资料，会改动网页的调用先问你。
            {webmcpStatus?.restartRequired && <span data-webmcp-restart="" style={{ display: 'block', marginTop: 4, color: 'var(--rn-accent-text)' }}>重启 Ready 后生效。</span>}
          </>}
        >
          <Switch label="网页自带工具（实验）" checked={webmcp} disabled={!loaded} onChange={next => { void toggleWebmcp(next) }} />
        </SettingsRow>
      </SettingsCard>
    </div>
  )
}
