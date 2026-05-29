import { useCallback, useEffect, useState } from 'react'
import { Activity, CheckCircle2, Download, HardDrive, Loader2, RefreshCw, XCircle } from 'lucide-react'
import type { ModelPackId, ModelPackSelfTestReport, ModelPackStatus, ModelSource } from '../../../shared/model-pack-types'
import { MODEL_SOURCES } from '../../../shared/model-pack-types'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_FIELD_HINT_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
  SETTINGS_TITLE_STYLE,
  settingsNoticeStyle,
} from './settings-theme'

const SOURCE_LABELS: Record<ModelSource, string> = {
  auto: '自动',
  domestic: '国内源',
  overseas: '国外源',
}

const SOURCE_HINTS: Record<ModelSource, string> = {
  auto: '下载开始时自动探测国内 / 国外节点，选择更快的一个',
  domestic: '优先 ModelScope（国内直连，HF-only 模型走镜像）',
  overseas: '优先 HuggingFace 官方节点',
}

function packState(pack: ModelPackStatus): 'ready' | 'downloading' | 'error' | 'missing' {
  if (pack.download.running) return 'downloading'
  if (pack.available) return 'ready'
  if (pack.download.error) return 'error'
  return 'missing'
}

export default function ModelsRuntimeSettingsPanel() {
  const [packs, setPacks] = useState<ModelPackStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<ModelSource>('auto')
  const [busyId, setBusyId] = useState<ModelPackId | null>(null)
  const [selfTest, setSelfTest] = useState<ModelPackSelfTestReport | null>(null)
  const [selfTesting, setSelfTesting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.skills.listModelPacks()
      if (res.success && res.data) {
        setPacks(res.data)
        setError(null)
      } else {
        setError(res.error || '读取模型列表失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const unsubscribe = window.electronAPI.skills.onModelPackDownloadUpdate?.((update) => {
      setPacks((current) => current.map((pack) => (pack.id === update.id ? update.status : pack)))
    })
    return unsubscribe
  }, [])

  const applyStatus = useCallback((status: ModelPackStatus) => {
    setPacks((current) => current.map((pack) => (pack.id === status.id ? status : pack)))
  }, [])

  const startDownload = useCallback(async (id: ModelPackId) => {
    setBusyId(id)
    setError(null)
    try {
      const res = await window.electronAPI.skills.startModelPackDownload({ id, source })
      if (res.success && res.data) {
        applyStatus(res.data)
      } else {
        setError(res.error || '启动下载失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [applyStatus, source])

  const cancelDownload = useCallback(async (id: ModelPackId) => {
    setBusyId(id)
    try {
      const res = await window.electronAPI.skills.cancelModelPackDownload({ id })
      if (res.success && res.data) {
        applyStatus(res.data)
      } else if (res.error) {
        setError(res.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [applyStatus])

  const runSelfTest = useCallback(async () => {
    setSelfTesting(true)
    setError(null)
    try {
      const res = await window.electronAPI.skills.selfTestModelPacks()
      if (res.success && res.data) {
        setSelfTest(res.data)
      } else {
        setError(res.error || '下载自检失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSelfTesting(false)
    }
  }, [])

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="text-[12px]" style={settingsNoticeStyle('error')}>
          {error}
        </div>
      )}

      <section className="glass-surface-card rounded-2xl border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: 14 }}>
          <div>
            <div style={SETTINGS_TITLE_STYLE}>下载来源</div>
            <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 4 }}>{SOURCE_HINTS[source]}</div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center gap-1.5"
            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '8px 12px', opacity: loading ? 0.6 : 1 }}
            title="刷新状态"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
            刷新
          </button>
        </div>
        <div className="flex gap-2">
          {MODEL_SOURCES.map((value) => {
            const active = value === source
            return (
              <button
                key={value}
                type="button"
                onClick={() => setSource(value)}
                className="flex-1"
                style={{
                  ...SETTINGS_FLAT_BUTTON_STYLE,
                  minWidth: 0,
                  border: active
                    ? '1px solid color-mix(in srgb, var(--color-blue) 42%, transparent)'
                    : SETTINGS_FLAT_BUTTON_STYLE.border,
                  background: active
                    ? 'color-mix(in srgb, var(--color-blue) 16%, var(--surface-card-bg) 84%)'
                    : SETTINGS_FLAT_BUTTON_STYLE.background,
                  color: active ? 'var(--color-blue)' : 'var(--text-body)',
                }}
              >
                {SOURCE_LABELS[value]}
              </button>
            )
          })}
        </div>
      </section>

      <div className="flex flex-col gap-3">
        {packs.map((pack) => {
          const state = packState(pack)
          const running = state === 'downloading'
          const percent = typeof pack.download.progressPercent === 'number' ? pack.download.progressPercent : null
          const busy = busyId === pack.id
          return (
            <section
              key={pack.id}
              className="rounded-2xl border"
              style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '16px 18px' }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <span style={{ marginTop: 2 }}>
                    {state === 'ready' ? (
                      <CheckCircle2 size={18} color="var(--color-green)" />
                    ) : running ? (
                      <Loader2 size={18} className="animate-spin" color="var(--color-blue)" />
                    ) : state === 'error' ? (
                      <XCircle size={18} color="var(--color-red)" />
                    ) : (
                      <HardDrive size={18} color="var(--text-muted)" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>{pack.displayName}</div>
                    <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 2 }}>
                      {pack.sizeEstimate}
                      {state === 'ready' && ' · 已安装'}
                      {state === 'missing' && ' · 未下载'}
                      {running && `${percent !== null ? ` · ${percent}%` : ' · 下载中'}`}
                    </div>
                  </div>
                </div>
                <div className="flex-shrink-0">
                  {running ? (
                    <button
                      type="button"
                      onClick={() => void cancelDownload(pack.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5"
                      style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '8px 14px', color: 'var(--color-red)' }}
                    >
                      取消
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startDownload(pack.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5"
                      style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '8px 14px', opacity: busy ? 0.6 : 1 }}
                    >
                      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                      {state === 'ready' ? '重新下载' : '下载'}
                    </button>
                  )}
                </div>
              </div>

              {running && (
                <div
                  style={{
                    marginTop: 12,
                    height: 6,
                    borderRadius: 999,
                    overflow: 'hidden',
                    background: 'color-mix(in srgb, var(--surface-border) 60%, transparent)',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${percent ?? 8}%`,
                      borderRadius: 999,
                      background: 'var(--color-blue)',
                      transition: 'width 240ms ease',
                    }}
                  />
                </div>
              )}

              {pack.download.lastMessage && (
                <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 10, overflowWrap: 'anywhere' }}>
                  {pack.download.lastMessage}
                </div>
              )}
              {pack.download.error && (
                <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--color-red)', marginTop: 6, overflowWrap: 'anywhere' }}>
                  {pack.download.error}
                </div>
              )}
              <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 10, overflowWrap: 'anywhere' }}>
                存储位置：{pack.targetDir}
              </div>
            </section>
          )
        })}
        {!loading && packs.length === 0 && (
          <div style={{ ...SETTINGS_FIELD_HINT_STYLE, padding: '12px 4px' }}>暂无可下载的模型包。</div>
        )}
      </div>

      <section className="glass-surface-card rounded-2xl border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: selfTest ? 14 : 0 }}>
          <div>
            <div style={SETTINGS_TITLE_STYLE}>下载自检</div>
            <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 4 }}>
              校验每个模型包的国内 / 国外节点可达性与下载链路，并验证断点续传与原子安装路径，不会真正下载权重。
            </div>
          </div>
          <button
            type="button"
            onClick={() => void runSelfTest()}
            disabled={selfTesting}
            className="inline-flex items-center gap-1.5"
            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '8px 12px', opacity: selfTesting ? 0.6 : 1 }}
          >
            {selfTesting ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
            运行自检
          </button>
        </div>
        {selfTest && (
          <div className="flex flex-col gap-2">
            {selfTest.entries.map((entry) => (
              <div key={entry.id} className="rounded-xl border" style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '12px 14px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>{entry.displayName}</div>
                <div className="flex flex-col gap-1.5" style={{ marginTop: 8 }}>
                  {entry.probes.map((probe) => (
                    <div key={probe.source} className="flex items-center gap-2" style={{ fontSize: 11, color: 'var(--text-body)' }}>
                      {probe.reachable ? (
                        <CheckCircle2 size={13} color="var(--color-green)" />
                      ) : (
                        <XCircle size={13} color="var(--color-red)" />
                      )}
                      <span style={{ minWidth: 52 }}>{SOURCE_LABELS[probe.source]}</span>
                      <span style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                        {probe.endpoint}
                        {probe.reachable && probe.latencyMs !== null ? ` · ${probe.latencyMs}ms` : ' · 不可达'}
                        {probe.coordinatesOk ? '' : ' · 坐标解析失败'}
                      </span>
                    </div>
                  ))}
                </div>
                <div
                  className="flex items-center gap-2"
                  style={{ fontSize: 11, marginTop: 8, color: entry.integrityOk ? 'var(--color-green)' : 'var(--color-red)' }}
                >
                  {entry.integrityOk ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  完整性：{entry.integrityDetail}
                </div>
              </div>
            ))}
            <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 2 }}>
              自检完成于 {new Date(selfTest.finishedAt).toLocaleTimeString()}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
