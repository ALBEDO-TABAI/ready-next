import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react'

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

export default function FileEmergenceSection({
  viewModel,
  isRefreshing,
  onRefresh,
  onOpenFile,
}: FileEmergenceSectionProps) {
  const defaultExpandedProjectIds = useMemo(
    () => getDefaultExpandedProjectIds(viewModel),
    [viewModel],
  )
  const [expandedBucket, setExpandedBucket] = useState<FileEmergenceBucket | null>(viewModel.defaultExpandedBucket)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(defaultExpandedProjectIds))

  useEffect(() => {
    setExpandedBucket(viewModel.defaultExpandedBucket)
    setExpandedProjects(new Set(defaultExpandedProjectIds))
  }, [defaultExpandedProjectIds, viewModel.defaultExpandedBucket])

  const toggleBucket = (bucket: FileEmergenceBucket) => {
    setExpandedBucket((current) => current === bucket ? null : bucket)
  }

  const toggleProject = (projectId: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  return (
    <section
      className="mx-9 mb-3 overflow-hidden px-2 py-2"
      style={{
        border: '1px solid color-mix(in srgb, var(--border-default) 38%, transparent)',
        borderRadius: 8,
        background: 'color-mix(in srgb, var(--surface-panel-bg) 10%, transparent)',
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--surface-card-bg) 34%, transparent)',
      }}
      aria-label="涌现"
    >
      <div
        className="flex min-h-[34px] items-center justify-between gap-2 py-1 pl-0 pr-1"
        style={{ marginInline: EMERGENCE_CONTENT_INSET_PX }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="relative flex h-[22px] w-[22px] shrink-0 items-center justify-start">
            <Folder className="h-[20px] w-[20px]" style={{ color: 'var(--color-blue)' }} strokeWidth={2} />
            <Sparkles className="absolute left-[2px] -bottom-[2px] h-[11px] w-[11px]" style={{ color: 'var(--color-blue)' }} />
          </span>
          <span className="text-[15px] font-semibold leading-none" style={{ color: 'var(--text-title)' }}>
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
          className="flex h-7 w-7 items-center justify-center rounded-[7px] transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            color: 'var(--text-muted)',
            background: isRefreshing ? 'color-mix(in srgb, var(--bg-hover) 70%, transparent)' : 'transparent',
            cursor: isRefreshing ? 'default' : 'pointer',
            opacity: isRefreshing ? 1 : 0.72,
          }}
        >
          {isRefreshing
            ? <Loader2 className="h-[15px] w-[15px] animate-spin" />
            : <RefreshCw className="h-[15px] w-[15px]" />}
        </button>
      </div>

      <div className="mt-1 space-y-1" style={{ marginInline: EMERGENCE_CONTENT_INSET_PX }}>
        {viewModel.buckets.map((bucket) => {
          const isBucketOpen = expandedBucket === bucket.bucket
          const bucketSummary = getBucketSummary(bucket, isBucketOpen)
          return (
            <div key={bucket.bucket}>
              <button
                type="button"
                onClick={() => toggleBucket(bucket.bucket)}
                className="grid min-h-[34px] w-full grid-cols-[22px_82px_minmax(0,1fr)_24px] items-center gap-1.5 rounded-[7px] px-1.5 py-1 text-left transition-colors hover:bg-[var(--bg-hover)]"
                aria-expanded={isBucketOpen}
                data-file-emergence-bucket={bucket.bucket}
                style={{
                  background: isBucketOpen
                    ? 'color-mix(in srgb, var(--color-blue-light) 52%, transparent)'
                    : 'transparent',
                }}
              >
                {isBucketOpen
                  ? <ChevronDown className="h-[15px] w-[15px] shrink-0" style={{ color: 'var(--color-blue)' }} strokeWidth={2.2} />
                  : <ChevronRight className="h-[15px] w-[15px] shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={2.1} />}
                <span
                  className="text-[14px] font-semibold leading-none"
                  style={{ color: isBucketOpen ? 'var(--color-blue)' : 'var(--text-title)' }}
                >
                  {bucket.label}
                </span>
                <span className="min-w-0 truncate text-[13px]" style={{ color: 'var(--text-light)' }}>
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
                    <div className="ml-[106px] rounded-[7px] px-1.5 py-1 text-[13px]" style={{ color: 'var(--text-light)' }}>
                      暂无项目
                    </div>
                  ) : bucket.projects.map((project) => {
                    const isProjectOpen = expandedProjects.has(project.id)
                    const statusMeta = project.status ? PROJECT_STATUS_META[project.status] : null
                    return (
                      <div key={project.id} className="mb-0.5">
                        <button
                          type="button"
                          onClick={() => toggleProject(project.id)}
                          className="grid min-h-[28px] w-full grid-cols-[22px_14px_minmax(0,1fr)_auto_20px] items-center gap-1.5 rounded-[7px] px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                          title={project.evidence.map((item) => item.label).slice(0, 3).join(' · ')}
                          aria-expanded={isProjectOpen}
                          data-file-emergence-project={project.id}
                        >
                          <span aria-hidden="true" />
                          <Folder className="h-[14px] w-[14px] shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={1.9} />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" style={{ color: 'var(--text-title)' }}>
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
                                onClick={() => onOpenFile(file.path, project)}
                                className="grid min-h-[24px] w-full grid-cols-[42px_12px_minmax(0,1fr)] items-center gap-1.5 rounded-[7px] px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                                title={file.path}
                              >
                                <span aria-hidden="true" />
                                <FileText className="h-[12px] w-[12px] shrink-0" style={{ color: file.isCurrent ? 'var(--color-blue)' : 'var(--text-muted)' }} strokeWidth={1.8} />
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

function getDefaultExpandedProjectIds(viewModel: FileEmergenceViewModel): string[] {
  const bucket = viewModel.buckets.find((item) => item.bucket === viewModel.defaultExpandedBucket)
  return bucket?.projects.filter((project) => project.files.length > 0).map((project) => project.id) ?? []
}

const PROJECT_STATUS_META: Record<NonNullable<FileEmergenceProject['status']>, { label: string; color: string }> = {
  upcoming: { label: '待准备', color: '#3B82F6' },
  active: { label: '进行中', color: '#20C997' },
  continuation: { label: '可能继续', color: '#8B5CF6' },
  recently_finished: { label: '待整理', color: '#F59F00' },
  dormant_important: { label: '可回看', color: '#868E96' },
}

function getBucketSummary(bucket: FileEmergenceBucketView, isOpen: boolean): string {
  if (bucket.projects.length === 0) return '暂无项目'
  if (isOpen) return `${bucket.projects.length} 个项目`
  return bucket.projects[0]?.title || `${bucket.projects.length} 个项目`
}
