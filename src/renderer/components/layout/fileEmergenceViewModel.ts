import {
  FILE_EMERGENCE_BUCKETS,
  type FileEmergenceBucket,
  type FileEmergenceEvidence,
  type FileEmergenceFileKind,
  type FileEmergenceReadingProgress,
  type FileEmergenceProject,
  type FileEmergenceSnapshot,
} from '../../../shared/file-emergence'
import type { CurrentDocumentContext } from '../../modules/file-emergence/readingIntentContext'
import type { FileFilterMap, FileViewMode } from './FileTree'

export interface FileEmergenceBucketView {
  bucket: FileEmergenceBucket
  label: string
  projects: FileEmergenceProject[]
}

export interface FileEmergenceViewModel {
  buckets: FileEmergenceBucketView[]
  totalProjects: number
  defaultExpandedBucket: FileEmergenceBucket
}

const BUCKET_LABELS: Record<FileEmergenceBucket, string> = {
  future: '未来',
  today: '今天',
  past: '过去',
  distant: '遥远',
}

export function buildFileEmergenceViewModel(input: {
  snapshot: FileEmergenceSnapshot | null
  query: string
  viewMode: FileViewMode
  workspaceRoots: readonly string[]
  filters: FileFilterMap
  currentDocumentContext?: CurrentDocumentContext | null
  readingProgress?: readonly FileEmergenceReadingProgress[]
  now?: number
}): FileEmergenceViewModel | null {
  if (input.viewMode !== 'tree') return null
  if (input.query.trim()) return null
  if (input.workspaceRoots.length === 0) return null
  if (!input.snapshot || !input.snapshot.enabled) return null

  const displaySnapshot = applyFileEmergencePostProcessing({
    snapshot: input.snapshot,
    workspaceRoots: input.workspaceRoots,
    currentDocumentContext: input.currentDocumentContext ?? null,
    readingProgress: input.readingProgress ?? [],
    now: input.now ?? Date.now(),
  })

  const buckets = FILE_EMERGENCE_BUCKETS.map((bucket) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    projects: displaySnapshot.buckets[bucket]
      .slice(0, 10)
      .map((project) => ({
        ...project,
        files: project.files.filter((file) => shouldShowFileKind(file.kind, input.filters)),
      })),
  }))

  const totalProjects = buckets.reduce((sum, bucket) => sum + bucket.projects.length, 0)
  if (totalProjects === 0) return null

  const defaultExpandedBucket =
    buckets.find((bucket) => bucket.bucket === 'today' && bucket.projects.length > 0)?.bucket ||
    buckets.find((bucket) => bucket.projects.length > 0)?.bucket ||
    'today'

  return {
    buckets,
    totalProjects,
    defaultExpandedBucket,
  }
}

export function applyFileEmergencePostProcessing(input: {
  snapshot: FileEmergenceSnapshot
  workspaceRoots: readonly string[]
  currentDocumentContext: CurrentDocumentContext | null
  readingProgress: readonly FileEmergenceReadingProgress[]
  now: number
}): FileEmergenceSnapshot {
  if (!input.snapshot.enabled) return input.snapshot
  const buckets = cloneBuckets(input.snapshot)
  const tabs = input.currentDocumentContext?.tabs || []
  const validTabs = tabs.filter((tab) => isInsideWorkspace(tab.path, input.workspaceRoots))
  const groupedPathKeys = new Set<string>()
  for (const group of currentDocumentGroups(validTabs)) {
    for (const tab of group.tabs) groupedPathKeys.add(normalizePathKey(tab.path))
    ensureDocumentGroupProject({
      buckets,
      anchorPath: group.anchorPath,
      title: group.title,
      tabs: group.tabs,
      score: group.tabs.some((tab) => tab.isActive) ? 1.38 : 1.12,
      reason: group.tabs.some((tab) => tab.isActive) ? '当前打开的系列文档' : '当前打开的相关文档',
      now: input.now,
    })
  }

  for (const tab of validTabs.filter((item) => !item.isActive && !groupedPathKeys.has(normalizePathKey(item.path)))) {
    ensureDocumentProject({
      buckets,
      workspaceRoots: input.workspaceRoots,
      path: tab.path,
      title: tab.title,
      bucket: 'today',
      score: tab.isDirty ? 1.18 : 1.08,
      reason: tab.isDirty ? '当前打开且有未保存内容' : '当前打开的文档',
      status: 'active',
      isCurrent: tab.isSplit,
      now: input.now,
    })
  }
  const activeTab = validTabs.find((tab) => tab.isActive)
  if (activeTab && !groupedPathKeys.has(normalizePathKey(activeTab.path))) {
    ensureDocumentProject({
      buckets,
      workspaceRoots: input.workspaceRoots,
      path: activeTab.path,
      title: activeTab.title,
      bucket: 'today',
      score: activeTab.isDirty ? 1.45 : 1.35,
      reason: activeTab.isDirty ? '当前正在编辑' : '当前正在打开',
      status: 'active',
      isCurrent: true,
      now: input.now,
    })
  }

  const currentPaths = new Set(validTabs.map((tab) => normalizePathKey(tab.path)))
  const futureContinuationIds = new Set(
    buckets.future.filter((project) => project.status === 'continuation').map((project) => project.id),
  )
  for (const progress of input.readingProgress
    .filter((record) => record.exists !== false)
    .filter((record) => isInsideWorkspace(record.path, input.workspaceRoots))
    .sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (currentPaths.has(normalizePathKey(progress.path))) {
      annotateExistingDocument({
        buckets,
        path: progress.path,
        progress,
      })
      continue
    }
    const decision = bucketForProgress(progress, input.now)
    if (!decision) continue
    if (decision.bucket === 'future' && futureContinuationIds.size >= 3) continue
    const project = ensureDocumentProject({
      buckets,
      workspaceRoots: input.workspaceRoots,
      path: progress.path,
      title: progress.title || basenameWithoutExtension(progress.path),
      bucket: decision.bucket,
      score: decision.score,
      reason: decision.reason,
      status: decision.status,
      isCurrent: false,
      now: input.now,
      progress,
    })
    if (decision.bucket === 'future' && project.status === 'continuation') {
      futureContinuationIds.add(project.id)
    }
  }

  for (const bucket of FILE_EMERGENCE_BUCKETS) {
    buckets[bucket] = buckets[bucket]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
  }

  return {
    ...input.snapshot,
    buckets,
  }
}

function shouldShowFileKind(kind: FileEmergenceFileKind, filters: FileFilterMap): boolean {
  return filters[kind] !== false
}

function currentDocumentGroups(tabs: CurrentDocumentContext['tabs']): Array<{
  anchorPath: string
  title: string
  tabs: CurrentDocumentContext['tabs']
}> {
  const byDirectory = new Map<string, CurrentDocumentContext['tabs']>()
  for (const tab of tabs) {
    const dir = parentPath(tab.path)
    const list = byDirectory.get(dir) || []
    list.push(tab)
    byDirectory.set(dir, list)
  }
  return Array.from(byDirectory.entries())
    .map(([anchorPath, groupTabs]) => ({
      anchorPath,
      title: parentTitle(anchorPath),
      tabs: groupTabs,
    }))
    .filter((group) => group.tabs.length >= 2 && !isGenericGroupTitle(group.title))
    .sort((a, b) => Number(b.tabs.some((tab) => tab.isActive)) - Number(a.tabs.some((tab) => tab.isActive)))
}

function ensureDocumentProject(input: {
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>
  workspaceRoots: readonly string[]
  path: string
  title: string
  bucket: FileEmergenceBucket
  score: number
  reason: string
  status: NonNullable<FileEmergenceProject['status']>
  isCurrent: boolean
  now: number
  progress?: FileEmergenceReadingProgress
}): FileEmergenceProject {
  const covered = findCoveringProject(input.buckets, input.path)
  if (covered) {
    removeProject(input.buckets, covered.project.id)
    const next: FileEmergenceProject = {
      ...covered.project,
      bucket: input.bucket,
      score: Math.max(covered.project.score, input.score),
      status: input.status,
      files: ensureFileFirst({
        files: covered.project.files,
        path: input.path,
        name: basename(input.path),
        reason: input.reason,
        score: input.score,
        isCurrent: input.isCurrent,
        progress: input.progress,
      }),
      evidence: [
        makeEvidence(input),
        ...covered.project.evidence.filter((item) => item.ref !== input.path || item.source !== 'current_document'),
      ].slice(0, 8),
      updatedAt: Math.max(covered.project.updatedAt, input.progress?.updatedAt ?? input.now),
    }
    input.buckets[input.bucket].unshift(next)
    return next
  }

  const project: FileEmergenceProject = {
    id: `doc:${normalizePathKey(input.path)}`,
    bucket: input.bucket,
    title: cleanTitle(input.title || basenameWithoutExtension(input.path)),
    rawLabels: [cleanTitle(input.title || basenameWithoutExtension(input.path))],
    anchorType: 'document',
    anchorPath: input.path,
    titleSource: 'rule_refined',
    score: input.score,
    confidence: input.score >= 1 ? 'high' : 'medium',
    status: input.status,
    files: [makeFileRef({
      path: input.path,
      name: basename(input.path),
      reason: input.reason,
      score: input.score,
      isCurrent: input.isCurrent,
      progress: input.progress,
    })],
    evidence: [makeEvidence(input)],
    updatedAt: input.progress?.updatedAt ?? input.now,
  }
  removeProject(input.buckets, project.id)
  input.buckets[input.bucket].unshift(project)
  return project
}

function ensureDocumentGroupProject(input: {
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>
  anchorPath: string
  title: string
  tabs: CurrentDocumentContext['tabs']
  score: number
  reason: string
  now: number
}): FileEmergenceProject {
  const primary = input.tabs.find((tab) => tab.isActive) || input.tabs.find((tab) => tab.isSplit) || input.tabs[0]
  const covered = primary ? findCoveringProject(input.buckets, primary.path) : null
  const files = input.tabs
    .slice()
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(b.isSplit) - Number(a.isSplit))
    .map((tab) => makeFileRef({
      path: tab.path,
      name: basename(tab.path),
      reason: tab.isActive ? '当前正在打开' : '当前打开的文档',
      score: tab.isActive ? input.score : Math.max(0.85, input.score - 0.2),
      isCurrent: tab.isActive || tab.isSplit,
    }))
    .slice(0, 3)
  const evidence = {
    source: 'current_document' as const,
    label: input.reason,
    score: input.score,
    timestamp: input.now,
    ref: input.anchorPath,
  }

  if (covered) {
    removeProject(input.buckets, covered.project.id)
    const next: FileEmergenceProject = {
      ...covered.project,
      bucket: 'today',
      score: Math.max(covered.project.score, input.score),
      status: 'active',
      files: mergeFileRefs(files, covered.project.files),
      evidence: [evidence, ...covered.project.evidence].slice(0, 8),
      updatedAt: Math.max(covered.project.updatedAt, input.now),
    }
    input.buckets.today.unshift(next)
    return next
  }

  const project: FileEmergenceProject = {
    id: `current-dir:${normalizePathKey(input.anchorPath)}`,
    bucket: 'today',
    title: cleanTitle(input.title),
    rawLabels: [cleanTitle(input.title)],
    anchorType: 'directory',
    anchorPath: input.anchorPath,
    titleSource: 'rule_refined',
    score: input.score,
    confidence: 'high',
    status: 'active',
    files,
    evidence: [evidence],
    updatedAt: input.now,
  }
  removeProject(input.buckets, project.id)
  input.buckets.today.unshift(project)
  return project
}

function annotateExistingDocument(input: {
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>
  path: string
  progress: FileEmergenceReadingProgress
}): void {
  const covered = findCoveringProject(input.buckets, input.path)
  if (!covered) return
  covered.project.files = ensureFileFirst({
    files: covered.project.files,
    path: input.path,
    name: basename(input.path),
    reason: progressReason(input.progress),
    score: Math.max(covered.project.score, progressScore(input.progress)),
    isCurrent: true,
    progress: input.progress,
  })
  const evidence: FileEmergenceEvidence = {
    source: 'reading_progress',
    label: progressReason(input.progress),
    score: progressScore(input.progress),
    timestamp: input.progress.updatedAt,
    ref: input.path,
  }
  covered.project.evidence = [evidence, ...covered.project.evidence].slice(0, 8)
  covered.project.updatedAt = Math.max(covered.project.updatedAt, input.progress.updatedAt)
}

function bucketForProgress(
  progress: FileEmergenceReadingProgress,
  now: number,
): { bucket: FileEmergenceBucket; score: number; status: NonNullable<FileEmergenceProject['status']>; reason: string } | null {
  const days = daysSince(progress.updatedAt, now)
  const ratio = clamp01(progress.progressRatio)
  if (days <= 1) {
    return {
      bucket: 'today',
      score: 1.12 + ratio * 0.12,
      status: 'active',
      reason: days === 0 ? progressReason(progress) : `昨天还在读到 ${Math.round(ratio * 100)}%`,
    }
  }
  if (days >= 2 && days <= 4 && ratio >= 0.35) {
    return {
      bucket: 'future',
      score: 0.92 + ratio * 0.18,
      status: 'continuation',
      reason: `最近读了很多，已停 ${days} 天`,
    }
  }
  if (days >= 30 && ratio >= 0.65) {
    return {
      bucket: 'distant',
      score: 0.72 + ratio * 0.12,
      status: 'dormant_important',
      reason: `很久没读，但进度已有 ${Math.round(ratio * 100)}%`,
    }
  }
  return null
}

function findCoveringProject(
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>,
  path: string,
): { bucket: FileEmergenceBucket; project: FileEmergenceProject } | null {
  const pathKey = normalizePathKey(path)
  let fileMatch: { bucket: FileEmergenceBucket; project: FileEmergenceProject } | null = null
  let directoryMatch: { bucket: FileEmergenceBucket; project: FileEmergenceProject } | null = null
  for (const bucket of FILE_EMERGENCE_BUCKETS) {
    for (const project of buckets[bucket]) {
      if (project.files.some((file) => normalizePathKey(file.path) === pathKey)) {
        fileMatch = { bucket, project }
      }
      const anchor = project.anchorPath ? normalizePathKey(project.anchorPath) : ''
      if (!anchor || anchor === pathKey) continue
      if (pathKey.startsWith(`${anchor}/`)) {
        if (!directoryMatch || anchor.length > normalizePathKey(directoryMatch.project.anchorPath || '').length) {
          directoryMatch = { bucket, project }
        }
      }
    }
  }
  return fileMatch || directoryMatch
}

function removeProject(
  buckets: Record<FileEmergenceBucket, FileEmergenceProject[]>,
  projectId: string,
): void {
  for (const bucket of FILE_EMERGENCE_BUCKETS) {
    buckets[bucket] = buckets[bucket].filter((project) => project.id !== projectId)
  }
}

function ensureFileFirst(input: {
  files: readonly FileEmergenceProject['files'][number][]
  path: string
  name: string
  reason: string
  score: number
  isCurrent: boolean
  progress?: FileEmergenceReadingProgress
}): FileEmergenceProject['files'] {
  const pathKey = normalizePathKey(input.path)
  const current = makeFileRef(input)
  return [
    current,
    ...input.files
      .filter((file) => normalizePathKey(file.path) !== pathKey)
      .map((file) => ({ ...file, isCurrent: file.isCurrent && normalizePathKey(file.path) === pathKey })),
  ].slice(0, 3)
}

function mergeFileRefs(
  preferred: FileEmergenceProject['files'],
  existing: FileEmergenceProject['files'],
): FileEmergenceProject['files'] {
  const seen = new Set(preferred.map((file) => normalizePathKey(file.path)))
  return [
    ...preferred,
    ...existing.filter((file) => !seen.has(normalizePathKey(file.path))),
  ].slice(0, 3)
}

function makeFileRef(input: {
  path: string
  name: string
  reason: string
  score: number
  isCurrent: boolean
  progress?: FileEmergenceReadingProgress
}): FileEmergenceProject['files'][number] {
  return {
    path: input.path,
    name: input.name,
    kind: fileKindFromPath(input.path),
    score: input.score,
    reason: input.progress ? progressReason(input.progress) : input.reason,
    modifiedAt: input.progress?.updatedAt ?? null,
    isCurrent: input.isCurrent,
  }
}

function makeEvidence(input: {
  path: string
  reason: string
  score: number
  now: number
  progress?: FileEmergenceReadingProgress
}): FileEmergenceEvidence {
  if (input.progress) {
    return {
      source: 'reading_progress' as const,
      label: input.reason,
      score: input.score,
      timestamp: input.progress.updatedAt,
      ref: input.path,
    }
  }
  return {
    source: 'current_document' as const,
    label: input.reason,
    score: input.score,
    timestamp: input.now,
    ref: input.path,
  }
}

function cloneBuckets(snapshot: FileEmergenceSnapshot): Record<FileEmergenceBucket, FileEmergenceProject[]> {
  return {
    future: snapshot.buckets.future.map(cloneProject),
    today: snapshot.buckets.today.map(cloneProject),
    past: snapshot.buckets.past.map(cloneProject),
    distant: snapshot.buckets.distant.map(cloneProject),
  }
}

function cloneProject(project: FileEmergenceProject): FileEmergenceProject {
  return {
    ...project,
    rawLabels: [...project.rawLabels],
    files: project.files.map((file) => ({ ...file })),
    evidence: project.evidence.map((evidence) => ({ ...evidence })),
  }
}

function fileKindFromPath(path: string): FileEmergenceFileKind {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (['md', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'cbz'].includes(ext)) return 'document'
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'scss', 'less', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'yaml', 'yml', 'toml', 'xml', 'sql', 'sh', 'bash', 'zsh', 'vue', 'svelte', 'astro'].includes(ext)) return 'code'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'tiff', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'].includes(ext)) return 'audio'
  if (['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) return 'spreadsheet'
  return 'other'
}

function progressReason(progress: FileEmergenceReadingProgress): string {
  return progress.detail || `阅读进度 ${Math.round(clamp01(progress.progressRatio) * 100)}%`
}

function progressScore(progress: FileEmergenceReadingProgress): number {
  return 0.72 + clamp01(progress.progressRatio) * 0.25
}

function parentPath(path: string): string {
  const key = normalizePathKey(path)
  const index = key.lastIndexOf('/')
  if (index <= 0) return key
  return key.slice(0, index)
}

function parentTitle(path: string): string {
  return basename(path)
}

function isGenericGroupTitle(title: string): boolean {
  const normalized = title.trim().toLocaleLowerCase().replace(/\s+/g, '')
  if (!normalized) return true
  return /^(docs?|documents?|lib|src|tmp|temp|test|tests|资料|素材|文档|文件|工作内容|新建文件夹)([-_][\p{L}\p{N}]+)?$/iu.test(normalized)
}

function isInsideWorkspace(path: string, workspaceRoots: readonly string[]): boolean {
  const key = normalizePathKey(path)
  return workspaceRoots.some((root) => {
    const rootKey = normalizePathKey(root)
    return key === rootKey || key.startsWith(`${rootKey}/`)
  })
}

function daysSince(timestamp: number, now: number): number {
  const dayMs = 24 * 60 * 60 * 1000
  return Math.max(0, Math.floor((startOfLocalDay(now) - startOfLocalDay(timestamp)) / dayMs))
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function basename(path: string): string {
  return normalizePathKey(path).split('/').pop() || path
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name
  const ext = name.slice(dot + 1)
  if (ext.length > 8) return name
  return name.slice(0, dot) || name
}

function cleanTitle(title: string): string {
  const trimmed = title.trim()
  const withoutExt = trimmed.includes('/') ? basenameWithoutExtension(trimmed) : stripExtension(trimmed)
  return withoutExt || trimmed || '未命名文档'
}

function stripExtension(title: string): string {
  const dot = title.lastIndexOf('.')
  if (dot <= 0) return title
  const ext = title.slice(dot + 1)
  if (ext.length > 8 || /\s/.test(ext)) return title
  return title.slice(0, dot) || title
}

function normalizePathKey(path: string): string {
  return path.normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '')
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
