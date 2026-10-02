import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertCircle, Check, ChevronDown, CircleDashed, Download, HardDrive, Loader2, RefreshCw, X, XCircle } from 'lucide-react'
import type { ModelPackId, ModelPackSelfTestReport, ModelPackStatus, ModelSource } from '../../../shared/model-pack-types'
import type { SkillSourceSelfTestReport } from '../../../shared/skill-source-types'
import type { RuntimeStatus, RuntimeProvisionTaskSnapshot } from '../../../shared/runtime-provision-types'
import { MODEL_SOURCES } from '../../../shared/model-pack-types'
import {
  SettingsCard,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSegmented,
  settingsButtonClass,
} from '../../pages/settings/settings-shared'

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
    <div className="flex items-center justify-between gap-3 border-t px-3.5 py-2 first:border-t-0" style={{ borderColor: 'var(--sx-divider)' }}>
      <div className="flex items-center gap-2.5">
        {ready
          ? <Check size={14} strokeWidth={2.4} style={{ color: 'var(--sx-title)' }} />
          : <CircleDashed size={14} strokeWidth={1.9} style={{ color: 'var(--sx-subtle)' }} />}
        <span className="text-[13px]" style={{ color: 'var(--sx-body)' }}>{label}</span>
      </div>
      <span className="text-[12px]" style={{ color: ready ? 'var(--sx-muted)' : 'var(--sx-subtle)' }}>
        {ready ? (detail || '已就绪') : (detail || '未配置')}
      </span>
    </div>
  )
}

// 自检探针一行：不可达属于真实故障，用危险色；可达只用墨色对勾。
function ProbeLine({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[12px]" style={{ color: ok ? 'var(--sx-body)' : 'var(--sx-danger-text)' }}>
      {ok
        ? <Check size={13} strokeWidth={2.4} className="mt-[3px] shrink-0" style={{ color: 'var(--sx-title)' }} />
        : <X size={13} strokeWidth={2.4} className="mt-[3px] shrink-0" />}
      <span className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  )
}

const RUNTIME_PHASE_LABELS: Record<string, string> = {
  probe: '探测下载源', download: '下载', verify: '校验', extract: '解压',
  connect: '安装', venv: '构建 Python 环境', deps: '安装核心依赖', done: '完成',
}

export function RuntimeEnvironmentCard() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [provisionTask, setProvisionTask] = useState<RuntimeProvisionTaskSnapshot | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [mirror, setMirror] = useState('')
  const [mirrorSaving, setMirrorSaving] = useState(false)
  const [mirrorNotice, setMirrorNotice] = useState<string | null>(null)
  const [mirrorNoticeKind, setMirrorNoticeKind] = useState<'error' | 'success'>('success')
  const latestProvisionRevision = useRef(-1)
  // Advanced: the custom-mirror input is hidden by default (normal users never
  //   need to paste a CDN URL); it auto-opens only when all sources are unreachable.
  const [showMirror, setShowMirror] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await window.electronAPI.skills.getSkillRuntimeStatus()
      if (res.success && res.data) setStatus(res.data)
    } catch {
      // silent-catch: status probe failure is non-fatal; the card just shows unknown.
    }
  }, [])

  const applyProvisionSnapshot = useCallback((snapshot: RuntimeProvisionTaskSnapshot) => {
    if (snapshot.revision < latestProvisionRevision.current) return
    latestProvisionRevision.current = snapshot.revision
    setProvisionTask(snapshot)
    if (snapshot.result) setStatus(snapshot.result)
    if (snapshot.state === 'failed' && snapshot.errorKind === 'all_sources_unreachable') {
      setShowMirror(true)
    }
    if (snapshot.state !== 'idle') setStartError(null)
  }, [])

  useEffect(() => {
    const off = window.electronAPI.skills.onSkillRuntimeProvisionUpdate?.(applyProvisionSnapshot)
    void refresh()
    void window.electronAPI.skills.getSkillRuntimeProvisionState().then((res) => {
      if (res.success && res.data) applyProvisionSnapshot(res.data)
    })
    void window.electronAPI.skills.getSkillRuntimeMirror().then((res) => {
      if (res.success && typeof res.data === 'string') setMirror(res.data)
    })
    return () => { off?.() }
  }, [applyProvisionSnapshot, refresh])

  const provision = useCallback(async (force: boolean) => {
    setStarting(true)
    setStartError(null)
    try {
      const res = await window.electronAPI.skills.provisionSkillRuntime({ force })
      if (res.success && res.data) {
        applyProvisionSnapshot(res.data)
      } else {
        setStartError(res.error || '无法启动配置')
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }, [applyProvisionSnapshot])

  const cancelProvision = useCallback(async () => {
    setStartError(null)
    try {
      const res = await window.electronAPI.skills.cancelSkillRuntimeProvision()
      if (res.success && res.data) {
        applyProvisionSnapshot(res.data)
      } else {
        setStartError(res.error || '无法停止配置')
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }, [applyProvisionSnapshot])

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
      // silent-catch: failure surfaces as the mirror error notice
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
  const taskRunning = provisionTask?.state === 'running' || provisionTask?.state === 'cancelling'
  const busy = starting || taskRunning
  const progress = provisionTask?.progress
  const phase = progress?.phase ?? null
  const progressAsset = progress?.assetId ?? null
  const pct = progress?.phase === 'download'
    && typeof progress.receivedBytes === 'number'
    && typeof progress.totalBytes === 'number'
    && progress.totalBytes > 0
    ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
    : null
  const errorKind = provisionTask?.state === 'failed' || provisionTask?.state === 'cancelled'
    ? provisionTask.errorKind ?? null
    : null
  const errorText = provisionTask?.state === 'failed'
    ? provisionTask.error || '配置失败'
    : provisionTask?.state === 'cancelled'
      ? provisionTask.error || '配置已取消，可以重新开始。'
      : startError
  const doneNotice = provisionTask?.state === 'succeeded' ? '运行时已配置完成。' : null

  return (
    <SettingsCard
      title="运行时环境"
      description={(
        <>
          一键下载并配置 Python + ffmpeg + 技能核心依赖（在线视频分析所需）。本地 ASR 降级链需另装 torch/模型（见下方模型下载）。
          <br />
          离开设置页不会中断配置，返回后会自动恢复当前进度。
        </>
      )}
      actions={(
        <>
          <button
            type="button"
            onClick={() => void provision(ready)}
            disabled={busy || unsupported}
            aria-busy={busy || undefined}
            className={settingsButtonClass(ready ? 'secondary' : 'primary')}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            {busy ? '配置中…' : ready ? '重新配置' : '一键下载并配置'}
          </button>
          {taskRunning && (
            <button
              type="button"
              onClick={() => void cancelProvision()}
              disabled={provisionTask?.state === 'cancelling'}
              className={settingsButtonClass('secondary')}
            >
              {provisionTask?.state === 'cancelling'
                ? <Loader2 className="animate-spin" />
                : <XCircle />}
              {provisionTask?.state === 'cancelling' ? '正在停止…' : '停止'}
            </button>
          )}
        </>
      )}
    >
      <div className="sx-card__body flex flex-col gap-3">
        {unsupported ? (
          <SettingsNotice tone="danger" title="当前平台暂不支持自动配置运行时。" />
        ) : (
          <div className="sx-inset">
            <StatusRow label="Python" ready={Boolean(status?.python.ready)} detail={status?.python.version} />
            <StatusRow label="ffmpeg" ready={Boolean(status?.ffmpeg.ready)} />
            <StatusRow label="ffprobe" ready={Boolean(status?.ffprobe.ready)} />
            <StatusRow label="核心依赖" ready={Boolean(status?.coreDeps.ready)} detail={status?.coreDeps.missing?.length ? `缺：${status.coreDeps.missing.join('、')}` : undefined} />
          </div>
        )}

        {busy && (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px]" style={{ color: 'var(--sx-muted)' }}>
              <span>
                正在{RUNTIME_PHASE_LABELS[phase || ''] || '配置'}{progressAsset ? ` ${progressAsset}` : ''}…
              </span>
              {pct !== null && <span className="sx-mono">{pct}%</span>}
            </div>
            <div className="sx-progress">
              <span style={{ width: pct !== null ? `${pct}%` : '40%', opacity: pct !== null ? 1 : 0.6 }} />
            </div>
          </div>
        )}

        {!busy && doneNotice && (
          <SettingsNotice tone={ready ? 'plain' : 'danger'} icon={ready ? Check : undefined} title={doneNotice} />
        )}

        {!unsupported && (
          <div>
            <button
              type="button"
              onClick={() => setShowMirror((v) => !v)}
              aria-expanded={showMirror}
              className={settingsButtonClass('ghost', { size: 'sm' })}
              style={{ marginLeft: -8 }}
            >
              <ChevronDown style={{ transform: showMirror ? 'rotate(180deg)' : undefined, transition: 'transform 160ms ease' }} />
              {showMirror ? '收起自定义镜像' : '自定义下载镜像（高级）'}
            </button>
          </div>
        )}

        {!unsupported && showMirror && (
          <div className="sx-inset sx-field" style={{ padding: '12px 14px' }}>
            <div className="sx-field__label">自定义下载镜像（可选）</div>
            <div className="sx-field__hint">
              Python 默认先走中科大镜像；ffmpeg/ffprobe 默认走上游。填写自定义镜像后会优先尝试该地址。
            </div>
            <div className="mt-1.5 flex gap-2">
              <input
                value={mirror}
                onChange={(e) => {
                  setMirror(e.target.value)
                  setMirrorNotice(null)
                  setMirrorNoticeKind('success')
                }}
                placeholder="https://your-cdn/ready-runtime"
                aria-label="自定义下载镜像"
                className="sx-input sx-input--mono flex-1"
              />
              <button
                type="button"
                onClick={() => void saveMirror()}
                disabled={busy || mirrorSaving}
                className={settingsButtonClass('secondary')}
              >
                {mirrorSaving ? '保存中…' : '保存'}
              </button>
            </div>
            <div className="sx-meta" style={{ overflowWrap: 'anywhere' }}>
              镜像路径：&lt;base&gt;/&lt;platform&gt;/&lt;filename&gt;
            </div>
            {mirrorNotice && (
              <div className={`text-[12px] ${mirrorNoticeKind === 'error' ? 'sx-text-danger' : ''}`} style={mirrorNoticeKind === 'error' ? undefined : { color: 'var(--sx-muted)' }}>
                {mirrorNoticeKind === 'success' && <Check size={12} strokeWidth={2.4} className="mr-1 inline-block align-[-1px]" style={{ color: 'var(--sx-title)' }} />}
                {mirrorNotice}
              </div>
            )}
          </div>
        )}

        {errorText && <SettingsNotice tone="danger" title={errorText} />}

        {errorKind === 'all_sources_unreachable' && (
          <div className="flex items-center justify-between gap-3">
            <div className="sx-row__desc" style={{ marginTop: 0 }}>所有源都连不上。请在上方填写自定义镜像，或确认网络后重试。</div>
            <button type="button" onClick={() => void saveMirrorAndRetry()} disabled={busy || mirrorSaving} className={settingsButtonClass('secondary', { size: 'sm' })}>
              保存并重试
            </button>
          </div>
        )}

        {errorKind === 'asset_integrity_failed' && (
          <div className="sx-row__desc" style={{ marginTop: 0 }}>
            资产校验失败（疑似钉死值过期或资产被污染）。换镜像通常无效，请反馈或稍后重试。
          </div>
        )}

        {errorKind === 'assets_not_pinned' && (
          <div className="sx-row__desc" style={{ marginTop: 0 }}>
            运行时资产尚未发布真实校验值，请等待包含校验值的版本。
          </div>
        )}
      </div>
    </SettingsCard>
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
    <div className="sx-stack">
      {error && <SettingsNotice tone="danger" title={error} />}

      <SettingsGroup label="运行时">
        <RuntimeEnvironmentCard />
      </SettingsGroup>

      <SettingsGroup label="语音模型">
        <SettingsCard>
          <SettingsRow label="下载来源" description={SOURCE_HINTS[source]}>
            <SettingsSegmented
              ariaLabel="下载来源"
              value={source}
              onChange={setSource}
              options={MODEL_SOURCES.map((value) => ({ value, label: SOURCE_LABELS[value] }))}
            />
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className={settingsButtonClass('ghost', { size: 'sm', icon: true })}
              title="刷新状态"
              aria-label="刷新状态"
            >
              <RefreshCw className={loading ? 'animate-spin' : undefined} />
            </button>
          </SettingsRow>

          {packs.map((pack) => {
            const state = packState(pack)
            const running = state === 'downloading'
            const percent = typeof pack.download.progressPercent === 'number' ? pack.download.progressPercent : null
            const busy = busyId === pack.id
            return (
              <div key={pack.id} className="sx-row" style={{ alignItems: 'flex-start', paddingTop: 14, paddingBottom: 14 }}>
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px]"
                    style={{ background: 'var(--sx-inset-bg)' }}
                    aria-hidden
                  >
                    {state === 'ready' ? (
                      <Check size={15} strokeWidth={2.4} style={{ color: 'var(--sx-title)' }} />
                    ) : running ? (
                      <Loader2 size={15} className="animate-spin" style={{ color: 'var(--sx-accent)' }} />
                    ) : state === 'error' ? (
                      <AlertCircle size={15} style={{ color: 'var(--sx-danger)' }} />
                    ) : (
                      <HardDrive size={15} style={{ color: 'var(--sx-muted)' }} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="sx-row__label">{pack.displayName}</div>
                    <div className="sx-row__desc">
                      {pack.sizeEstimate}
                      {state === 'ready' && ' · 已安装'}
                      {state === 'missing' && ' · 未下载'}
                      {running && `${percent !== null ? ` · ${percent}%` : ' · 下载中'}`}
                    </div>
                    {running && (
                      <div className="sx-progress mt-2.5" style={{ maxWidth: 420 }}>
                        <span style={{ width: `${percent ?? 8}%` }} />
                      </div>
                    )}
                    {pack.download.lastMessage && (
                      <div className="sx-meta mt-1.5" style={{ overflowWrap: 'anywhere' }}>
                        {pack.download.lastMessage}
                      </div>
                    )}
                    {pack.download.error && (
                      <div className="sx-text-danger mt-1 text-[11.5px] leading-[1.6]" style={{ overflowWrap: 'anywhere' }}>
                        {pack.download.error}
                      </div>
                    )}
                    <div className="sx-meta mt-1" style={{ overflowWrap: 'anywhere' }}>
                      存储位置：{pack.targetDir}
                    </div>
                  </div>
                </div>
                <div className="sx-row__control">
                  {running ? (
                    <button
                      type="button"
                      onClick={() => void cancelDownload(pack.id)}
                      disabled={busy}
                      className={settingsButtonClass('secondary', { size: 'sm' })}
                    >
                      取消
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startDownload(pack.id)}
                      disabled={busy}
                      className={settingsButtonClass(state === 'ready' ? 'ghost' : 'secondary', { size: 'sm' })}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <Download />}
                      {state === 'ready' ? '重新下载' : '下载'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {!loading && packs.length === 0 && (
            <div className="sx-row">
              <span className="sx-row__desc" style={{ marginTop: 0 }}>暂无可下载的模型包。</span>
            </div>
          )}
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup label="诊断">
        <SettingsCard
          title="下载自检"
          description="校验每个模型包的国内 / 国外节点可达性与下载链路，并验证断点续传与原子安装路径，不会真正下载权重。"
          actions={(
            <button
              type="button"
              onClick={() => void runSelfTest()}
              disabled={selfTesting}
              className={settingsButtonClass('secondary', { size: 'sm' })}
            >
              {selfTesting ? <Loader2 className="animate-spin" /> : <Activity />}
              运行自检
            </button>
          )}
        >
          {selfTest && (
            <div className="sx-card__body flex flex-col gap-2.5">
              {selfTest.entries.map((entry) => (
                <div key={entry.id} className="sx-inset flex flex-col gap-1.5" style={{ padding: '10px 14px' }}>
                  <div className="text-[12.5px] font-semibold" style={{ color: 'var(--sx-title)' }}>{entry.displayName}</div>
                  {entry.probes.map((probe) => (
                    <ProbeLine key={probe.source} ok={probe.reachable}>
                      <span className="inline-block" style={{ minWidth: 52, color: 'var(--sx-body)' }}>{SOURCE_LABELS[probe.source]}</span>
                      <span style={{ color: probe.reachable ? 'var(--sx-muted)' : undefined }}>
                        {probe.endpoint}
                        {probe.reachable && probe.latencyMs !== null ? ` · ${probe.latencyMs}ms` : ' · 不可达'}
                        {probe.coordinatesOk ? '' : ' · 坐标解析失败'}
                      </span>
                    </ProbeLine>
                  ))}
                  <ProbeLine ok={entry.integrityOk}>完整性：{entry.integrityDetail}</ProbeLine>
                </div>
              ))}
              <div className="sx-meta">
                自检完成于 {new Date(selfTest.finishedAt).toLocaleTimeString()}
              </div>
            </div>
          )}
        </SettingsCard>

        <SettingsCard
          title="技能来源自检"
          description="校验从链接安装技能的国内 / 国外下载节点可达性、GitHub 提交溯源解析与暂存目录读写，不会真正下载技能。"
          actions={(
            <button
              type="button"
              onClick={() => void runSkillSourceSelfTest()}
              disabled={skillSourceTesting}
              className={settingsButtonClass('secondary', { size: 'sm' })}
            >
              {skillSourceTesting ? <Loader2 className="animate-spin" /> : <Activity />}
              运行自检
            </button>
          )}
        >
          {skillSourceTest && (
            <div className="sx-card__body flex flex-col gap-2.5">
              <div className="sx-inset flex flex-col gap-1.5" style={{ padding: '10px 14px' }}>
                {skillSourceTest.probes.map((probe) => (
                  <ProbeLine key={probe.source} ok={probe.reachable}>
                    <span className="inline-block" style={{ minWidth: 52, color: 'var(--sx-body)' }}>{SOURCE_LABELS[probe.source]}</span>
                    <span style={{ color: probe.reachable ? 'var(--sx-muted)' : undefined }}>
                      {probe.endpoint}
                      {probe.reachable && probe.latencyMs !== null ? ` · ${probe.latencyMs}ms` : ' · 不可达'}
                    </span>
                  </ProbeLine>
                ))}
                <ProbeLine ok={skillSourceTest.refResolveOk}>提交溯源：{skillSourceTest.refResolveDetail}</ProbeLine>
                <ProbeLine ok={skillSourceTest.stagingOk}>暂存目录：{skillSourceTest.stagingDetail}</ProbeLine>
              </div>
              <div className="sx-meta">
                自检完成于 {new Date(skillSourceTest.finishedAt).toLocaleTimeString()}
              </div>
            </div>
          )}
        </SettingsCard>
      </SettingsGroup>
    </div>
  )
}
