import { useEffect, useMemo, useState } from 'react'
import {
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconFileText as FileText,
  IconFolder as Folder,
  IconLoader2 as Loader2,
  IconRefresh as RefreshCw,
  IconSparkles as Sparkles,
} from '@tabler/icons-react'

import type {
  FileEmergenceBucket,
  FileEmergenceProject,
} from '../../../shared/file-emergence'
import type { FileEmergenceBucketView, FileEmergenceViewModel } from './fileEmergenceViewModel'

interface FileEmergenceSectionProps {
  viewModel: FileEmergenceViewModel
  isRefreshing: boolean
  onRefresh: () => void
  onOpenFile: (path: string, project: FileEmergenceProject) => void
}

const EMERGENCE_CONTENT_INSET_PX = 8
const EMERGENCE_UI_STATE_STORAGE_KEY = 'ready:file-emergence:ui-state:v1'

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
}: FileEmergenceSectionProps) {
  const validState = useMemo(
    () => getValidEmergenceState(viewModel),
    [viewModel],
  )
  const [uiState, setUiState] = useState<FileEmergenceUiState>(() => readFileEmergenceUiState())

  useEffect(() => {
    setUiState((current) => pruneFileEmergenceUiState(current, validState))
  }, [validState])

  useEffect(() => {
    writeFileEmergenceUiState(uiState)
  }, [uiState])

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

  return (
    <section
      className="relative mx-9 mb-6 overflow-hidden px-2 pb-3 pt-2"
      style={{
        background: 'transparent',
      }}
      aria-label="涌现"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-[10%] h-px w-[80%]"
        style={{
          background: 'color-mix(in srgb, var(--text-muted) 22%, transparent)',
          transform: 'scaleY(0.55)',
          transformOrigin: 'center bottom',
        }}
      />
      <div
        className="flex min-h-[34px] items-center justify-between gap-2 py-1 pl-0 pr-1"
        style={{ marginInline: EMERGENCE_CONTENT_INSET_PX }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-start">
            <Folder className="h-[16px] w-[16px]" style={{ color: 'var(--text-title)' }} strokeWidth={1.75} />
            <Sparkles className="absolute left-[1px] -bottom-[1px] h-[9px] w-[9px]" style={{ color: 'var(--text-title)' }} strokeWidth={1.9} />
          </span>
          <span className="text-[13px] font-semibold leading-none" style={{ color: 'var(--text-title)' }}>
            涌现
          </span>
          <span
            className="inline-flex h-[22px] min-w-[18px] items-center justify-center px-1 text-[12px]"
            style={{
              color: 'var(--text-muted)',
            }}
          >
            {viewModel.totalProjects}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label="重新涌现"
          title="重新涌现"
          className="flex h-7 w-7 items-center justify-center rounded-[8px] transition-[background-color,box-shadow] hover:bg-[var(--files-panel-state-hover-bg)] hover:shadow-[var(--files-panel-state-hover-shadow)]"
          style={{
            color: 'var(--text-muted)',
            background: isRefreshing ? 'var(--files-panel-state-active-bg)' : 'transparent',
            boxShadow: isRefreshing ? 'var(--files-panel-state-active-shadow)' : 'none',
            cursor: isRefreshing ? 'default' : 'pointer',
            opacity: isRefreshing ? 1 : 0.72,
          }}
        >
          {isRefreshing
            ? <Loader2 className="h-[14px] w-[14px] animate-spin" />
            : <RefreshCw className="h-[14px] w-[14px]" />}
        </button>
      </div>

      <div className="mt-1 space-y-1" style={{ marginInline: EMERGENCE_CONTENT_INSET_PX }}>
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
                className="grid min-h-[30px] w-full grid-cols-[22px_82px_minmax(0,1fr)_24px] items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-left transition-[background-color,box-shadow] hover:bg-[var(--files-panel-state-hover-bg)] hover:shadow-[var(--files-panel-state-hover-shadow)]"
                aria-expanded={isBucketOpen}
                data-file-emergence-bucket={bucket.bucket}
                data-selected={isBucketSelected ? 'true' : undefined}
                style={{
                  background: isBucketSelected
                    ? 'var(--files-panel-state-active-bg)'
                    : 'transparent',
                  boxShadow: isBucketSelected
                    ? 'var(--files-panel-state-active-shadow)'
                    : 'none',
                }}
              >
                {isBucketOpen
                  ? <ChevronDown className="h-[14px] w-[14px] shrink-0" style={{ color: 'var(--text-title)' }} strokeWidth={1.9} />
                  : <ChevronRight className="h-[14px] w-[14px] shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={1.8} />}
                <span
                  className="text-[13px] font-medium leading-none"
                  style={{ color: 'var(--text-title)' }}
                >
                  {bucket.label}
                </span>
                <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--text-light)' }}>
                  {bucketSummary}
                </span>
                <span
                  className="inline-flex h-[24px] min-w-[18px] justify-self-end items-center justify-center px-1 text-[12px]"
                  style={{
                    color: 'var(--text-muted)',
                  }}
                >
                  {bucket.projects.length}
                </span>
              </button>
              {isBucketOpen && (
                <div className="mt-1 space-y-1">
                  {bucket.projects.length === 0 ? (
                    <div className="ml-[106px] rounded-[8px] px-1.5 py-1 text-[12px]" style={{ color: 'var(--text-light)' }}>
                      暂无项目
                    </div>
                  ) : bucket.projects.map((project) => {
                    const projectSelectionKey = getProjectSelectionKey(project.id)
                    const isProjectOpen = uiState.expandedProjects.has(project.id)
                    const isProjectSelected = uiState.selectedItemKey === projectSelectionKey
                    const statusMeta = project.status ? PROJECT_STATUS_META[project.status] : null
                    return (
                      <div key={project.id} className="mb-0.5">
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          className="grid min-h-[28px] w-full grid-cols-[22px_14px_minmax(0,1fr)_auto_20px] items-center gap-1.5 rounded-[8px] px-1.5 py-0.5 text-left transition-[background-color,box-shadow] hover:bg-[var(--files-panel-state-hover-bg)] hover:shadow-[var(--files-panel-state-hover-shadow)]"
                          title={project.evidence.map((item) => item.label).slice(0, 3).join(' · ')}
                          aria-expanded={isProjectOpen}
                          data-file-emergence-project={project.id}
                          data-selected={isProjectSelected ? 'true' : undefined}
                          style={{
                            background: isProjectSelected ? 'var(--files-panel-state-active-bg)' : 'transparent',
                            boxShadow: isProjectSelected ? 'var(--files-panel-state-active-shadow)' : 'none',
                          }}
                        >
                          <span aria-hidden="true" />
                          <Folder className="h-[14px] w-[14px] shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={1.9} />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>
                            {project.title}
                          </span>
                          {statusMeta ? (
                            <span className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
                              color: 'var(--text-muted)',
                            }}
                          >
                            {project.files.length}
                          </span>
                        </button>
                        {isProjectOpen && project.files.length > 0 && (
                          <div className="mt-0.5 space-y-0.5">
                            {project.files.map((file) => (
                              <button
                                key={file.path}
                                type="button"
                                onClick={() => openEmergenceFile(file.path, project)}
                                className="grid min-h-[24px] w-full grid-cols-[42px_12px_minmax(0,1fr)] items-center gap-1.5 rounded-[8px] px-1.5 py-0.5 text-left transition-[background-color,box-shadow] hover:bg-[var(--files-panel-state-hover-bg)] hover:shadow-[var(--files-panel-state-hover-shadow)]"
                                title={file.path}
                                data-file-emergence-file={file.path}
                                data-selected={uiState.selectedItemKey === getFileSelectionKey(file.path) ? 'true' : undefined}
                                style={{
                                  background: uiState.selectedItemKey === getFileSelectionKey(file.path) ? 'var(--files-panel-state-active-bg)' : 'transparent',
                                  boxShadow: uiState.selectedItemKey === getFileSelectionKey(file.path) ? 'var(--files-panel-state-active-shadow)' : 'none',
                                }}
                              >
                                <span aria-hidden="true" />
                                <FileText className="h-[12px] w-[12px] shrink-0" style={{ color: file.isCurrent ? 'var(--color-ready-orange)' : 'var(--text-muted)' }} strokeWidth={1.65} />
                                <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>
                                  {file.name}{file.isCurrent ? ' · 当前' : ''}
                                </span>
                              </button>
                            ))}
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

const PROJECT_STATUS_META: Record<NonNullable<FileEmergenceProject['status']>, { label: string; color: string }> = {
  upcoming: { label: '待准备', color: 'var(--color-ready-orange)' },
  active: { label: '进行中', color: 'var(--color-ready-orange)' },
  continuation: { label: '可能继续', color: 'var(--color-ready-orange)' },
  recently_finished: { label: '待整理', color: 'var(--color-ready-orange)' },
  dormant_important: { label: '可回看', color: '#868E96' },
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
    // best-effort UI preference; storage failures should not break file navigation.
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
