import { createHash } from 'crypto'
import { basename, dirname, extname, normalize, sep } from 'path'

import type {
  FileEmergenceEvidence,
  FileEmergenceEvidenceSource,
  FileEmergenceProject,
} from '../../../shared/file-emergence'

const GENERIC_LABELS = new Set([
  '会议',
  '资料',
  '方案',
  '项目',
  '文件',
  '文档',
  '素材',
  '案例',
  '门店',
  '计划',
  '复盘',
  '总结',
  '新建文件夹',
  'folder',
  'document',
  'untitled',
])

const VERSION_SUFFIX_RE = /(?:\s|[-_])(?:v\d+|final|copy|backup|bak|备份|副本|最终版|终稿)$/i

export interface NormalizedProjectLabel {
  raw: string
  normalized: string
  tokens: string[]
  isGeneric: boolean
}

export interface ProjectTitleInput {
  rawLabels: string[]
  evidence: FileEmergenceEvidence[]
  anchorPath?: string | null
  documentTitleHints?: DocumentTitleHint[]
}

export interface ProjectTitleResult {
  title: string
  titleSource: FileEmergenceProject['titleSource']
  confidenceHint: number
}

export interface DocumentTitleHint {
  title: string
  source: 'file_name' | 'frontmatter' | 'metadata' | 'ready_project' | 'tab_group' | 'task' | 'attachment'
  path?: string | null
}

export function normalizeProjectLabel(raw: string): NormalizedProjectLabel {
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[“”‘’]/g, '')
    .replace(/[~～]/g, ' ')
    .replace(/[|:：/\\()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(VERSION_SUFFIX_RE, '')
    .trim()

  const normalized = cleaned.toLowerCase()
  const tokens = normalized
    .split(/[\s,，。；;、-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !GENERIC_LABELS.has(token))

  return {
    raw,
    normalized,
    tokens,
    isGeneric: normalized.length <= 1 || GENERIC_LABELS.has(normalized),
  }
}

export function normalizeRealPathKey(path: string): string {
  return normalize(path).split(sep).filter(Boolean).join('/').toLowerCase()
}

export function directoryProjectKey(anchorPath: string): string {
  return `dir:${normalizeRealPathKey(anchorPath)}`
}

export function semanticProjectKey(title: string): string {
  return `semantic:${stableHash(normalizeProjectLabel(title).normalized)}`
}

export function documentProjectKey(path: string): string {
  return `doc:${normalizeRealPathKey(path)}`
}

export function stableHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

export function pathSegments(path: string): string[] {
  return normalize(path)
    .split(sep)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function chooseDirectoryAnchor(path: string, workspaceRoots: readonly string[]): string {
  const normalizedPath = normalize(path)
  const matchingRoot = workspaceRoots
    .map((root) => normalize(root))
    .filter((root) => normalizedPath === root || normalizedPath.startsWith(`${root}${sep}`))
    .sort((a, b) => b.length - a.length)[0]

  if (!matchingRoot) return dirname(normalizedPath)
  const rel = normalizedPath.slice(matchingRoot.length).split(sep).filter(Boolean)
  if (rel.length <= 1) return matchingRoot
  const directorySegments = rel.slice(0, -1)
  const specificIndex = directorySegments.findIndex((segment) => !isGenericDirectorySegment(segment))
  if (specificIndex >= 0) {
    return normalize([matchingRoot, ...directorySegments.slice(0, specificIndex + 1)].join(sep))
  }
  return normalize([matchingRoot, rel[0]].join(sep))
}

function isGenericDirectorySegment(segment: string): boolean {
  const normalized = normalizeProjectLabel(segment).normalized.replace(/\s+/g, '')
  if (!normalized) return true
  if (/^测试\d*$/i.test(normalized)) return true
  return /^(工作内容|资料|素材|临时|随便记|temp|tmp|test|tests|downloads?)$/i.test(normalized)
}

export function buildProjectTitle(input: ProjectTitleInput): ProjectTitleResult {
  const candidates: Array<{
    label: string
    source: FileEmergenceEvidenceSource | 'directory' | 'document_title' | 'raw_label'
    score: number
    supportRef?: string | null
    explicitSource?: DocumentTitleHint['source']
  }> = []

  if (input.anchorPath) {
    const anchorLabel = labelFromPath(input.anchorPath)
    candidates.push({
      label: anchorLabel,
      source: 'directory',
      score: normalizeProjectLabel(anchorLabel).isGeneric || isContainerLabel(anchorLabel) ? 0.55 : 1.15,
      supportRef: input.anchorPath,
    })
  }

  for (const hint of input.documentTitleHints || []) {
    candidates.push({
      label: hint.title,
      source: 'document_title',
      score: hint.source === 'ready_project' ? 3.2 :
        hint.source === 'tab_group' ? 2.8 :
          hint.source === 'task' ? 2.5 :
            hint.source === 'attachment' ? 2.2 :
              hint.source === 'frontmatter' ? 1.35 :
                hint.source === 'metadata' ? 1.25 : 1.05,
      supportRef: hint.path ?? null,
      explicitSource: hint.source,
    })
  }

  for (const evidence of input.evidence) {
    candidates.push({
      label: evidence.source === 'file_activity' ? stripLabelExtension(evidence.label) : evidence.label,
      source: evidence.source,
      score: evidence.score,
      supportRef: evidence.ref ?? null,
    })
  }

  for (const raw of input.rawLabels) {
    candidates.push({ label: raw, source: 'raw_label', score: 0.2 })
  }

  const aggregated = new Map<string, typeof candidates[number] & {
    normalized: NormalizedProjectLabel
    supportRefs: Set<string>
    sources: Set<string>
  }>()
  for (const candidate of candidates) {
    const normalized = normalizeProjectLabel(candidate.label)
    if (!normalized.normalized) continue
    const key = normalized.normalized
    const existing = aggregated.get(key)
    if (existing) {
      existing.score = Math.max(existing.score, candidate.score)
      existing.sources.add(candidate.explicitSource || candidate.source)
      if (candidate.supportRef) existing.supportRefs.add(candidate.supportRef)
      if (sourcePriority(candidate) > sourcePriority(existing)) {
        existing.label = candidate.label
        existing.source = candidate.source
        existing.explicitSource = candidate.explicitSource
      }
      continue
    }
    aggregated.set(key, {
      ...candidate,
      normalized,
      supportRefs: new Set(candidate.supportRef ? [candidate.supportRef] : []),
      sources: new Set([candidate.explicitSource || candidate.source]),
    })
  }

  const ranked = Array.from(aggregated.values())
    .map((candidate) => {
      const sourceBonus =
        candidate.explicitSource === 'ready_project' ? 2.5 :
          candidate.explicitSource === 'tab_group' ? 2.1 :
            candidate.explicitSource === 'task' ? 1.8 :
              candidate.explicitSource === 'attachment' ? 1.5 :
                candidate.source === 'calendar' ? 0.45 :
                  candidate.source === 'directory' ? 0.7 :
                candidate.source === 'document_title' ? 0.25 :
                  candidate.source === 'raw_label' ? 0 : 0.1
      const supportBonus = Math.min(1.8, candidate.supportRefs.size * 0.55 + candidate.sources.size * 0.25)
      const machinePenalty = isMachineProjectLabel(candidate.label) ? 10 : 0
      const singleLongPenalty = candidate.supportRefs.size <= 1 && candidate.label.length > 48 ? 5 : 0
      const containerPenalty = isContainerLabel(candidate.label) ? 2 : 0
      return {
        ...candidate,
        rank: candidate.score + sourceBonus + supportBonus - machinePenalty - singleLongPenalty - containerPenalty,
      }
    })
    .filter((candidate) => !isMachineProjectLabel(candidate.label))
    .filter((candidate) => candidate.label.length <= 48 || candidate.supportRefs.size >= 2 || candidate.explicitSource === 'ready_project')
    .sort((a, b) => b.rank - a.rank)

  const concrete = ranked.find((candidate) => !candidate.normalized.isGeneric)
  const genericDirectory = ranked.find((candidate) => candidate.source === 'directory')
  const selected = concrete || genericDirectory || ranked[0]
  if (!selected) {
    return { title: '未命名项目', titleSource: 'rule_refined', confidenceHint: 0 }
  }

  const directoryLabel = genericDirectory?.normalized.normalized || ''
  const shouldRefine =
    !selected.explicitSource &&
    selected.source !== 'directory' &&
    directoryLabel &&
    GENERIC_LABELS.has(directoryLabel)

  const title = selected.label.trim()
  return {
    title,
    titleSource: shouldRefine ? 'rule_refined' : toTitleSource(selected.source, selected.explicitSource),
    confidenceHint: selected.normalized.isGeneric ? 0.15 : Math.min(0.6, selected.rank / 3),
  }
}

export function isMachineProjectLabel(raw: string): boolean {
  const label = stripLabelExtension(raw).normalize('NFKC').trim()
  const compact = label.replace(/[\s_-]+/g, '')
  if (!compact) return true
  if (/^[0-9a-f]{20,}$/i.test(compact)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(label)) return true
  if (/^BV[0-9A-Za-z]{8,}(?:\b|[_-])/i.test(label)) return true
  if (/^\d{10,}$/.test(compact)) return true
  if (/^[0-9a-f]{12,}[-_](?:thumb|cover|image|img|frame|preview|\d+)$/i.test(label)) return true
  if (/^(?:img|image|frame|export|output|asset)[-_]?\d{3,}$/i.test(label)) return true
  return false
}

function sourcePriority(candidate: { source: string; explicitSource?: DocumentTitleHint['source'] }): number {
  if (candidate.explicitSource === 'ready_project') return 100
  if (candidate.explicitSource === 'tab_group') return 90
  if (candidate.explicitSource === 'task') return 80
  if (candidate.explicitSource === 'attachment') return 70
  if (candidate.source === 'directory') return 60
  if (candidate.source === 'raw_label') return 5
  if (candidate.explicitSource === 'frontmatter') return 55
  return 10
}

function labelFromPath(path: string): string {
  const name = basename(path)
  const ext = extname(name)
  if (!ext || ext.length > 8 || ext.length === name.length) return name
  return name.slice(0, -ext.length) || name
}

function isContainerLabel(label: string): boolean {
  const normalized = normalizeProjectLabel(label).normalized.replace(/\s+/g, '')
  if (!normalized) return true
  return /^(lib|src|docs?|documents?|notes?|资料库?)([-_][\p{L}\p{N}]+)?$/iu.test(normalized)
}

function stripLabelExtension(label: string): string {
  const ext = extname(label)
  if (!ext || ext.length > 9 || ext.length === label.length || /\s/.test(ext)) return label
  return label.slice(0, -ext.length) || label
}

function toTitleSource(
  source: FileEmergenceEvidenceSource | 'directory' | 'document_title' | 'raw_label',
  explicitSource?: DocumentTitleHint['source'],
): FileEmergenceProject['titleSource'] {
  if (explicitSource === 'ready_project') return 'frontmatter'
  if (explicitSource === 'tab_group' || explicitSource === 'task' || explicitSource === 'attachment') return explicitSource
  if (source === 'calendar' || source === 'agent' || source === 'browser_history' || source === 'directory') {
    return source
  }
  return 'rule_refined'
}

export function shouldMergeSemanticIntoDirectory(params: {
  semanticTitle: string
  directoryPath: string
  rawLabels: readonly string[]
  fileNames?: readonly string[]
}): boolean {
  const semantic = normalizeProjectLabel(params.semanticTitle)
  if (semantic.isGeneric) return false

  const haystack = [
    basename(params.directoryPath),
    dirname(params.directoryPath).split(sep).pop() || '',
    ...params.rawLabels,
    ...(params.fileNames || []),
  ]
    .map((label) => normalizeProjectLabel(label))
    .flatMap((label) => [label.normalized, ...label.tokens])
    .filter(Boolean)

  return semantic.tokens.some((token) => haystack.some((value) => value.includes(token) || token.includes(value)))
}
