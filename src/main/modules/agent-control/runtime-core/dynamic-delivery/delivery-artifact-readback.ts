import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { isValidProofRef } from '../../quality/proof-collector'
import type { RequestEnvelope } from '../../contracts/request-envelope'
import type {
  VerifierMechanicalIssue,
  VerifierResourceBundle,
  VerifierResourceItem,
} from './verifier-resource-bundle'

const MAX_FILES = 200
const MAX_DIRECTORY_DEPTH = 5
const MAX_EXCERPT_BYTES = 24_000
const FULL_TEXT_READ_LIMIT_BYTES = 2 * 1024 * 1024
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.csv',
  '.html',
  '.htm',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

function pathInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function artifactPathsFromRows(
  proofRefs: ReadonlyArray<unknown>,
  recentArtifacts: ReadonlyArray<unknown>,
  currentRunId?: string,
  runStartedAtMs?: number,
): string[] {
  const paths = new Set<string>()
  for (const row of proofRefs) {
    if (!isValidProofRef(row) || row.kind !== 'artifact') continue
    if (currentRunId && row.runId !== currentRunId) continue
    if (!currentRunId && runStartedAtMs && Date.parse(row.ts) < runStartedAtMs) continue
    if (isAbsolute(row.ref)) paths.add(row.ref)
  }
  for (const value of recentArtifacts) {
    const record = asRecord(value)
    const sourceRunId = typeof record?.sourceRunId === 'string' ? record.sourceRunId.trim() : ''
    const createdAtMs = typeof record?.createdAt === 'string' ? Date.parse(record.createdAt) : Number.NaN
    if (
      currentRunId
      && sourceRunId !== currentRunId
      && !(sourceRunId.length === 0 && runStartedAtMs && Number.isFinite(createdAtMs) && createdAtMs >= runStartedAtMs)
    ) continue
    if (!currentRunId && runStartedAtMs && (!Number.isFinite(createdAtMs) || createdAtMs < runStartedAtMs)) continue
    const path = typeof record?.path === 'string' ? record.path.trim() : ''
    if (path && isAbsolute(path)) paths.add(path)
  }
  return Array.from(paths)
}

function proofRefsForRun(
  proofRefs: ReadonlyArray<unknown>,
  currentRunId?: string,
  runStartedAtMs?: number,
): unknown[] {
  return proofRefs.filter((row) => {
    if (!isValidProofRef(row)) return false
    if (currentRunId) return row.runId === currentRunId
    return !runStartedAtMs || Date.parse(row.ts) >= runStartedAtMs
  })
}

function collectFiles(path: string, output: Set<string>, depth = 0): void {
  if (output.size >= MAX_FILES || depth > MAX_DIRECTORY_DEPTH || !existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return
  if (stat.isFile()) {
    output.add(canonicalPath(path))
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (output.size >= MAX_FILES) break
    if (entry.name === '.DS_Store' || entry.name.startsWith('.')) continue
    collectFiles(join(path, entry.name), output, depth + 1)
  }
}

function readPrefix(path: string, maxBytes = MAX_EXCERPT_BYTES): Buffer {
  const fd = openSync(path, 'r')
  try {
    const stat = statSync(path)
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size))
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytes)
  } finally {
    closeSync(fd)
  }
}

function isTextFile(path: string): boolean {
  if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return true
  const prefix = readPrefix(path, 4096)
  return prefix.length > 0 && !prefix.includes(0)
}

function fileDigest(path: string, size: number): string {
  if (size <= FULL_TEXT_READ_LIMIT_BYTES) {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return createHash('sha256')
    .update(readPrefix(path, MAX_EXCERPT_BYTES))
    .update(`:${size}`)
    .digest('hex')
}

function cleanMarkdownTarget(value: string): string | null {
  let target = String(value || '').trim()
  if (!target || /^(?:https?:|mailto:|data:|#)/i.test(target)) return null
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
  target = target.split(/\s+["']/)[0].split('#')[0].split('?')[0].trim()
  if (!target) return null
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

function markdownLocalTargets(content: string): string[] {
  const targets = new Set<string>()
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = cleanMarkdownTarget(match[1])
    if (target) targets.add(target)
  }
  return Array.from(targets)
}

function explicitOutputFolderNames(text: string): Set<string> {
  const names = new Set<string>()
  const pattern = /(?:输出到|保存到|存到|导出到|写到|写入到|落到|save\s+to|export\s+to|target\s+folder)\s*@\[([^\]]+)\]/gi
  for (const match of text.matchAll(pattern)) {
    const name = basename(String(match[1] || '').trim())
    if (name && name !== '.' && name !== '..') names.add(name)
  }
  return names
}

function explicitOutputRoots(userRequestVerbatim: string, requestEnvelope: unknown): string[] {
  if (!requestEnvelope || typeof requestEnvelope !== 'object' || Array.isArray(requestEnvelope)) return []
  const envelope = requestEnvelope as Partial<RequestEnvelope>
  if (!Array.isArray(envelope.resources)) return []
  const names = explicitOutputFolderNames(userRequestVerbatim)
  if (names.size === 0) return []
  const roots = new Set<string>()
  for (const resource of envelope.resources) {
    if (resource.kind !== 'folder_reference' || !resource.path) continue
    if (!names.has(basename(resource.name.trim()))) continue
    if (!existsSync(resource.path) || !statSync(resource.path).isDirectory()) continue
    roots.add(canonicalPath(resource.path))
  }
  return Array.from(roots)
}

function needsMultipleFiles(text: string): boolean {
  return /(?:多份|多个|若干份|分别).{0,16}(?:文件|文档)|(?:文件|文档).{0,12}(?:索引|index)/i.test(text)
}

function needsIndex(text: string): boolean {
  return /(?:索引|目录页|index)/i.test(text)
}

function materializeSourceReceipts(proofRefs: ReadonlyArray<unknown>): VerifierResourceItem[] {
  return proofRefs
    .filter(isValidProofRef)
    .flatMap((proof, proofIndex) => {
      const receipt = proof.sourceReceipt
      if (!receipt) return []
      return [{
        refId: `source-receipt-${proofIndex + 1}`,
        digest: receipt.contentDigest,
        provenance: `source_acquisition:${receipt.acquisitionTool}:${receipt.acquiredAt}`,
        excerpt: `${receipt.urls.join('\n')}\n\n${receipt.excerpt}`.slice(0, MAX_EXCERPT_BYTES),
        kind: 'resource' as const,
      }]
    })
}

function materializeProofMetadata(proofRefs: ReadonlyArray<unknown>): VerifierResourceItem[] {
  return proofRefs
    .filter(isValidProofRef)
    .flatMap((proof, proofIndex) => {
      if (proof.kind === 'artifact' || proof.sourceReceipt) return []
      return [{
        refId: `proof-${proofIndex + 1}`,
        digest: proof.digest,
        provenance: `proof_ref:${proof.kind}:${proof.ref}:${proof.ts}`,
        excerpt: JSON.stringify(proof).slice(0, 1600),
        kind: 'action_receipt' as const,
      }]
    })
}

function expectedOutputExists(expected: string, deliverableFiles: readonly string[]): boolean {
  const normalized = String(expected || '').trim().replace(/\\/g, '/')
  if (!normalized) return true
  const expectedPath = normalized.replace(/^file:\/\//i, '')
  if (isAbsolute(expectedPath)) {
    const canonicalExpected = canonicalPath(expectedPath)
    return deliverableFiles.some((file) => file === canonicalExpected || pathInsideRoot(file, canonicalExpected))
  }
  return deliverableFiles.some((file) => {
    const normalizedFile = file.replace(/\\/g, '/')
    return normalizedFile.endsWith(`/${expectedPath}`) || basename(normalizedFile) === basename(expectedPath)
  })
}

export function materializeDeliveryArtifacts(input: {
  proofRefs?: ReadonlyArray<unknown> | null
  recentArtifacts?: ReadonlyArray<unknown> | null
  expectedOutputs?: ReadonlyArray<string> | null
  userRequestVerbatim: string
  requestEnvelope?: unknown
  currentRunId?: string
  runStartedAtMs?: number
}): VerifierResourceBundle {
  const proofRefs = proofRefsForRun(
    input.proofRefs ?? [],
    input.currentRunId,
    input.runStartedAtMs,
  )
  const recentArtifacts = input.recentArtifacts ?? []
  const outputRoots = explicitOutputRoots(input.userRequestVerbatim, input.requestEnvelope)
  const declaredArtifactPaths = artifactPathsFromRows(
    proofRefs,
    recentArtifacts,
    input.currentRunId,
    input.runStartedAtMs,
  )
  const declaredArtifactRoots = new Set<string>()
  const discoveredFiles = new Set<string>()
  const issues: VerifierMechanicalIssue[] = []

  for (const declaredPath of declaredArtifactPaths) {
    if (!existsSync(declaredPath)) {
      issues.push({
        code: 'artifact_missing',
        description: `产物不存在：${declaredPath}`,
        targetRefId: declaredPath,
      })
      continue
    }
    if (lstatSync(declaredPath).isSymbolicLink()) {
      issues.push({
        code: 'artifact_symlink_rejected',
        description: `产物是符号链接，未读取：${declaredPath}`,
        targetRefId: declaredPath,
      })
      continue
    }
    declaredArtifactRoots.add(canonicalPath(declaredPath))
    collectFiles(declaredPath, discoveredFiles)
  }
  for (const root of outputRoots) collectFiles(root, discoveredFiles)

  const artifactItemsByPath = new Map<string, VerifierResourceItem>()
  const textByPath = new Map<string, string>()
  for (const path of discoveredFiles) {
    const stat = statSync(path)
    if (!stat.isFile()) continue
    if (stat.size === 0) {
      issues.push({
        code: 'artifact_empty',
        description: `产物为空文件：${path}`,
        targetRefId: path,
      })
      continue
    }
    if (!isTextFile(path)) continue
    const content = stat.size <= FULL_TEXT_READ_LIMIT_BYTES
      ? readFileSync(path, 'utf-8')
      : readPrefix(path).toString('utf-8')
    textByPath.set(path, content)
    artifactItemsByPath.set(path, {
      refId: path,
      digest: fileDigest(path, stat.size),
      provenance: `artifact_readback:${path}:${stat.size}`,
      excerpt: content.slice(0, MAX_EXCERPT_BYTES),
      kind: 'artifact',
    })
  }

  const allTextFiles = Array.from(textByPath.keys())
  const provenTextFiles = allTextFiles.filter((path) =>
    Array.from(declaredArtifactRoots).some((root) => pathInsideRoot(path, root)),
  )
  const deliverableFiles = outputRoots.length > 0
    ? provenTextFiles.filter((path) => outputRoots.some((root) => pathInsideRoot(path, root)))
    : provenTextFiles
  const artifactItems = deliverableFiles
    .map((path) => artifactItemsByPath.get(path))
    .filter((item): item is VerifierResourceItem => Boolean(item))

  for (const root of outputRoots) {
    if (!deliverableFiles.some((path) => pathInsideRoot(path, root))) {
      issues.push({
        code: 'output_target_empty',
        description: `用户指定的目标文件夹没有可验收文件：${root}`,
        targetRefId: root,
      })
    }
  }

  if (needsMultipleFiles(input.userRequestVerbatim) && deliverableFiles.length < 2) {
    issues.push({
      code: 'artifact_bundle_incomplete',
      description: `用户要求多份文件，实际只读回 ${deliverableFiles.length} 份。`,
    })
  }

  for (const expected of input.expectedOutputs ?? []) {
    if (!expectedOutputExists(expected, deliverableFiles)) {
      issues.push({
        code: 'expected_output_missing',
        description: `已声明的交付项未找到：${expected}`,
        targetRefId: expected,
      })
    }
  }

  if (needsIndex(input.userRequestVerbatim)) {
    const indexFiles = deliverableFiles.filter((path) => /(?:index|索引|readme)/i.test(basename(path)))
    const deliverableFileSet = new Set(deliverableFiles)
    const linkedDeliverables = new Set<string>()
    if (indexFiles.length === 0) {
      issues.push({
        code: 'index_missing',
        description: '用户要求索引，但目标文件夹中没有索引文件。',
      })
    }
    for (const indexPath of indexFiles) {
      const targets = markdownLocalTargets(textByPath.get(indexPath) || '')
      if (targets.length === 0) {
        issues.push({
          code: 'index_has_no_local_links',
          description: `索引没有可点击的本地文件链接：${indexPath}`,
          targetRefId: indexPath,
        })
        continue
      }
      for (const target of targets) {
        const resolvedTarget = resolve(dirname(indexPath), target)
        if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isFile()) {
          issues.push({
            code: 'index_link_missing',
            description: `索引链接指向不存在的文件：${indexPath} -> ${target}`,
            targetRefId: indexPath,
          })
          continue
        }
        const canonicalTarget = canonicalPath(resolvedTarget)
        if (!deliverableFileSet.has(canonicalTarget)) {
          issues.push({
            code: 'index_link_unproven',
            description: `索引链接不是本轮已证明的交付文件：${indexPath} -> ${target}`,
            targetRefId: indexPath,
          })
          continue
        }
        linkedDeliverables.add(canonicalTarget)
      }
    }
    const unlinkedDeliverables = deliverableFiles.filter((path) =>
      !indexFiles.includes(path) && !linkedDeliverables.has(path),
    )
    if (indexFiles.length > 0 && unlinkedDeliverables.length > 0) {
      issues.push({
        code: 'index_coverage_incomplete',
        description: `索引未覆盖 ${unlinkedDeliverables.length} 份本轮交付文件。`,
      })
    }
  }

  return {
    version: 1,
    items: [
      ...artifactItems,
      ...materializeSourceReceipts(proofRefs),
      ...materializeProofMetadata(proofRefs),
    ],
    mechanicalIssues: issues,
  }
}
