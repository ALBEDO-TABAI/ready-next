import { readdir, stat } from 'fs/promises'
import { basename, isAbsolute, relative } from 'path'

import { fileKindFromPath } from './file-kind'
import type { FileEmergenceCandidate, SearchPort } from './types'
import type { FileEmergenceFileRef } from '../../../shared/file-emergence'

const MAX_FILES_PER_PROJECT = 3
const MAX_INTERNAL_FILES = 20
const MAX_SEMANTIC_SEARCH_QUERIES = 12
const GENERIC_SEMANTIC_TOKENS = new Set([
  '项目',
  '计划',
  '方案',
  '资料',
  '文件',
  '文档',
])

export interface LinkFilesResult {
  filesByCandidateId: Map<string, FileEmergenceFileRef[]>
  degraded: Array<{ source: string; reason: string }>
  searchQueryCount: number
}

export class FileLinker {
  private searchQueryCount = 0
  private readonly queryCache = new Map<string, Promise<FileEmergenceFileRef[]>>()

  constructor(private readonly searchEngine: SearchPort | null) {}

  async linkFiles(
    candidates: readonly FileEmergenceCandidate[],
    workspaceRoots: readonly string[],
  ): Promise<LinkFilesResult> {
    this.searchQueryCount = 0
    this.queryCache.clear()
    const degraded: Array<{ source: string; reason: string }> = []
    const filesByCandidateId = new Map<string, FileEmergenceFileRef[]>()

    for (const candidate of candidates) {
      const direct = await this.directFiles(candidate, workspaceRoots)
      let linked = direct
      if (candidate.anchorType === 'semantic' && linked.length < MAX_FILES_PER_PROJECT) {
        const searched = await this.searchFiles(candidate, workspaceRoots, degraded)
        linked = mergeFiles([...linked, ...searched])
      }
      filesByCandidateId.set(candidate.id, linked.slice(0, MAX_FILES_PER_PROJECT))
    }

    return {
      filesByCandidateId,
      degraded,
      searchQueryCount: this.searchQueryCount,
    }
  }

  private async directFiles(
    candidate: FileEmergenceCandidate,
    workspaceRoots: readonly string[],
  ): Promise<FileEmergenceFileRef[]> {
    const files = candidate.directFiles
      .filter((file) => isAllowedPath(file.path, workspaceRoots))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_INTERNAL_FILES)

    if (candidate.anchorType === 'directory' && candidate.anchorPath && files.length < MAX_FILES_PER_PROJECT) {
      const scanned = await scanDirectoryFiles(candidate.anchorPath, workspaceRoots)
      files.push(...scanned)
    }

    return mergeFiles(files).slice(0, MAX_INTERNAL_FILES)
  }

  private async searchFiles(
    candidate: FileEmergenceCandidate,
    workspaceRoots: readonly string[],
    degraded: Array<{ source: string; reason: string }>,
  ): Promise<FileEmergenceFileRef[]> {
    if (!this.searchEngine) return []
    const tokens = semanticSearchTokens(candidate.rawLabels)
    if (tokens.length === 0) return []
    const queries = candidate.rawLabels
      .map((label) => label.trim())
      .filter((label) => label.length >= 2)
      .slice(0, 2)
    const files: FileEmergenceFileRef[] = []

    for (const query of queries) {
      if (this.searchQueryCount >= MAX_SEMANTIC_SEARCH_QUERIES) break
      const cacheKey = `${workspaceRoots.join('\n')}\n${query}`
      let promise = this.queryCache.get(cacheKey)
      if (!promise) {
        this.searchQueryCount += 1
        promise = this.runSearch(query, workspaceRoots, degraded)
        this.queryCache.set(cacheKey, promise)
      }
      files.push(...(await promise).filter((file) => semanticFileNameMatches(file, tokens)))
    }
    return mergeFiles(files)
  }

  private async runSearch(
    query: string,
    workspaceRoots: readonly string[],
    degraded: Array<{ source: string; reason: string }>,
  ): Promise<FileEmergenceFileRef[]> {
    try {
      const result = await this.searchEngine!.search(query, {
        workspaceRoots: [...workspaceRoots],
        limit: MAX_INTERNAL_FILES,
        sources: ['document'],
      })
      if (result.degraded) {
        degraded.push({ source: 'search_index', reason: 'Search index is degraded' })
      }
      return result.items
        .filter((item) => isAllowedPath(item.path, workspaceRoots))
        .map((item, index) => ({
          path: item.path,
          name: item.name || basename(item.path),
          kind: fileKindFromPath(item.path),
          score: Math.max(0.1, 1 - index * 0.05),
          reason: '搜索索引匹配',
          modifiedAt: null,
        }))
    } catch (error) {
      degraded.push({
        source: 'search_index',
        reason: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }
}

async function scanDirectoryFiles(anchorPath: string, workspaceRoots: readonly string[]): Promise<FileEmergenceFileRef[]> {
  if (!isAllowedPath(anchorPath, workspaceRoots)) return []
  try {
    const entries = await readdir(anchorPath, { withFileTypes: true })
    const files: FileEmergenceFileRef[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = `${anchorPath}/${entry.name}`
      const info = await stat(path).catch(() => null)
      if (!info || info.isDirectory()) continue
      files.push({
        path,
        name: entry.name,
        kind: fileKindFromPath(path),
        score: 0.35,
        reason: '项目目录内文件',
        modifiedAt: info.mtimeMs,
      })
      if (files.length >= MAX_INTERNAL_FILES) break
    }
    return files.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
  } catch {
    return []
  }
}

function mergeFiles(files: readonly FileEmergenceFileRef[]): FileEmergenceFileRef[] {
  const byPath = new Map<string, FileEmergenceFileRef>()
  for (const file of files) {
    const existing = byPath.get(file.path)
    if (!existing || file.score > existing.score) byPath.set(file.path, file)
  }
  return Array.from(byPath.values()).sort((a, b) => b.score - a.score)
}

function isAllowedPath(path: string, workspaceRoots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false
  return workspaceRoots.some((root) => {
    const rel = relative(root, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

function semanticSearchTokens(labels: readonly string[]): string[] {
  const tokens = new Set<string>()
  for (const label of labels) {
    const normalized = normalizeTokenText(label)
    if (!normalized) continue
    for (const token of normalized.split(/\s+/)) {
      addSemanticToken(tokens, token)
    }
    const chineseRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) || []
    for (const run of chineseRuns) {
      addSemanticToken(tokens, run)
      for (const keyword of ['品牌', '空间', '案例', '复盘', '发布', '门店', '客户', '研究', '预算', '合同', '资产']) {
        if (run.includes(keyword)) addSemanticToken(tokens, keyword)
      }
    }
  }
  return Array.from(tokens)
}

function addSemanticToken(tokens: Set<string>, token: string): void {
  const cleaned = token.trim()
  if (cleaned.length < 2) return
  if (/^\d+$/.test(cleaned)) return
  if (GENERIC_SEMANTIC_TOKENS.has(cleaned)) return
  tokens.add(cleaned)
}

function semanticFileNameMatches(file: FileEmergenceFileRef, tokens: readonly string[]): boolean {
  const haystack = normalizeTokenText(`${file.name} ${file.path}`)
  return tokens.some((token) => haystack.includes(token))
}

function normalizeTokenText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
