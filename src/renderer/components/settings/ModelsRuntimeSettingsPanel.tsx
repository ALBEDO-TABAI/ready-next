import { useCallback, useEffect, useState } from 'react'
import { Activity, CheckCircle2, Download, HardDrive, Loader2, RefreshCw, XCircle } from 'lucide-react'
import type { ModelPackId, ModelPackSelfTestReport, ModelPackStatus, ModelSource } from '../../../shared/model-pack-types'
import type { SkillSourceSelfTestReport } from '../../../shared/skill-source-types'
import type { RuntimeStatus, RuntimeProvisionProgress } from '../../../shared/runtime-provision-types'
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

function StatusRow({ label, ready, detail }: { label: string; ready: boolean; detail?: string }) {
  return (
    <div className="flex items-center justify-between gap-3" style={{ padding: '6px 0' }}>
      <div className="flex items-center gap-2">
        {ready ? <CheckCircle2 size={14} style={{ color: 'var(--color-green)' }} /> : <XCircle size={14} style={{ color: 'var(--color-red)' }} />}
        <span className="text-[13px]">{label}</span>
      </div>
      <span style={{ ...SETTINGS_FIELD_HINT_STYLE }}>{ready ? (detail || '已就绪') : (detail || '未配置')}</span>
    </div>
  )
}

function RuntimeEnvironmentCard() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const [errorKind, setErrorKind] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [mirror, setMirror] = useState('')
  const [mirrorSaving, setMirrorSaving] = useState(false)
  const [mirrorNotice, setMirrorNotice] = useState<string | null>(null)
  const [mirrorNoticeKind, setMirrorNoticeKind] = useState<'error' | 'success'>('success')

  const refresh = useCallback(async () => {
    try {
      const res = await window.electronAPI.skills.getSkillRuntimeStatus()
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // status probe failure is non-fatal; the card just shows unknown.
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.electronAPI.skills.getSkillRuntimeMirror().then((res) => {
      if (res.success && typeof res.data === 'string') setMirror(res.data)
    })
    const off = window.electronAPI.skills.onSkillRuntimeProvisionUpdate?.((p: RuntimeProvisionProgress) => {
      setPhase(p.phase)
      if (p.phase === 'download' && p.totalBytes && p.receivedBytes) {
        setPct(Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)))
      } else {
        setPct(null)
      }
    })
    return () => { off?.() }
  }, [refresh])

  const provision = useCallback(async (force: boolean) => {
    setBusy(true)
    setErrorKind(null)
    setErrorText(null)
    setPhase('probe')
    try {
      const res = await window.electronAPI.skills.provisionSkillRuntime({ force })
      if (res.success && res.data && 'overallReady' in res.data) {
        setStatus(res.data as RuntimeStatus)
      } else {
        const kind = res.data && typeof res.data === 'object' && 'kind' in res.data ? String(res.data.kind) : null
        setErrorKind(kind)
        setErrorText(res.error || '配置失败')
        await refresh()
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setPhase(null)
      setPct(null)
    }
  }, [refresh])

  const saveMirror = useCallback(async () => {
    const trimmed = mirror.trim()
    setMirrorSaving(true)
    setMirrorNotice(null)
    try {
      const res = await window.electronAPI.skills.setSkillRuntimeMirror({ mirror: trimmed })
      if (!res.success) {
        setMirrorNoticeKind('error')
        setMirrorNotice(res.error || '保存镜像失败')
        return false
      }
      setMirror(trimmed)
      setMirrorNoticeKind('success')
      setMirrorNotice(trimmed ? '自定义镜像已保存' : '自定义镜像已清空')
      return true
    } catch (err) {
      setMirrorNoticeKind('error')
      setMirrorNotice(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setMirrorSaving(false)
    }
  }, [mirror])

  const saveMirrorAndRetry = useCallback(async () => {
    const saved = await saveMirror()
    if (!saved) return
    await provision(false)
  }, [provision, saveMirror])

  const ready = status?.overallReady === true
  const unsupported = status?.platformSupported === false

  return (
    <section className="glass-surface-card rounded-2xl border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
      <div className="flex items-center justify-between gap-3" style={{ marginBottom: 10 }}>
        <div>
          <div style={SETTINGS_TITLE_STYLE}>运行时环境</div>
          <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 4 }}>
            一键下载并配置 Python + ffmpeg + 技能核心依赖（在线视频分析所需）。本地 ASR 降级链需另装 torch/模型（见下方模型下载）。
          </div>
        </div>
        <button
          type="button"
          onClick={() => void (ready ? refresh() : provision(false))}
          disabled={busy || unsupported}
          className="inline-flex items-center gap-1.5"
          style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '8px 14px', opacity: busy || unsupported ? 0.6 : 1 }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : ready ? <RefreshCw size={13} /> : <Download size={13} />}
          {ready ? '重新检测' : busy ? (phase || '配置中…') : '一键下载并配置'}
        </button>
      </div>

      {unsupported ? (
        <div className="text-[12px]" style={settingsNoticeStyle('error')}>当前平台暂不支持自动配置运行时。</div>
      ) : (
        <div style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '6px 12px' }}>
          <StatusRow label="Python" ready={Boolean(status?.python.ready)} detail={status?.python.version} />
          <StatusRow label="ffmpeg" ready={Boolean(status?.ffmpeg.ready)} />
          <StatusRow label="ffprobe" ready={Boolean(status?.ffprobe.ready)} />
          <StatusRow label="核心依赖" ready={Boolean(status?.coreDeps.ready)} detail={status?.coreDeps.missing?.length ? `缺：${status.coreDeps.missing.join('、')}` : undefined} />
        </div>
      )}

      {busy && pct !== null && (
        <div style={{ marginTop: 10, height: 6, borderRadius: 999, overflow: 'hidden', background: 'color-mix(in srgb, var(--surface-border) 60%, transparent)' }}>
          <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: 'var(--color-blue)', transition: 'width 240ms ease' }} />
        </div>
      )}

      {!unsupported && (
        <div style={{ ...SETTINGS_SUBTLE_CARD_STYLE, marginTop: 10, padding: '12px 14px' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>运行时下载源</div>
              <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 3 }}>
                Python 默认先走中科大镜像；ffmpeg/ffprobe 默认走上游。填写自定义镜像后会优先尝试该地址。
              </div>
            </div>
          </div>
          <div className="flex gap-2" style={{ marginTop: 10 }}>
            <input
              value={mirror}
              onChange={(e) => {
                setMirror(e.target.value)
                setMirrorNotice(null)
                setMirrorNoticeKind('success')
              }}
              placeholder="https://your-cdn/ready-runtime"
              className="flex-1 text-[12px]"
              style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 12px', textAlign: 'left', overflowWrap: 'anywhere' }}
            />
            <button
              type="button"
              onClick={() => void saveMirror()}
              disabled={busy || mirrorSaving}
              style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 14px', opacity: busy || mirrorSaving ? 0.6 : 1 }}
            >
              {mirrorSaving ? '保存中…' : '保存'}
            </button>
          </div>
          <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 6, overflowWrap: 'anywhere' }}>
            镜像路径：&lt;base&gt;/&lt;platform&gt;/&lt;filename&gt;
          </div>
          {mirrorNotice && (
            <div className="text-[12px]" style={{ ...settingsNoticeStyle(mirrorNoticeKind), marginTop: 8 }}>
              {mirrorNotice}
            </div>
          )}
        </div>
      )}

      {errorText && (
        <div className="text-[12px]" style={{ ...settingsNoticeStyle('error'), marginTop: 10 }}>
          {errorText}
        </div>
      )}

      {errorKind === 'all_sources_unreachable' && (
        <div className="flex flex-col gap-2" style={{ marginTop: 10 }}>
          <div style={SETTINGS_FIELD_HINT_STYLE}>所有源都连不上。请在上方填写自定义镜像，或确认网络后重试。</div>
          <button type="button" onClick={() => void saveMirrorAndRetry()} disabled={busy || mirrorSaving} style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 14px', alignSelf: 'flex-start' }}>
            保存并重试
          </button>
        </div>
      )}

      {errorKind === 'asset_integrity_failed' && (
        <div className="text-[12px]" style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 8 }}>
          资产校验失败（疑似钉死值过期或资产被污染）。换镜像通常无效，请反馈或稍后重试。
        </div>
      )}

      {errorKind === 'assets_not_pinned' && (
        <div className="text-[12px]" style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 8 }}>
          运行时资产尚未发布真实校验值，请等待包含校验值的版本。
        </div>
      )}
    </section>
  )
}

export default function ModelsRuntimeSettingsPanel() {
  const [packs, setPacks] = useState<ModelPackStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<ModelSource>('auto')
  const [busyId, setBusyId] = useState<ModelPackId | null>(null)
  const [selfTest, setSelfTest] = useState<ModelPackSelfTestReport | null>(null)
  const [selfTesting, setSelfTesting] = useState(false)
  const [skillSourceTest, setSkillSourceTest] = useState<SkillSourceSelfTestReport | null>(null)
  const [skillSourceTesting, setSkillSourceTesting] = useState(false)

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

  const runSkillSourceSelfTest = useCallback(async () => {
    setSkillSourceTesting(true)
    setError(null)
    try {
      const res = await window.electronAPI.skills.selfTestSkillSources()
      if (res.success && res.data) {
        setSkillSourceTest(res.data)
      } else {
        setError(res.error || '技能来源自检失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSkillSourceTesting(false)
    }
  }, [])

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="text-[12px]" style={settingsNoticeStyle('error')}>
          {error}
        </div>
      )}

      <RuntimeEnvironmentCard />

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

      <section className="glass-surface-card rounded-2xl border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
        <div className="flex items-center justify-between gap-3" style={{ marginBottom: skillSourceTest ? 14 : 0 }}>
          <div>
            <div style={SETTINGS_TITLE_STYLE}>技能来源自检</div>
            <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 4 }}>
              校验从链接安装技能的国内 / 国外下载节点可达性、GitHub 提交溯源解析与暂存目录读写，不会真正下载技能。
            </div>
          </div>
          <button
            type="button"
            onClick={() => void runSkillSourceSelfTest()}
            disabled={skillSourceTesting}
            className="inline-flex items-center gap-1.5"
            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, minWidth: 0, padding: '8px 12px', opacity: skillSourceTesting ? 0.6 : 1 }}
          >
            {skillSourceTesting ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
            运行自检
          </button>
        </div>
        {skillSourceTest && (
          <div className="flex flex-col gap-2">
            <div className="rounded-xl border" style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '12px 14px' }}>
              <div className="flex flex-col gap-1.5">
                {skillSourceTest.probes.map((probe) => (
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
                    </span>
                  </div>
                ))}
              </div>
              <div
                className="flex items-center gap-2"
                style={{ fontSize: 11, marginTop: 8, color: skillSourceTest.refResolveOk ? 'var(--color-green)' : 'var(--color-red)' }}
              >
                {skillSourceTest.refResolveOk ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                提交溯源：{skillSourceTest.refResolveDetail}
              </div>
              <div
                className="flex items-center gap-2"
                style={{ fontSize: 11, marginTop: 6, color: skillSourceTest.stagingOk ? 'var(--color-green)' : 'var(--color-red)' }}
              >
                {skillSourceTest.stagingOk ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                暂存目录：{skillSourceTest.stagingDetail}
              </div>
            </div>
            <div style={{ ...SETTINGS_FIELD_HINT_STYLE, marginTop: 2 }}>
              自检完成于 {new Date(skillSourceTest.finishedAt).toLocaleTimeString()}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
