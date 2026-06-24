import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../../agent-control/tools-runtime/tool-result-types'
import { logAgentMetric } from '../../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../../agent-control/tools-runtime/tool-error-metrics'
import { ToolDomainError } from '../tool-errors'
import { PathSandboxError, resolveWithinRoot } from './path-sandbox'
import { defaultLookupSkillRoots, type LookupSkillRoots } from './root-resolver'

export interface ExportArtifactArgs {
  relativePath: string
  targetPath: string
  overwrite?: boolean
}

export interface ExportArtifactHandlerDeps {
  skillId: string
  lookupSkillRoots?: LookupSkillRoots
  allowedExportRoots?: string[] | null
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const rel = relative(rootPath, targetPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function authorizedRoots(allowedRoots: string[] | null | undefined): string[] {
  return Array.isArray(allowedRoots)
    ? allowedRoots.map((root) => resolve(String(root || '').trim())).filter(Boolean)
    : []
}

function assertWritableTargetPath(value: unknown, allowedRoots: string[] | null | undefined): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolDomainError('invalid_target_path', 'targetPath must be a non-empty absolute path.')
  }
  const targetPath = resolve(value.trim())
  if (!isAbsolute(targetPath)) {
    throw new ToolDomainError('invalid_target_path', 'targetPath must be absolute.', { targetPath: value })
  }
  const roots = authorizedRoots(allowedRoots)
  if (roots.length === 0 || !roots.some((root) => isPathInsideRoot(targetPath, root))) {
    throw new ToolDomainError('target_outside_workspace', 'targetPath must be inside an authorized workspace root.', { targetPath })
  }
  return targetPath
}

function deepestExistingAncestor(path: string): string {
  let current = path
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function assertTargetParentInsideAuthorizedRoot(targetPath: string, allowedRoots: string[] | null | undefined): string {
  const roots = authorizedRoots(allowedRoots)
  const parentPath = dirname(targetPath)
  const realRoots = roots.map((root) => realpathSync(root))
  const ancestor = deepestExistingAncestor(parentPath)
  const realAncestor = realpathSync(ancestor)
  const projectedParentPath = join(realAncestor, relative(ancestor, parentPath))
  if (!realRoots.some((root) => isPathInsideRoot(projectedParentPath, root))) {
    throw new ToolDomainError('target_outside_workspace', 'targetPath parent must resolve inside an authorized workspace root.', { targetPath, realParentPath: projectedParentPath })
  }

  mkdirSync(parentPath, { recursive: true })
  const realParentPath = realpathSync(parentPath)
  const realTargetPath = join(realParentPath, basename(targetPath))
  if (!realRoots.some((root) => isPathInsideRoot(realTargetPath, root))) {
    throw new ToolDomainError('target_outside_workspace', 'targetPath parent must resolve inside an authorized workspace root.', { targetPath, realParentPath })
  }
  return realTargetPath
}

function copyArtifactToTarget(sourcePath: string, targetPath: string, overwrite: boolean): void {
  if (!overwrite) {
    copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL)
    return
  }

  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    copyFileSync(sourcePath, tempPath, constants.COPYFILE_EXCL)
    renameSync(tempPath, targetPath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

export async function executeExportArtifact(
  args: ExportArtifactArgs,
  deps: ExportArtifactHandlerDeps,
): Promise<ToolExecutionOutput> {
  const lookup = deps.lookupSkillRoots || defaultLookupSkillRoots
  const roots = lookup(deps.skillId)
  if (!roots) {
    logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
      primitive: 'skill_export_artifact',
      reason: 'missing_skill',
      skillId: deps.skillId || null,
    })
    throw new ToolDomainError('missing_skill', `Skill "${deps.skillId}" is not registered; cannot resolve artifact root.`, { skillId: deps.skillId || null })
  }

  let sourcePath: string
  let targetPath: string
  try {
    sourcePath = resolveWithinRoot(roots.artifactRoot, args.relativePath)
    targetPath = assertWritableTargetPath(args.targetPath, deps.allowedExportRoots)
  } catch (error) {
    if (error instanceof PathSandboxError) {
      logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveRejected, {
        primitive: 'skill_export_artifact',
        reason: error.reason,
        relativePath: args.relativePath,
      })
      throw new ToolDomainError(error.reason, error.message, { relativePath: args.relativePath, artifactRoot: roots.artifactRoot })
    }
    throw error
  }

  if (!existsSync(sourcePath)) {
    throw new ToolDomainError('artifact_missing', `Artifact not found: ${args.relativePath}`, { relativePath: args.relativePath, sourcePath })
  }
  if (lstatSync(sourcePath).isSymbolicLink()) {
    throw new ToolDomainError('symlink_rejected', `Refusing to export symlink artifact: ${args.relativePath}`, { relativePath: args.relativePath, sourcePath })
  }
  if (!statSync(sourcePath).isFile()) {
    throw new ToolDomainError('artifact_missing', `Artifact is not a file: ${args.relativePath}`, { relativePath: args.relativePath, sourcePath })
  }
  targetPath = assertTargetParentInsideAuthorizedRoot(targetPath, deps.allowedExportRoots)
  if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
    throw new ToolDomainError('symlink_rejected', `Refusing to overwrite symlink: ${targetPath}`, { targetPath })
  }

  try {
    copyArtifactToTarget(sourcePath, targetPath, args.overwrite === true)
  } catch (error) {
    if (!args.overwrite && typeof error === 'object' && error && 'code' in error && (error as { code?: unknown }).code === 'EEXIST') {
      throw new ToolDomainError('target_exists', 'targetPath already exists; pass overwrite=true to replace it.', { targetPath })
    }
    throw error
  }
  const bytes = statSync(targetPath).size

  logAgentMetric(TOOL_ERROR_METRICS.skillPrimitiveUsed, {
    primitive: 'skill_export_artifact',
    skillId: roots.skillId,
    bytes,
  })

  return createToolExecutionOutput(
    `Exported ${sourcePath} to ${targetPath}`,
    {
      shape: 'json',
      data: {
        absolutePath: targetPath,
        sourcePath,
        targetPath,
        artifactRoot: roots.artifactRoot,
        bytesWritten: bytes,
      },
    },
  )
}
