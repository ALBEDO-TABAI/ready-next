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
  source: 'file_name' | 'frontmatter' | 'metadata'
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
    source: FileEmergenceEvidenceSource | 'directory' | 'document_title'
    score: number
  }> = []

  if (input.anchorPath) {
    const anchorLabel = labelFromPath(input.anchorPath)
    candidates.push({
      label: anchorLabel,
      source: 'directory',
      score: normalizeProjectLabel(anchorLabel).isGeneric || isContainerLabel(anchorLabel) ? 0.55 : 1.15,
    })
  }

  for (const hint of input.documentTitleHints || []) {
    candidates.push({
      label: hint.title,
      source: 'document_title',
      score: hint.source === 'file_name' ? 1.18 : 1.12,
    })
  }

  for (const evidence of input.evidence) {
    candidates.push({
      label: evidence.source === 'file_activity' ? stripLabelExtension(evidence.label) : evidence.label,
      source: evidence.source,
      score: evidence.score,
    })
  }

  for (const raw of input.rawLabels) {
    candidates.push({ label: raw, source: 'directory', score: 0.2 })
  }

  const ranked = candidates
    .map((candidate) => {
      const normalized = normalizeProjectLabel(candidate.label)
      const specificity = normalized.isGeneric ? 0 : Math.min(1, candidate.label.length / 18)
      const sourceBonus =
        candidate.source === 'calendar' ? 0.18 :
          candidate.source === 'agent' ? 0.14 :
            candidate.source === 'browser_history' ? 0.1 :
              candidate.source === 'directory' ? 0.08 :
                candidate.source === 'document_title' ? 0.09 : 0.04
      return { ...candidate, normalized, rank: candidate.score + specificity + sourceBonus }
    })
    .filter((candidate) => candidate.normalized.normalized.length > 0)
    .sort((a, b) => b.rank - a.rank)

  const concrete = ranked.find((candidate) => !candidate.normalized.isGeneric)
  const genericDirectory = ranked.find((candidate) => candidate.source === 'directory')
  const selected = concrete || genericDirectory || ranked[0]
  if (!selected) {
    return { title: '未命名项目', titleSource: 'rule_refined', confidenceHint: 0 }
  }

  const directoryLabel = genericDirectory?.normalized.normalized || ''
  const shouldRefine =
    selected.source !== 'directory' &&
    directoryLabel &&
    GENERIC_LABELS.has(directoryLabel)

  const title = selected.label.trim()
  return {
    title,
    titleSource: shouldRefine ? 'rule_refined' : toTitleSource(selected.source),
    confidenceHint: selected.normalized.isGeneric ? 0.15 : Math.min(0.6, selected.rank / 3),
  }
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

function toTitleSource(source: FileEmergenceEvidenceSource | 'directory' | 'document_title'): FileEmergenceProject['titleSource'] {
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
