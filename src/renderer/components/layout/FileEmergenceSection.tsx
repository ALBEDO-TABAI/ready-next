import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  LoaderCircle as Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  ArrowLeftRight as SwitchHorizontal,
  Check,
  X,
} from 'lucide-react'

import type {
  FileEmergenceBucket,
  FileEmergenceProject,
} from '../../../shared/file-emergence'
import type { FileEmergenceBucketView, FileEmergenceViewModel } from './fileEmergenceViewModel'
import { Button, IconButton, Input, Select } from '../ui'

interface FileEmergenceSectionProps {
  viewModel: FileEmergenceViewModel
  isRefreshing: boolean
  onRefresh: () => void
  onOpenFile: (path: string, project: FileEmergenceProject) => void
  workspaceRoots?: readonly string[]
}

const EMERGENCE_UI_STATE_STORAGE_KEY = 'ready:file-emergence:ui-state:v1'

// Rows read like the navigator's ListRow (W1 §5): hover is a quiet fill; the selected row is the current place
// (DL5), so it takes the signal colour's soft fill and its text and icon take the accent text colour. An
// unselected row sets no inline background, so the hover class can show.
const ROW_HOVER = 'hover:bg-[var(--rn-fill)]'
const rowStyle = (selected: boolean) => (selected ? { background: 'var(--rn-accent-soft)' } : undefined)
const rowInk = (selected: boolean, ink: string) => (selected ? 'var(--rn-accent-text)' : ink)
// Keys on a control inside a row stay with the control; the row's own Enter/Space must not fire as well.
const keepKeys = (event: { stopPropagation: () => void }) => event.stopPropagation()

const EMPTY_STATE_LABELS: Record<NonNullable<FileEmergenceViewModel['emptyState']>, string> = {
  no_trusted_candidates: '暂时没有足够可信的项目',
  sources_degraded: '部分记录暂时无法读取，请稍后刷新',
  insufficient_history: '使用记录还不够，继续工作后会逐渐出现',
  all_suppressed: '推荐项目都已隐藏或延后',
}

type SuppressedProject = { projectKey: string; displayName: string; reason: 'not_related' | 'snoozed' | 'hidden'; until: number | null }

interface FileEmergenceUiState {
  expandedBucket: FileEmergenceBucket | null
  expandedProjects: Set<string>
  selectedItemKey: string | null
}

interface PersistedFileEmergenceUiState {
  expandedBucket?: FileEmergenceBucket | null
  expandedProjects?: string[]
  selectedItemKey?: string | null
}

export default function FileEmergenceSection({
  viewModel,
  isRefreshing,
  onRefresh,
  onOpenFile,
  workspaceRoots = [],
}: FileEmergenceSectionProps) {
  const validState = useMemo(
    () => getValidEmergenceState(viewModel),
    [viewModel],
  )
  const [uiState, setUiState] = useState<FileEmergenceUiState>(() => readFileEmergenceUiState())
  const [editingProjectKey, setEditingProjectKey] = useState<string | null>(null)
  const projectNameInputRef = useRef<HTMLInputElement>(null)
  const [assigningPath, setAssigningPath] = useState<string | null>(null)
  const [creatingProjectForPath, setCreatingProjectForPath] = useState<string | null>(null)
  const newProjectNameInputRef = useRef<HTMLInputElement>(null)
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [suppressedProjects, setSuppressedProjects] = useState<SuppressedProject[]>([])
  const allProjects = useMemo(
    () => viewModel.buckets.flatMap((bucket) => bucket.projects).filter((project) => Boolean(project.projectKey)),
    [viewModel],
  )

  useEffect(() => {
    setUiState((current) => pruneFileEmergenceUiState(current, validState))
  }, [validState])

  useEffect(() => {
    writeFileEmergenceUiState(uiState)
  }, [uiState])

  useEffect(() => {
    if (viewModel.emptyState !== 'all_suppressed') {
      setSuppressedProjects([])
      return
    }
    let active = true
    void window.electronAPI?.fileEmergence?.listSuppressed?.({ workspaceRoots: [...workspaceRoots] }).then((result) => {
      if (active && result?.success) setSuppressedProjects(result.data || [])
    })
    return () => { active = false }
  }, [viewModel.emptyState, workspaceRoots])

  const toggleBucket = (bucket: FileEmergenceBucket) => {
    setUiState((current) => ({
      ...current,
      expandedBucket: current.expandedBucket === bucket ? null : bucket,
      selectedItemKey: getBucketSelectionKey(bucket),
    }))
  }

  const toggleProject = (projectId: string) => {
    setUiState((current) => {
      const next = new Set(current.expandedProjects)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return {
        ...current,
        expandedProjects: next,
        selectedItemKey: getProjectSelectionKey(projectId),
      }
    })
  }

  const openEmergenceFile = (path: string, project: FileEmergenceProject) => {
    setUiState((current) => ({
      ...current,
      selectedItemKey: getFileSelectionKey(path),
    }))
    onOpenFile(path, project)
  }

  const beginRenameProject = (project: FileEmergenceProject) => {
    if (!project.projectKey) {
      setIdentityError('项目身份尚未建立，请刷新后重试')
      return
    }
    setIdentityError(null)
    setEditingProjectKey(project.projectKey)
  }

  const submitProjectRename = async () => {
    if (!editingProjectKey) return
    const result = await window.electronAPI?.fileEmergence?.renameProject?.({
      projectKey: editingProjectKey,
      displayName: projectNameInputRef.current?.value || '',
      workspaceRoots: [...workspaceRoots],
    })
    if (!result?.success) {
      setIdentityError(result?.error || '项目重命名失败')
      return
    }
    setEditingProjectKey(null)
    setIdentityError(null)
    onRefresh()
  }

  const assignFileToProject = async (path: string, projectKey: string) => {
    if (projectKey === '__new__') {
      setCreatingProjectForPath(path)
      return
    }
    const result = await window.electronAPI?.fileEmergence?.assignFile?.({
      projectKey,
      path,
      workspaceRoots: [...workspaceRoots],
    })
    if (!result?.success) {
      setIdentityError(result?.error || '文件归属调整失败')
      return
    }
    setAssigningPath(null)
    setIdentityError(null)
    onRefresh()
  }

  const createProjectForFile = async (path: string) => {
    const result = await window.electronAPI?.fileEmergence?.createProjectForFile?.({
      displayName: newProjectNameInputRef.current?.value || '',
      path,
      workspaceRoots: [...workspaceRoots],
    })
    if (!result?.success) {
      setIdentityError(result?.error || '新建项目失败')
      return
    }
    setCreatingProjectForPath(null)
    setAssigningPath(null)
    setIdentityError(null)
    onRefresh()
  }

  const submitProjectFeedback = async (project: FileEmergenceProject, action: 'not_related' | 'snooze' | 'hide') => {
    if (!project.projectKey) return
    const result = await window.electronAPI?.fileEmergence?.feedbackProject?.({
      projectKey: project.projectKey,
      action,
      evidenceCutoff: project.updatedAt,
      snoozeUntil: action === 'snooze' ? Date.now() + 7 * 24 * 60 * 60 * 1000 : undefined,
      workspaceRoots: [...workspaceRoots],
    })
    if (!result?.success) {
      setIdentityError(result?.error || '项目反馈保存失败')
      return
    }
    setIdentityError(null)
    onRefresh()
  }

  const restoreProject = async (projectKey: string) => {
    const result = await window.electronAPI?.fileEmergence?.feedbackProject?.({ projectKey, action: 'restore', workspaceRoots: [...workspaceRoots] })
    if (!result?.success) {
      setIdentityError(result?.error || '恢复项目失败')
      return
    }
    setIdentityError(null)
    onRefresh()
  }

  return (
    // 横向不设 section 级边距：这里的 mx-9/px-2 写于 Tailwind 间距类被未分层
    // reset 压死的时期（2026-06-08），从未真正生效；07-10 级联层根修后复活，
    // 把整块推离左缘 ~52px。现按文件树行的 8px 内容缩进对齐（见下方行内 inset）。
    <section
      className="relative mb-6 overflow-hidden pb-3 pt-2"
      style={{
        background: 'transparent',
      }}
      aria-label="涌现"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-[10%] h-px w-[80%]"
        style={{
          background: 'var(--rn-hair-2)',
          transform: 'scaleY(0.55)',
          transformOrigin: 'center bottom',
        }}
      />
      <div
        className="grid min-h-[34px] grid-cols-[22px_82px_minmax(0,1fr)_24px] items-center px-2 py-1"
      >
        <div className="col-span-3 flex min-w-0 items-center gap-1.5">
          <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-start">
            <Folder className="h-[16px] w-[16px]" style={{ color: 'var(--rn-ink)' }} strokeWidth={1.75} />
            <Sparkles className="absolute left-[1px] -bottom-[1px] h-[9px] w-[9px]" style={{ color: 'var(--rn-ink)' }} strokeWidth={1.9} />
          </span>
          <span className="text-[13px] font-semibold leading-none" style={{ color: 'var(--rn-ink)' }}>
            涌现
          </span>
          <span
            className="inline-flex h-[22px] min-w-[18px] items-center justify-center px-1 text-[12px]"
            style={{
              color: 'var(--rn-ink-2)',
            }}
          >
            {viewModel.totalProjects}
          </span>
        </div>
        <IconButton
          onClick={onRefresh}
          disabled={isRefreshing}
          active={isRefreshing}
          aria-busy={isRefreshing || undefined}
          title="重新涌现"
          className="justify-self-center"
          icon={isRefreshing
            ? <Loader2 className="animate-spin" aria-hidden="true" />
            : <RefreshCw aria-hidden="true" />}
        />
      </div>

      {/* 分桶行不再叠 wrapper inset：行自身 px-2 提供 8px 内容缩进，
          与 FileTreeItem（padding 6px 8px）同缘，hover 药丸同样通到左缘。 */}
      <div className="mt-1 space-y-1">
        {identityError ? (
          <div className="mx-2 px-2 py-1 text-[11px]" data-file-emergence-identity-error style={{ color: 'var(--rn-bad)' }}>
            {identityError}
          </div>
        ) : null}
        {viewModel.totalProjects === 0 && viewModel.emptyState ? (
          <div
            className="mx-2 rounded-[8px] px-2 py-2 text-[12px]"
            data-file-emergence-empty-state={viewModel.emptyState}
            style={{ color: 'var(--rn-ink-3)' }}
          >
            {EMPTY_STATE_LABELS[viewModel.emptyState]}
            {viewModel.emptyState === 'all_suppressed' && suppressedProjects.length > 0 ? (
              <div className="mt-2 space-y-1" data-file-emergence-suppressed-list>
                {suppressedProjects.map((project) => (
                  <div key={project.projectKey} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{project.displayName}</span>
                    <Button variant="ghost" size="sm" className="shrink-0" onClick={() => { void restoreProject(project.projectKey) }} aria-label={`恢复项目 ${project.displayName}`}>恢复</Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {viewModel.buckets.map((bucket) => {
          const bucketSelectionKey = getBucketSelectionKey(bucket.bucket)
          const isBucketOpen = uiState.expandedBucket === bucket.bucket
          const isBucketSelected = uiState.selectedItemKey === bucketSelectionKey
          const bucketSummary = getBucketSummary(bucket, isBucketOpen)
          return (
            <div key={bucket.bucket}>
              <button
                type="button"
                onClick={() => toggleBucket(bucket.bucket)}
                className={`grid min-h-[30px] w-full grid-cols-[22px_82px_minmax(0,1fr)_24px] items-center gap-1.5 rounded-[8px] px-2 py-1 text-left transition-[background-color] ${ROW_HOVER}`}
                aria-expanded={isBucketOpen}
                data-file-emergence-bucket={bucket.bucket}
                data-selected={isBucketSelected ? 'true' : undefined}
                style={rowStyle(isBucketSelected)}
              >
                {isBucketOpen
                  ? <ChevronDown className="h-[14px] w-[14px] shrink-0" style={{ color: rowInk(isBucketSelected, 'var(--rn-ink)') }} strokeWidth={1.9} />
                  : <ChevronRight className="h-[14px] w-[14px] shrink-0" style={{ color: rowInk(isBucketSelected, 'var(--rn-ink-2)') }} strokeWidth={1.8} />}
                <span
                  className="text-[13px] font-medium leading-none"
                  style={{ color: rowInk(isBucketSelected, 'var(--rn-ink)') }}
                >
                  {bucket.label}
                </span>
                <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--rn-ink-3)' }}>
                  {bucketSummary}
                </span>
                <span
                  className="inline-flex h-[24px] min-w-[18px] justify-self-end items-center justify-center px-1 text-[12px]"
                  style={{
                    color: 'var(--rn-ink-2)',
                  }}
                >
                  {bucket.projects.length}
                </span>
              </button>
              {isBucketOpen && (
                <div className="mt-1 space-y-1">
                  {bucket.projects.length === 0 ? (
                    <div className="ml-[118px] rounded-[8px] px-1.5 py-1 text-[12px]" style={{ color: 'var(--rn-ink-3)' }}>
                      暂无项目
                    </div>
                  ) : bucket.projects.map((project) => {
                    const projectSelectionKey = getProjectSelectionKey(project.id)
                    const isProjectOpen = uiState.expandedProjects.has(project.id)
                    const isProjectSelected = uiState.selectedItemKey === projectSelectionKey
                    const statusMeta = project.status ? PROJECT_STATUS_META[project.status] : null
                    return (
                      <div key={project.id} className="mb-0.5">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleProject(project.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') toggleProject(project.id)
                          }}
                          className={`grid min-h-[28px] w-full grid-cols-[22px_14px_minmax(0,1fr)_auto_20px] items-center gap-1.5 rounded-[8px] px-2 py-0.5 text-left transition-[background-color] ${ROW_HOVER}`}
                          title={project.evidence.map((item) => item.label).slice(0, 3).join(' · ')}
                          aria-expanded={isProjectOpen}
                          data-file-emergence-project={project.id}
                          data-selected={isProjectSelected ? 'true' : undefined}
                          style={rowStyle(isProjectSelected)}
                        >
                          <span aria-hidden="true" />
                          <Folder className="h-[14px] w-[14px] shrink-0" style={{ color: rowInk(isProjectSelected, 'var(--rn-ink-2)') }} strokeWidth={1.9} />
                          {editingProjectKey && editingProjectKey === project.projectKey ? (
                            <span className="flex min-w-0 items-center gap-1" onClick={(event) => event.stopPropagation()} onKeyDown={keepKeys}>
                              <Input
                                defaultValue={project.title}
                                ref={projectNameInputRef}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') void submitProjectRename()
                                  if (event.key === 'Escape') setEditingProjectKey(null)
                                }}
                                aria-label="项目名称"
                                className="min-w-0 flex-1"
                                style={{ height: 24, padding: '0 6px', fontSize: 'var(--rn-fs-sm)' }}
                              />
                              <IconButton size="sm" title="确认项目名称" icon={<Check aria-hidden="true" />} onClick={() => { void submitProjectRename() }} />
                              <IconButton size="sm" title="取消项目重命名" icon={<X aria-hidden="true" />} onClick={() => setEditingProjectKey(null)} />
                            </span>
                          ) : (
                            <span className="flex min-w-0 items-center gap-1">
                              <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: rowInk(isProjectSelected, 'var(--rn-ink)') }}>
                                {project.title}
                              </span>
                              {project.projectKey ? (
                                <IconButton
                                  size="sm"
                                  title={`重命名项目 ${project.title}`}
                                  icon={<Pencil aria-hidden="true" />}
                                  onClick={(event) => { event.stopPropagation(); beginRenameProject(project) }}
                                  onKeyDown={keepKeys}
                                  className="shrink-0"
                                />
                              ) : null}
                            </span>
                          )}
                          {statusMeta ? (
                            <span className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: 'var(--rn-ink-2)' }}>
                              <span
                                className="h-[6px] w-[6px] rounded-full"
                                style={{ background: statusMeta.color }}
                              />
                              {statusMeta.label}
                            </span>
                          ) : <span aria-hidden="true" />}
                          <span
                            className="inline-flex h-[22px] min-w-[16px] shrink-0 items-center justify-center px-1 text-[11px]"
                            style={{
                              color: 'var(--rn-ink-2)',
                            }}
                          >
                            {project.files.length}
                          </span>
                        </div>
                        {isProjectOpen && project.files.length > 0 && (
                          <div className="mt-0.5 space-y-0.5">
                            {project.projectKey ? (
                              <div className="ml-[56px] flex flex-wrap gap-1 py-1" data-file-emergence-feedback={project.projectKey}>
                                <Button variant="ghost" size="sm" onClick={() => { void submitProjectFeedback(project, 'not_related') }}>不相关</Button>
                                <Button variant="ghost" size="sm" onClick={() => { void submitProjectFeedback(project, 'snooze') }}>七天后提醒</Button>
                                <Button variant="ghost" size="sm" onClick={() => { void submitProjectFeedback(project, 'hide') }}>不再出现</Button>
                              </div>
                            ) : null}
                            {project.files.map((file) => {
                              const isFileSelected = uiState.selectedItemKey === getFileSelectionKey(file.path)
                              return (
                              <div
                                key={file.path}
                                role="button"
                                tabIndex={0}
                                onClick={() => openEmergenceFile(file.path, project)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') openEmergenceFile(file.path, project)
                                }}
                                className={`grid min-h-[24px] w-full grid-cols-[42px_12px_minmax(0,1fr)_24px] items-center gap-1.5 rounded-[8px] px-2 py-0.5 text-left transition-[background-color] ${ROW_HOVER}`}
                                title={file.path}
                                data-file-emergence-file={file.path}
                                data-selected={isFileSelected ? 'true' : undefined}
                                style={rowStyle(isFileSelected)}
                              >
                                <span aria-hidden="true" />
                                {/* The file open right now carries the signal colour (DL5). */}
                                <FileText className="h-[12px] w-[12px] shrink-0" style={{ color: file.isCurrent ? 'var(--rn-accent)' : rowInk(isFileSelected, 'var(--rn-ink-2)') }} strokeWidth={1.65} />
                                <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: rowInk(isFileSelected, 'var(--rn-ink-2)') }}>
                                  {file.name}{file.isCurrent ? ' · 当前' : ''}
                                </span>
                                {file.fileKey && allProjects.length > 1 ? (
                                  <IconButton
                                    size="sm"
                                    title={`调整 ${file.name} 的项目归属`}
                                    icon={<SwitchHorizontal aria-hidden="true" />}
                                    onClick={(event) => { event.stopPropagation(); setAssigningPath(file.path) }}
                                    onKeyDown={keepKeys}
                                  />
                                ) : <span aria-hidden="true" />}
                              </div>
                              )
                            })}
                            {assigningPath && project.files.some((file) => file.path === assigningPath) ? (
                              <div className="ml-[56px] max-w-[calc(100%-64px)]">
                                <Select
                                  aria-label="选择目标项目"
                                  value={project.projectKey || ''}
                                  onChange={(event) => { void assignFileToProject(assigningPath, event.target.value) }}
                                  options={[
                                    ...allProjects.map((candidate) => ({ value: candidate.projectKey || '', label: candidate.title })),
                                    { value: '__new__', label: '新建项目…' },
                                  ]}
                                  style={{ height: 26, fontSize: 'var(--rn-fs-xs)' }}
                                />
                              </div>
                            ) : null}
                            {creatingProjectForPath && project.files.some((file) => file.path === creatingProjectForPath) ? (
                              <span className="ml-[56px] flex items-center gap-1">
                                <Input ref={newProjectNameInputRef} aria-label="新项目名称" className="min-w-0 flex-1" style={{ height: 24, padding: '0 6px', fontSize: 'var(--rn-fs-xs)' }} />
                                <IconButton size="sm" title="确认新建项目" icon={<Check aria-hidden="true" />} onClick={() => { void createProjectForFile(creatingProjectForPath) }} />
                                <IconButton size="sm" title="取消新建项目" icon={<X aria-hidden="true" />} onClick={() => setCreatingProjectForPath(null)} />
                              </span>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// Only a project in progress is "now" and takes the signal colour (DL5); the other states are ink,
// the ones that want attention a step darker than the dormant one.
const PROJECT_STATUS_META: Record<NonNullable<FileEmergenceProject['status']>, { label: string; color: string }> = {
  upcoming: { label: '待准备', color: 'var(--rn-ink-2)' },
  active: { label: '进行中', color: 'var(--rn-accent)' },
  continuation: { label: '可能继续', color: 'var(--rn-ink-2)' },
  recently_finished: { label: '待整理', color: 'var(--rn-ink-2)' },
  dormant_important: { label: '可回看', color: 'var(--rn-ink-3)' },
}

function getBucketSummary(bucket: FileEmergenceBucketView, isOpen: boolean): string {
  if (bucket.projects.length === 0) return '暂无项目'
  if (isOpen) return `${bucket.projects.length} 个项目`
  return bucket.projects[0]?.title || `${bucket.projects.length} 个项目`
}

function getBucketSelectionKey(bucket: FileEmergenceBucket): string {
  return `bucket:${bucket}`
}

function getProjectSelectionKey(projectId: string): string {
  return `project:${projectId}`
}

function getFileSelectionKey(path: string): string {
  return `file:${path}`
}

function getValidEmergenceState(viewModel: FileEmergenceViewModel): {
  buckets: Set<FileEmergenceBucket>
  projectIds: Set<string>
  selectionKeys: Set<string>
} {
  const buckets = new Set<FileEmergenceBucket>()
  const projectIds = new Set<string>()
  const selectionKeys = new Set<string>()
  for (const bucket of viewModel.buckets) {
    buckets.add(bucket.bucket)
    selectionKeys.add(getBucketSelectionKey(bucket.bucket))
    for (const project of bucket.projects) {
      projectIds.add(project.id)
      selectionKeys.add(getProjectSelectionKey(project.id))
      for (const file of project.files) {
        selectionKeys.add(getFileSelectionKey(file.path))
      }
    }
  }
  return { buckets, projectIds, selectionKeys }
}

function readFileEmergenceUiState(): FileEmergenceUiState {
  const fallback: FileEmergenceUiState = {
    expandedBucket: null,
    expandedProjects: new Set(),
    selectedItemKey: null,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(EMERGENCE_UI_STATE_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as PersistedFileEmergenceUiState
    return {
      expandedBucket: parsed.expandedBucket ?? null,
      expandedProjects: new Set(Array.isArray(parsed.expandedProjects) ? parsed.expandedProjects : []),
      selectedItemKey: parsed.selectedItemKey ?? null,
    }
  } catch {
    return fallback
  }
}

function writeFileEmergenceUiState(state: FileEmergenceUiState) {
  if (typeof window === 'undefined') return
  try {
    const persisted: PersistedFileEmergenceUiState = {
      expandedBucket: state.expandedBucket,
      expandedProjects: Array.from(state.expandedProjects),
      selectedItemKey: state.selectedItemKey,
    }
    window.localStorage.setItem(EMERGENCE_UI_STATE_STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // silent-catch: best-effort UI preference; storage failures should not break file navigation.
  }
}

function pruneFileEmergenceUiState(
  state: FileEmergenceUiState,
  validState: ReturnType<typeof getValidEmergenceState>,
): FileEmergenceUiState {
  const expandedBucket = state.expandedBucket && validState.buckets.has(state.expandedBucket)
    ? state.expandedBucket
    : null
  const expandedProjects = new Set(
    Array.from(state.expandedProjects).filter((projectId) => validState.projectIds.has(projectId)),
  )
  const selectedItemKey = state.selectedItemKey && validState.selectionKeys.has(state.selectedItemKey)
    ? state.selectedItemKey
    : null

  if (
    expandedBucket === state.expandedBucket
    && selectedItemKey === state.selectedItemKey
    && areSetsEqual(expandedProjects, state.expandedProjects)
  ) {
    return state
  }

  return {
    expandedBucket,
    expandedProjects,
    selectedItemKey,
  }
}

function areSetsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  if (left.size !== right.size) return false
  for (const item of left) {
    if (!right.has(item)) return false
  }
  return true
}
